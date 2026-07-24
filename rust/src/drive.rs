// Shared extraction driver — port of src/extract/drive.ts: manifest +
// selected configurations/packages into the data dir, reusing the
// fingerprint-keyed cache.

use crate::cache::{
    apply_extracted, apply_extracted_package, cache_key_of, extract_and_persist,
    extract_and_persist_package, reconcile,
};
use crate::manifest::{ManifestOptions, build_manifest};
use crate::run_nix::check_nix;
use crate::schema::{Manifest, RefStatus};
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
    check_nix().await?;
    std::fs::create_dir_all(Path::new(&flags.out).join("config"))?;
    std::fs::create_dir_all(Path::new(&flags.out).join("package"))?;

    println!("extracting manifest of {flake_ref} ...");
    let mut manifest = build_manifest(
        flake_ref,
        &ManifestOptions {
            all_systems: flags.all_systems,
            timeout: flags.timeout,
        },
    )
    .await?;
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
    reconcile(&flags.out, &mut manifest);
    let cache_key = cache_key_of(&manifest);

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

    for id in &wanted {
        let r#ref = manifest
            .configurations
            .iter()
            .find(|c| &c.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such configuration: {id}"))?;
        if r#ref.status == RefStatus::Ok {
            println!("options of {id} cached (flake + extractor unchanged), skipping");
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

    for id in &wanted_packages {
        let r#ref = manifest
            .packages
            .iter()
            .find(|p| &p.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no such package: {id}"))?;
        if r#ref.status == RefStatus::Ok {
            println!("package {id} cached (flake + extractor unchanged), skipping");
            continue;
        }
        println!("extracting package {id} ...");
        match extract_and_persist_package(&flags.out, flake_ref, &cache_key, &r#ref, flags.timeout)
            .await
        {
            Ok(r) => {
                if let Some(cur) = manifest.packages.iter_mut().find(|p| &p.id == id) {
                    apply_extracted_package(cur, &r);
                }
                manifest.warnings.extend(r.result.warnings.clone());
                println!(
                    "  builder={} in {:.1}s",
                    r.result.data.builder.as_str(),
                    r.result.duration_ms as f64 / 1000.0
                );
                for w in &r.result.warnings {
                    eprintln!("  warn: {w}");
                }
            }
            Err(e) => {
                let msg = e.to_string().lines().next().unwrap_or("error").to_string();
                if let Some(cur) = manifest.packages.iter_mut().find(|p| &p.id == id) {
                    cur.status = RefStatus::Error;
                    cur.error = Some(msg.clone());
                }
                eprintln!("  error: {msg}");
            }
        }
    }

    let manifest_path = Path::new(&flags.out).join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string(&manifest)?)?;
    println!("wrote {}", manifest_path.display());

    Ok(DriveResult {
        manifest,
        wanted,
        wanted_packages,
    })
}
