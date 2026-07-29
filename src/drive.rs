// Shared extraction driver: manifest +
// selected configurations/packages into the data dir, reusing the
// fingerprint-keyed cache.

use crate::cache::{
    apply_extracted, apply_extracted_graph, apply_extracted_package, cache_key_of,
    extract_and_persist, extract_and_persist_graph, extract_and_persist_package, reconcile,
};
use crate::manifest::{ManifestOptions, build_manifest};
use crate::run_nix::check_nix;
use crate::schema::{ConfigRef, GraphRef, Manifest, PackageRef, RefStatus};
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
    /// Dependency graphs — never implied by --all (see main.rs).
    pub graphs: Selection,
    /// Opt-in: expose configuration graphs (a ~10 s toplevel eval each).
    pub config_graphs: bool,
    /// Opt-in: the T3 dry-run tier — a second full eval per graph, and its
    /// stderr is prose, so it degrades rather than fails.
    pub graph_dry_run: bool,
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
    pub wanted_graphs: Vec<String>,
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
    std::fs::create_dir_all(Path::new(&flags.out).join("graph"))?;

    println!("extracting manifest of {flake_ref} ...");
    let t_manifest = timings.mark();
    let mut manifest = build_manifest(
        flake_ref,
        &ManifestOptions {
            all_systems: flags.all_systems,
            timeout: flags.timeout,
            config_graphs: flags.config_graphs,
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
    let wanted_graphs: Vec<String> = match &flags.graphs {
        Selection::All => manifest.graphs.iter().map(|g| g.id.clone()).collect(),
        Selection::Ids(ids) => {
            for g in ids {
                if !g.contains('/') {
                    anyhow::bail!("--graphs takes path/segment ids, got: {g}");
                }
            }
            ids.clone()
        }
        Selection::None => Vec::new(),
    };

    // Resolve and reconcile everything before extracting any of it. Two things
    // hang on that ordering: an unknown id stays the up-front error it was
    // rather than one arbitrary task failing mid-flight, and the "cached,
    // skipping" lines all print in the order the user asked for, above the
    // reordered completion lines instead of mixed into them.
    let t_units = timings.mark();
    let mut pending_configs: Vec<ConfigRef> = Vec::new();
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
        pending_configs.push(r#ref);
    }
    let mut pending_packages: Vec<PackageRef> = Vec::new();
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
        pending_packages.push(r#ref);
    }

    let mut pending_graphs: Vec<GraphRef> = Vec::new();
    for id in &wanted_graphs {
        let t_graph = timings.mark();
        let r#ref = manifest
            .graphs
            .iter()
            .find(|g| &g.id == id)
            .cloned()
            .ok_or_else(|| {
                if manifest.configurations.iter().any(|c| &c.id == id) {
                    anyhow::anyhow!(
                        "graph of configuration {id} needs --config-graphs \
                         (instantiates system.build.toplevel, ~10s of eval per configuration)"
                    )
                } else {
                    anyhow::anyhow!("no such graph target: {id}")
                }
            })?;
        if r#ref.status == RefStatus::Ok {
            println!("graph of {id} cached (flake + extractor + nix unchanged), skipping");
            timings.item("graph", id, t_graph);
            continue;
        }
        pending_graphs.push(r#ref);
    }

    let console = Arc::new(Console::new(
        &pending_configs,
        &pending_packages,
        &pending_graphs,
    ));

    // Configurations and packages as ONE set of futures rather than two passes.
    // Against a real flake nearly all the wall clock is the option walk of the
    // largest configuration; the small configurations and every package are
    // work with no dependency on it that used to queue up behind it. How many
    // of these are inside `nix` at any instant remains run_nix's gate to
    // decide, so there is no pool to size here and no way for this to fork more
    // evals than the machine was already going to run.
    let cache_key = &cache_key;
    let timings = &timings;
    let config_futs = pending_configs.iter().map(|r#ref| {
        let console = console.clone();
        async move {
            // Marked inside the future, not around the loop: a span taken where
            // units are QUEUED would time the queue rather than the unit.
            let t_config = timings.mark();
            let done = extract_and_persist(
                &flags.out,
                flake_ref,
                cache_key,
                r#ref,
                flags.timeout,
                Some(console.progress_for(&r#ref.id)),
            )
            .await;
            match &done {
                Ok(r) => {
                    let customized = r
                        .result
                        .data
                        .options
                        .iter()
                        .filter(|o| o.customized)
                        .count();
                    console.finished(
                        &r#ref.id,
                        format!(
                            "  {}: {} options ({customized} customized) in {:.1}s",
                            r#ref.id,
                            r.result.data.options.len(),
                            r.result.duration_ms as f64 / 1000.0
                        ),
                        &r.result.warnings,
                    );
                }
                Err(e) => console.failed(&r#ref.id, e),
            }
            timings.item("options", &r#ref.id, t_config);
            (t_config, timings.mark(), done)
        }
    });
    let package_futs = pending_packages.iter().map(|r#ref| {
        let console = console.clone();
        async move {
            let t_package = timings.mark();
            let done =
                extract_and_persist_package(&flags.out, flake_ref, cache_key, r#ref, flags.timeout)
                    .await;
            match &done {
                Ok(r) => console.finished(
                    &r#ref.id,
                    format!(
                        "  {}: builder={} in {:.1}s",
                        r#ref.id,
                        r.result.data.builder.as_str(),
                        r.result.duration_ms as f64 / 1000.0
                    ),
                    &r.result.warnings,
                ),
                Err(e) => console.failed(&r#ref.id, e),
            }
            timings.item("package", &r#ref.id, t_package);
            (t_package, timings.mark(), done)
        }
    });
    let graph_futs = pending_graphs.iter().map(|r#ref| {
        let console = console.clone();
        async move {
            let t_graph = timings.mark();
            let done = extract_and_persist_graph(
                &flags.out,
                flake_ref,
                cache_key,
                r#ref,
                flags.graph_dry_run,
                flags.timeout,
            )
            .await;
            match &done {
                Ok(r) => console.finished(
                    &r#ref.id,
                    format!(
                        "  graph of {}: {} nodes, {} edges in {:.1}s",
                        r#ref.id,
                        r.result.data.stats.node_count,
                        r.result.data.stats.edge_count,
                        r.result.duration_ms as f64 / 1000.0
                    ),
                    &r.result.warnings,
                ),
                Err(e) => console.failed(&r#ref.id, e),
            }
            timings.item("graph", &r#ref.id, t_graph);
            (t_graph, timings.mark(), done)
        }
    });
    let (extracted_configs, extracted_packages, extracted_graphs) = futures::future::join3(
        futures::future::join_all(config_futs),
        futures::future::join_all(package_futs),
        futures::future::join_all(graph_futs),
    )
    .await;
    console.close();

    // "options" and "packages" survive as labels, but they are now WINDOWS —
    // first unit of that kind to start, last to finish — rather than brackets
    // around a loop that owned the machine for its duration. The two overlap
    // each other and both overlap "units", so they no longer sum to it; read
    // them as "how long was any package in flight", which is the question a
    // baseline comparison against the serial passes is actually asking.
    let window = |label: &str, spans: &[(std::time::Instant, std::time::Instant)]| {
        if let (Some(first), Some(last)) = (
            spans.iter().map(|s| s.0).min(),
            spans.iter().map(|s| s.1).max(),
        ) {
            timings.window(label, first, last);
        }
    };
    let (config_spans, extracted_configs): (Vec<_>, Vec<_>) = extracted_configs
        .into_iter()
        .map(|(a, b, done)| ((a, b), done))
        .unzip();
    let (package_spans, extracted_packages): (Vec<_>, Vec<_>) = extracted_packages
        .into_iter()
        .map(|(a, b, done)| ((a, b), done))
        .unzip();
    let (graph_spans, extracted_graphs): (Vec<_>, Vec<_>) = extracted_graphs
        .into_iter()
        .map(|(a, b, done)| ((a, b), done))
        .unzip();
    window("options", &config_spans);
    window("packages", &package_spans);
    window("graphs", &graph_spans);
    if !pending_configs.is_empty() || !pending_packages.is_empty() || !pending_graphs.is_empty() {
        timings.phase("units", t_units);
    }

    // Completion order is scheduling; `pending_*` is the order the user asked
    // for. Fold the outcomes back in the latter, or which unit finished first
    // would decide the order of manifest.json's warnings array, and the same
    // flake on the same machine would serialize differently run to run.
    for (r#ref, done) in pending_configs.iter().zip(extracted_configs) {
        let Some(cur) = manifest
            .configurations
            .iter_mut()
            .find(|c| c.id == r#ref.id)
        else {
            continue;
        };
        match done {
            Ok(r) => {
                apply_extracted(cur, &r);
                manifest.warnings.extend(r.result.warnings.clone());
            }
            Err(e) => {
                cur.status = RefStatus::Error;
                cur.error = Some(first_line(&e));
            }
        }
    }
    for (r#ref, done) in pending_packages.iter().zip(extracted_packages) {
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
                cur.error = Some(first_line(&e));
            }
        }
    }

    for (r#ref, done) in pending_graphs.iter().zip(extracted_graphs) {
        let Some(cur) = manifest.graphs.iter_mut().find(|g| g.id == r#ref.id) else {
            continue;
        };
        match done {
            Ok(r) => {
                apply_extracted_graph(cur, &r);
                manifest.warnings.extend(r.result.warnings.clone());
            }
            Err(e) => {
                cur.status = RefStatus::Error;
                cur.error = Some(first_line(&e));
            }
        }
    }

    let manifest_path = Path::new(&flags.out).join("manifest.json");
    std::fs::write(&manifest_path, serde_json::to_string(&manifest)?)?;
    println!("wrote {}", manifest_path.display());
    timings.total();

    Ok(DriveResult {
        manifest,
        wanted,
        wanted_packages,
        wanted_graphs,
    })
}

fn first_line(e: &anyhow::Error) -> String {
    e.to_string().lines().next().unwrap_or("error").to_string()
}

/// The one thing allowed to write to the terminal while the unit pass runs.
///
/// The pass is now a set of futures that finish in whatever order `nix` lets
/// them, and the option walk reports progress from inside several of them at
/// once. Two writers and a carriage return between them is how you get a line
/// with half of one configuration's counter and half of another's, so every
/// write goes through this mutex, and only whole lines are ever written under
/// it. Nothing here awaits, so the lock is never held across a yield.
///
/// The status line is redrawn in place with `\r`; a completion line has to
/// erase it first, or the tail of a longer status line survives to the right of
/// a shorter finished one.
struct Console {
    state: std::sync::Mutex<ConsoleState>,
}

struct ConsoleState {
    units_done: usize,
    units_total: usize,
    /// done/total option chunks per STILL-RUNNING configuration. A finished one
    /// drops out: a frozen "3/3 chunks" next to a counter that is still moving
    /// reads as stuck, and the units column is already the whole-pass measure.
    chunks: std::collections::HashMap<String, (usize, usize)>,
    current: String,
    current_owner: String,
    /// Width of the status line currently on screen, 0 when there is none.
    drawn: usize,
}

impl Console {
    fn new(configs: &[ConfigRef], packages: &[PackageRef], graphs: &[GraphRef]) -> Console {
        let total = configs.len() + packages.len() + graphs.len();
        match (configs, packages, graphs) {
            ([], [], []) => {}
            ([one], [], []) => println!("extracting options of {} ...", one.id),
            ([], [one], []) => println!("extracting package {} ...", one.id),
            ([], [], [one]) => println!("extracting graph of {} ...", one.id),
            _ => println!(
                "extracting {} ...",
                [
                    (configs.len(), "configuration"),
                    (packages.len(), "package"),
                    (graphs.len(), "graph"),
                ]
                .into_iter()
                .filter(|(n, _)| *n > 0)
                .map(|(n, noun)| format!("{n} {noun}{}", if n == 1 { "" } else { "s" }))
                .collect::<Vec<_>>()
                .join(" and ")
            ),
        }
        Console {
            state: std::sync::Mutex::new(ConsoleState {
                units_done: 0,
                units_total: total,
                chunks: std::collections::HashMap::new(),
                current: String::new(),
                current_owner: String::new(),
                drawn: 0,
            }),
        }
    }

    /// A progress sink for one configuration's option walk.
    fn progress_for(self: &Arc<Self>, id: &str) -> crate::options::ProgressFn {
        let console = self.clone();
        let id = id.to_string();
        Arc::new(move |p: crate::options::OptionsProgress| {
            let mut s = console.state.lock().unwrap();
            s.chunks.insert(id.clone(), (p.done, p.total));
            // With several configurations walking at once, the bare option path
            // does not say whose it is.
            s.current = if s.units_total == 1 {
                p.current.chars().take(40).collect()
            } else {
                format!("{id}: {}", p.current).chars().take(40).collect()
            };
            s.current_owner = id.clone();
            s.draw();
        })
    }

    fn finished(&self, id: &str, line: String, warnings: &[String]) {
        let mut s = self.state.lock().unwrap();
        s.retire(id);
        s.erase();
        println!("{line}");
        for w in warnings {
            eprintln!("  warn: {w}");
        }
        s.draw();
    }

    fn failed(&self, id: &str, e: &anyhow::Error) {
        let mut s = self.state.lock().unwrap();
        s.retire(id);
        s.erase();
        eprintln!("  error: {id}: {}", first_line(e));
        s.draw();
    }

    fn close(&self) {
        self.state.lock().unwrap().erase();
    }
}

impl ConsoleState {
    /// One unit settled — drop whatever it was still reporting.
    fn retire(&mut self, id: &str) {
        self.units_done += 1;
        self.chunks.remove(id);
        if self.current_owner == id {
            self.current.clear();
            self.current_owner.clear();
        }
    }

    fn erase(&mut self) {
        if self.drawn > 0 {
            print!("\r{:width$}\r", "", width = self.drawn);
            self.drawn = 0;
        }
    }

    fn draw(&mut self) {
        if self.units_done >= self.units_total {
            self.erase();
            return;
        }
        let (done, total) = self
            .chunks
            .values()
            .fold((0, 0), |(d, t), (cd, ct)| (d + cd, t + ct));
        // A single unit gets the plain counter it had before this was ever
        // concurrent; the units column only earns its width once there is more
        // than one thing to count.
        let line = if self.units_total == 1 {
            format!("  {done}/{total} {:<40}", self.current)
        } else if self.chunks.is_empty() {
            // Only packages left in flight, and they report nothing until they
            // settle — a chunk counter here would just be a frozen 0/0.
            format!("  {}/{} done", self.units_done, self.units_total)
        } else {
            format!(
                "  {}/{} done  {done}/{total} chunks  {:<40}",
                self.units_done, self.units_total, self.current
            )
        };
        print!("\r{line}");
        std::io::stdout().flush().ok();
        self.drawn = line.chars().count();
    }
}
