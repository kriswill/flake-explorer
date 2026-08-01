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
use std::fmt::Write as _;
use std::process::ExitCode;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

struct Event {
    ms: u128,
    done: usize,
    total: usize,
    current: String,
}

/// A CLI mistake gets the usage line; a runtime failure just gets its message.
enum Fail {
    Usage(String),
    Plain(String),
}

fn usage(msg: impl Into<String>) -> Fail {
    Fail::Usage(msg.into())
}

fn main() -> ExitCode {
    let Err(fail) = run() else {
        return ExitCode::SUCCESS;
    };
    let (msg, show_usage) = match fail {
        Fail::Usage(m) => (m, true),
        Fail::Plain(m) => (m, false),
    };
    eprintln!("options-probe: {msg}");
    if show_usage {
        eprintln!(
            "usage: options-probe <flakeref> <kind/name> [--jobs N] [--jsonl FILE] [--timeout SECS]"
        );
    }
    ExitCode::FAILURE
}

fn run() -> Result<(), Fail> {
    let mut args = std::env::args().skip(1);
    let mut positional: Vec<String> = Vec::new();
    let mut jobs: Option<usize> = None;
    let mut jsonl: Option<String> = None;
    let mut timeout = Duration::from_mins(30);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--jobs" => {
                jobs = Some(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .ok_or_else(|| usage("--jobs expects a positive integer"))?,
                );
            }
            "--jsonl" => {
                jsonl = Some(args.next().ok_or_else(|| usage("--jsonl expects a path"))?);
            }
            "--timeout" => {
                timeout = Duration::from_secs(
                    args.next()
                        .and_then(|v| v.parse().ok())
                        .ok_or_else(|| usage("--timeout expects seconds"))?,
                );
            }
            a if a.starts_with("--") => return Err(usage(format!("unknown flag: {a}"))),
            _ => positional.push(a),
        }
    }
    let [flake_ref, id] = positional.as_slice() else {
        return Err(usage("expected <flakeref> and <kind/name>"));
    };
    let Some((kind, name)) = id.split_once('/') else {
        return Err(usage("<kind/name> looks like nixos/nebula"));
    };
    let kind = match kind {
        "nixos" => ConfigKind::Nixos,
        "darwin" => ConfigKind::Darwin,
        k => return Err(usage(format!("unknown kind: {k}"))),
    };

    let events: Arc<Mutex<Vec<Event>>> = Arc::new(Mutex::new(Vec::new()));
    let started = Instant::now();
    let sink = Arc::clone(&events);
    let on_progress: flake_explorer::options::ProgressFn = Arc::new(move |p: OptionsProgress| {
        sink.lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Event {
                ms: started.elapsed().as_millis(),
                done: p.done,
                total: p.total,
                current: p.current,
            });
    });

    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| Fail::Plain(format!("failed to start tokio runtime: {e}")))?;
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

    let result = result.map_err(|e| Fail::Plain(e.to_string()))?;

    // Take the events out rather than holding the lock across the write and
    // the summary below; the workers holding the other Arc are gone by now.
    let events = std::mem::take(&mut *events.lock().unwrap_or_else(PoisonError::into_inner));
    if let Some(path) = jsonl {
        let mut body = String::new();
        for e in &events {
            // write! into a String cannot fail, and Value's Display emits the
            // same compact escaping to_string did.
            let _ = writeln!(
                body,
                "{{\"ms\":{},\"done\":{},\"total\":{},\"current\":{}}}",
                e.ms,
                e.done,
                e.total,
                serde_json::Value::from(e.current.as_str())
            );
        }
        std::fs::write(&path, body)
            .map_err(|e| Fail::Plain(format!("cannot write {path}: {e}")))?;
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
    Ok(())
}
