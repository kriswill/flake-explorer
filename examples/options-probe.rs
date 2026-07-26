// Measurement scaffolding for the options pass — an example, not a shipped
// feature. It calls `extract_options` directly so two things the CLI cannot do
// become possible: setting the worker count per run (the CLI takes the
// available_parallelism-derived default, and plumbing a flag for it would mean
// editing flake-explorer-extract and invalidating every user's cached blobs),
// and timestamping every chunk completion.
//
// The cache is bypassed entirely: no sidecar is read or written, so every run
// is a cold options pass by construction.
//
//   cargo run --release --example options-probe -- <flakeref> nixos/<name> \
//     --jobs 8 --jsonl chunks-8.jsonl
//
// stdout is one JSON summary object. --jsonl writes one object per chunk
// completion: {ms, done, total, current}, where `ms` is the wall clock from the
// start of the pass and `current` is the namespace chunk that just finished. At
// --jobs 1 the gaps between consecutive `ms` values ARE the per-chunk
// durations; above that they are a completion timeline, since up to `jobs`
// chunks are in flight at once.

use flake_explorer::options::{ExtractOptionsOpts, OptionsProgress, extract_options};
use flake_explorer::schema::ConfigKind;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Event {
    ms: u128,
    done: usize,
    total: usize,
    current: String,
}

fn die(msg: &str) -> ! {
    eprintln!("options-probe: {msg}");
    eprintln!(
        "usage: options-probe <flakeref> <kind/name> [--jobs N] [--jsonl FILE] [--timeout SECS]"
    );
    std::process::exit(1)
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let mut positional: Vec<String> = Vec::new();
    let mut jobs: Option<usize> = None;
    let mut jsonl: Option<String> = None;
    let mut timeout = Duration::from_secs(1800);
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--jobs" => {
                i += 1;
                jobs = Some(
                    argv.get(i)
                        .and_then(|v| v.parse().ok())
                        .unwrap_or_else(|| die("--jobs expects a positive integer")),
                );
            }
            "--jsonl" => {
                i += 1;
                jsonl = Some(
                    argv.get(i)
                        .cloned()
                        .unwrap_or_else(|| die("--jsonl expects a path")),
                );
            }
            "--timeout" => {
                i += 1;
                timeout = Duration::from_secs(
                    argv.get(i)
                        .and_then(|v| v.parse().ok())
                        .unwrap_or_else(|| die("--timeout expects seconds")),
                );
            }
            a if a.starts_with("--") => die(&format!("unknown flag: {a}")),
            a => positional.push(a.to_string()),
        }
        i += 1;
    }
    let [flake_ref, id] = positional.as_slice() else {
        die("expected <flakeref> and <kind/name>")
    };
    let Some((kind, name)) = id.split_once('/') else {
        die("<kind/name> looks like nixos/nebula")
    };
    let kind = match kind {
        "nixos" => ConfigKind::Nixos,
        "darwin" => ConfigKind::Darwin,
        k => die(&format!("unknown kind: {k}")),
    };

    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let started = Instant::now();
    let sink = events.clone();
    let on_progress: flake_explorer::options::ProgressFn = Arc::new(move |p: OptionsProgress| {
        sink.lock().unwrap().push(Event {
            ms: started.elapsed().as_millis(),
            done: p.done,
            total: p.total,
            current: p.current,
        });
    });

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let result = rt.block_on(extract_options(
        flake_ref,
        kind,
        name,
        ExtractOptionsOpts {
            timeout,
            concurrency: jobs,
            skip_invisible: true,
            on_progress: Some(on_progress),
            // A probe measures the cold walk on purpose: starting from a
            // remembered split would hide the discovery cost it exists to time.
            hint: None,
        },
    ));
    let wall_ms = started.elapsed().as_millis();

    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("options-probe: {e}");
            std::process::exit(1)
        }
    };

    let events = events.lock().unwrap();
    if let Some(path) = jsonl {
        let body: String = events
            .iter()
            .map(|e| {
                format!(
                    "{{\"ms\":{},\"done\":{},\"total\":{},\"current\":{}}}\n",
                    e.ms,
                    e.done,
                    e.total,
                    serde_json::to_string(&e.current).unwrap()
                )
            })
            .collect();
        std::fs::write(&path, body).unwrap_or_else(|e| die(&format!("cannot write {path}: {e}")));
    }

    println!(
        "{}",
        serde_json::json!({
            "flakeRef": flake_ref,
            "config": id,
            "jobs": jobs,
            "wallMs": wall_ms,
            "durationMs": result.duration_ms,
            "chunks": events.len(),
            "options": result.data.options.len(),
            "customized": result.data.options.iter().filter(|o| o.customized).count(),
            "warnings": result.warnings.len(),
        })
    );
}
