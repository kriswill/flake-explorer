// Shared extraction driver: manifest +
// selected configurations/packages into the data dir, reusing the
// fingerprint-keyed cache.

use crate::cache::{
    apply_extracted, apply_extracted_package, cache_key_of, extract_and_persist,
    extract_and_persist_package, reconcile,
};
use crate::manifest::{ManifestOptions, build_manifest};
use crate::run_nix::check_nix;
use crate::schema::{Manifest, PackageRef, RefStatus};
use crate::timing::Timings;
use std::io::Write;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub struct DriveFlags {
    pub out: String,
    /// None = none requested; Some(None) = --all; Some(Some(ids)) = explicit.
    pub configs: Selection,
    pub packages: Selection,
    pub all_systems: bool,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub enum Selection {
    #[default]
    None,
    All,
    Ids(Vec<String>),
}

pub struct DriveResult {
    pub manifest: Manifest,
    pub wanted: Vec<String>,
    pub wanted_packages: Vec<String>,
}

pub async fn extract_to_dir(flake_ref: &str, flags: &DriveFlags) -> anyhow::Result<DriveResult> {
    // Silent unless FLAKE_EXPLORER_TIMINGS asks otherwise, and stderr-only
    // when it does, so nothing below changes what the run prints (timing.rs).
    let timings = Timings::from_env();
    // The version is part of the cache key, not just a floor check — a nix
    // upgrade can change what extraction produces (see cache.rs::CacheKey).
    let nix_version = check_nix().await?;
    std::fs::create_dir_all(Path::new(&flags.out).join("config"))?;
    std::fs::create_dir_all(Path::new(&flags.out).join("package"))?;

    println!("extracting manifest of {flake_ref} ...");
    let t_manifest = timings.mark();
    let mut manifest = build_manifest(
        flake_ref,
        &ManifestOptions {
            all_systems: flags.all_systems,
            timeout: flags.timeout,
        },
    )
    .await?;
    timings.phase("manifest", t_manifest);
    println!(
        "  {} files, {} inputs, {} configurations, {} packages",
        manifest.files.len(),
        manifest.inputs.len(),
        manifest.configurations.len(),
        manifest.packages.len()
    );
    for w in &manifest.warnings {
        eprintln!("  warn: {w}");
    }
    let t_reconcile = timings.mark();
    reconcile(&flags.out, &mut manifest, &nix_version);
    timings.phase("reconcile", t_reconcile);
    let cache_key = cache_key_of(&manifest, &nix_version);

    let wanted: Vec<String> = match &flags.configs {
        Selection::All => manifest
            .configurations
            .iter()
            .map(|c| c.id.clone())
            .collect(),
        Selection::Ids(ids) => {
            for c in ids {
                if !c.contains('/') {
                    anyhow::bail!("--configs takes kind/name ids, got: {c}");
                }
            }
            ids.clone()
        }
        Selection::None => Vec::new(),
    };

    // The pass is timed as a whole and per configuration, cache hits included:
    // a warm run's shape — how much of the pass was skipping — is as much of a
    // benchmark question as a cold one's.
    let t_options = timings.mark();
    for id in &wanted {
        let t_config = timings.mark();
        let r#ref = manifest
            .configurations
            .iter()
            .find(|c| &c.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such configuration: {id}"))?;
        if r#ref.status == RefStatus::Ok {
            println!("options of {id} cached (flake + extractor + nix unchanged), skipping");
            timings.item("options", id, t_config);
            continue;
        }
        println!("extracting options of {id} ...");
        let progress: crate::options::ProgressFn =
            Arc::new(|p: crate::options::OptionsProgress| {
                let current: String = p.current.chars().take(40).collect();
                print!("\r  {}/{} {:<40}", p.done, p.total, current);
                std::io::stdout().flush().ok();
            });
        match extract_and_persist(
            &flags.out,
            flake_ref,
            &cache_key,
            &r#ref,
            flags.timeout,
            Some(progress),
        )
        .await
        {
            Ok(r) => {
                println!();
                if let Some(cur) = manifest.configurations.iter_mut().find(|c| &c.id == id) {
                    apply_extracted(cur, &r);
                }
                manifest.warnings.extend(r.result.warnings.clone());
                let customized = r
                    .result
                    .data
                    .options
                    .iter()
                    .filter(|o| o.customized)
                    .count();
                println!(
                    "  {} options ({customized} customized) in {:.1}s",
                    r.result.data.options.len(),
                    r.result.duration_ms as f64 / 1000.0
                );
                for w in &r.result.warnings {
                    eprintln!("  warn: {w}");
                }
            }
            Err(e) => {
                println!();
                let msg = e.to_string().lines().next().unwrap_or("error").to_string();
                if let Some(cur) = manifest.configurations.iter_mut().find(|c| &c.id == id) {
                    cur.status = RefStatus::Error;
                    cur.error = Some(msg.clone());
                }
                eprintln!("  error: {msg}");
            }
        }
        timings.item("options", id, t_config);
    }
    if !wanted.is_empty() {
        timings.phase("options", t_options);
    }

    let wanted_packages: Vec<String> = match &flags.packages {
        Selection::All => manifest.packages.iter().map(|p| p.id.clone()).collect(),
        Selection::Ids(ids) => {
            for p in ids {
                if !p.contains('/') {
                    anyhow::bail!("--packages takes path/segment ids, got: {p}");
                }
            }
            ids.clone()
        }
        Selection::None => Vec::new(),
    };

    let t_packages = timings.mark();
    // Resolve every requested package before extracting any of them, so an
    // unknown id is still the same up-front error it was when this loop ran one
    // at a time rather than one arbitrary task failing mid-flight.
    let mut pending: Vec<PackageRef> = Vec::new();
    for id in &wanted_packages {
        let t_package = timings.mark();
        let r#ref = manifest
            .packages
            .iter()
            .find(|p| &p.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such package: {id}"))?;
        if r#ref.status == RefStatus::Ok {
            println!("package {id} cached (flake + extractor + nix unchanged), skipping");
            timings.item("package", id, t_package);
            continue;
        }
        pending.push(r#ref);
    }

    if !pending.is_empty() {
        println!("extracting {} packages ...", pending.len());
    }
    // One future per package, all polled together. How many of them are inside
    // `nix` at any instant is run_nix's gate to decide, not this loop's — which
    // is why there is no pool here to size. Each future prints its own outcome
    // when it settles, and nothing between the two print calls below awaits, so
    // the lines cannot interleave with a sibling's.
    let cache_key = &cache_key;
    let timings = &timings;
    let extracted = futures::future::join_all(pending.iter().map(|r#ref| async move {
        // Marked inside the future rather than around the loop: with the
        // packages overlapping, a span taken where they are QUEUED would time
        // the queue, not the package.
        let t_package = timings.mark();
        let done =
            extract_and_persist_package(&flags.out, flake_ref, cache_key, r#ref, flags.timeout)
                .await;
        match &done {
            Ok(r) => {
                println!(
                    "  {}: builder={} in {:.1}s",
                    r#ref.id,
                    r.result.data.builder.as_str(),
                    r.result.duration_ms as f64 / 1000.0
                );
                for w in &r.result.warnings {
                    eprintln!("  warn: {w}");
                }
            }
            Err(e) => eprintln!(
                "  error: {}: {}",
                r#ref.id,
                e.to_string().lines().next().unwrap_or("error")
            ),
        }
        timings.item("package", &r#ref.id, t_package);
        done
    }))
    .await;

    // Completion order is scheduling; `pending` is the order the user asked
    // for. Fold the results back in the latter, or which package finished first
    // would decide the order of manifest.json's warnings array and the same
    // flake would serialize differently run to run.
    for (r#ref, done) in pending.iter().zip(extracted) {
        let Some(cur) = manifest.packages.iter_mut().find(|p| p.id == r#ref.id) else {
            continue;
        };
        match done {
            Ok(r) => {
                apply_extracted_package(cur, &r);
                manifest.warnings.extend(r.result.warnings.clone());
            }
            Err(e) => {
                cur.status = RefStatus::Error;
                cur.error = Some(e.to_string().lines().next().unwrap_or("error").to_string());
            }
        }
    }
    if !wanted_packages.is_empty() {
        timings.phase("packages", t_packages);
    }

    let manifest_path = Path::new(&flags.out).join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string(&manifest)?)?;
    println!("wrote {}", manifest_path.display());
    timings.total();

    Ok(DriveResult {
        manifest,
        wanted,
        wanted_packages,
    })
}
