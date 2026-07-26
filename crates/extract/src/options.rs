// Expensive per-configuration extraction:
// the options tree, walked in chunks so an uncatchable eval error degrades
// instead of killing the whole configuration. Split first, degrade last.

use crate::run_nix::{
    ChunkSpec, ExtractArgs, OptionsBatchEval, OptionsEval, RawOption, ValueEnvelope, eval_extract,
};
use crate::schema::*;
use indexmap::IndexMap;
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub struct OptionsResult {
    pub data: ConfigData,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct OptionsProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

pub type ProgressFn = Arc<dyn Fn(OptionsProgress) + Send + Sync>;

struct Rung {
    with_values: bool,
    with_descriptions: bool,
    note: &'static str,
}

const LADDER: [Rung; 3] = [
    Rung {
        with_values: true,
        with_descriptions: true,
        note: "",
    },
    Rung {
        with_values: false,
        with_descriptions: true,
        note: "values skipped",
    },
    Rung {
        with_values: false,
        with_descriptions: false,
        note: "values+descriptions skipped",
    },
];

/// Below this depth a failing chunk is abandoned instead of split further.
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone)]
struct Chunk {
    path: Vec<String>,
    children: Option<Vec<String>>,
    rung: usize,
}

/// The option path a chunk speaks for: its own path, plus the single child once
/// it has been narrowed to one. Doubles as the sort key for anything the walk
/// reports about that chunk.
fn chunk_key(c: &Chunk) -> Vec<String> {
    match &c.children {
        Some(ch) if ch.len() == 1 => {
            let mut p = c.path.clone();
            p.push(ch[0].clone());
            p
        }
        _ => c.path.clone(),
    }
}

fn chunk_label(c: &Chunk) -> String {
    chunk_key(c).join(".")
}

/// A warning plus the option path it is about — the key it gets sorted by, so
/// the array is a function of the flake rather than of the pool.
type KeyedWarning = (Vec<String>, String);

/// Most chunks a single `nix` process is asked to evaluate.
///
/// Reaching any option costs the flake + module-system fixpoint first — ~580ms
/// against a real configuration, of which 18ms is nix's own startup — and
/// nothing memoizes it across processes: an identical eval repeated costs the
/// same every time, in this `--expr` shape and in the installable shape nix's
/// eval cache is built for, on a clean flake. So the only way to stop paying it
/// per chunk is to stop making a process per chunk.
///
/// Bounded rather than unbounded because a batch is also the blast radius of an
/// uncatchable error and the unit of load balancing: one enormous batch would
/// re-split its way back down on the first poisoned option, and would leave
/// workers idle at the tail.
const BATCH_MAX: usize = 8;

/// Group the pending chunks into batches.
///
/// The sort is not cosmetic. Chunks arrive back on the queue as failures split
/// them, so queue ORDER carries scheduling; sorting makes a batch a function of
/// WHICH chunks are pending and nothing else. The outcome would be stable
/// either way — a poisoned batch splits until each chunk is evaluated alone, so
/// no chunk's final result depends on its batch-mates — but reproducible
/// batching also makes a slow run reproducible, which is what makes it
/// debuggable.
///
/// Batches stay at one rung: the detail level is a property of the eval, not of
/// a chunk inside it, so mixing rungs would force the whole batch down to the
/// most degraded member's level.
///
/// Sized to leave roughly three batches per worker rather than one: chunks vary
/// by an order of magnitude in cost, and a worker holding one huge batch while
/// its neighbours idle is how you turn a parallel pass back into a serial one.
/// With fewer chunks than that, batches of one fall out naturally — and are
/// correct, since work that already fits the pool concurrently has nothing to
/// gain from sharing a process.
fn plan_batches(mut pending: Vec<Chunk>, workers: usize) -> VecDeque<Vec<Chunk>> {
    pending.sort_by(|a, b| {
        a.rung
            .cmp(&b.rung)
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.children.cmp(&b.children))
    });
    let per = pending
        .len()
        .div_ceil(workers.saturating_mul(3).max(1))
        .clamp(1, BATCH_MAX);
    let mut out: VecDeque<Vec<Chunk>> = VecDeque::new();
    let mut cur: Vec<Chunk> = Vec::new();
    for c in pending {
        if !cur.is_empty() && (cur[0].rung != c.rung || cur.len() >= per) {
            out.push_back(std::mem::take(&mut cur));
        }
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push_back(cur);
    }
    out
}

struct Shared {
    /// Chunks discovered mid-round (splits, rung escalations). Re-planned into
    /// batches at the start of the next round rather than run one at a time, so
    /// the failure path amortizes its fixpoints too — which is where most of
    /// the evals are on a configuration with a poisoned namespace.
    queue: Mutex<VecDeque<Chunk>>,
    batches: Mutex<VecDeque<Vec<Chunk>>>,
    results: Mutex<Vec<RawOption>>,
    warnings: Mutex<Vec<KeyedWarning>>,
    done: std::sync::atomic::AtomicUsize,
    in_flight: std::sync::atomic::AtomicUsize,
}

pub struct ExtractOptionsOpts {
    pub timeout: Duration,
    pub concurrency: Option<usize>,
    pub skip_invisible: bool,
    pub on_progress: Option<ProgressFn>,
}

impl Default for ExtractOptionsOpts {
    fn default() -> Self {
        ExtractOptionsOpts {
            timeout: Duration::from_secs(600),
            concurrency: None,
            skip_invisible: true,
            on_progress: None,
        }
    }
}

pub async fn extract_options(
    flake_ref: &str,
    kind: ConfigKind,
    name: &str,
    opts: ExtractOptionsOpts,
) -> anyhow::Result<OptionsResult> {
    let t0 = Instant::now();
    // One worker per slot in the shared nix gate: more would only queue there,
    // and the sizing itself now lives next to the gate that enforces it.
    let concurrency = opts.concurrency.unwrap_or_else(crate::run_nix::nix_jobs);
    let label = format!("{}/{}", kind.as_str(), name);

    let namespaces: Vec<String> = eval_extract(
        &ExtractArgs {
            flake_ref: flake_ref.to_string(),
            mode: "optionNames",
            kind: Some(kind.as_str()),
            name: Some(name.to_string()),
            ..Default::default()
        },
        opts.timeout,
    )
    .await?;

    let shared = Arc::new(Shared {
        queue: Mutex::new(
            namespaces
                .into_iter()
                .map(|n| Chunk {
                    path: vec![n],
                    children: None,
                    rung: 0,
                })
                .collect(),
        ),
        batches: Mutex::new(VecDeque::new()),
        results: Mutex::new(Vec::new()),
        warnings: Mutex::new(Vec::new()),
        done: std::sync::atomic::AtomicUsize::new(0),
        in_flight: std::sync::atomic::AtomicUsize::new(0),
    });

    // Each round plans the whole pending set into batches and drains them;
    // whatever the round discovers (splits, rung escalations) is planned by the
    // next one. Workers exit when the batch queue is empty even though a
    // sibling may still be splitting, so the outer loop runs until nothing is
    // pending anywhere.
    loop {
        {
            let pending: Vec<Chunk> = shared.queue.lock().await.drain(..).collect();
            if pending.is_empty() {
                break;
            }
            *shared.batches.lock().await = plan_batches(pending, concurrency);
        }
        let mut handles = Vec::new();
        for _ in 0..concurrency {
            let shared = shared.clone();
            let flake_ref = flake_ref.to_string();
            let name = name.to_string();
            let label = label.clone();
            let timeout = opts.timeout;
            let skip_invisible = opts.skip_invisible;
            let on_progress = opts.on_progress.clone();
            handles.push(tokio::spawn(async move {
                worker(
                    &shared,
                    &flake_ref,
                    kind,
                    &name,
                    &label,
                    timeout,
                    skip_invisible,
                    on_progress,
                )
                .await;
            }));
        }
        for h in handles {
            h.await.ok();
        }
    }

    let mut results = std::mem::take(&mut *shared.results.lock().await);

    // Sort by the option path the warning is about, for the same reason the
    // options themselves are sorted below: a chunk's warning is appended when
    // that chunk COMPLETES, so without this the array is in pool-scheduling
    // order. That was measurable before extraction became concurrent — two runs
    // against a real 15k-option configuration differ in this array and in
    // nothing else, in both the manifest and the blob's sidecar — and it is the
    // last thing making a persisted artifact a function of the machine rather
    // than of the flake.
    //
    // The path is a total order on real data and groups a namespace's warnings
    // together, which is also the order a reader wants. The message breaks ties
    // so that two warnings about one path cannot swap.
    let mut keyed = std::mem::take(&mut *shared.warnings.lock().await);
    keyed.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let mut warnings: Vec<String> = keyed.into_iter().map(|(_, w)| w).collect();
    // Dedup preserving order, like `[...new Set(warnings)]`.
    let mut seen = HashSet::new();
    warnings.retain(|w| seen.insert(w.clone()));

    // Sort by loc so a blob is a function of (code, flake) and nothing else.
    // Workers above extend `results` as their chunks COMPLETE, and the worker
    // count comes from available_parallelism(), so without this the option order
    // — and, since build_file_index walks this vector, the fileIndex key order
    // and every defines/declares index in it — varied between runs on one
    // machine and varied systematically between a 4-core and a 16-core one. Ten
    // runs against fixtures/mini-flake on a 10-core host produced five distinct
    // blob hashes. Two costs came out of that: the same flake cached different
    // bytes depending on the machine that extracted it, and no test could tell a
    // real regression from scheduling jitter, which is what tests/determinism.rs
    // now relies on.
    //
    // loc is the option's path and therefore its identity, so it is a total
    // order on real data rather than a convenient one. Nothing consumes the
    // array order as meaning: the client reaches options through fileIndex and
    // its own loc->index map, and sorts by loc itself where display order
    // matters. Sorting before to_entry rather than after keeps build_file_index
    // below reading the vector it will actually be indexing.
    //
    // This does not make the SIDECAR byte-stable: it carries extractedAt and
    // durationMs, which are timing. Everything in it that is CONTENT now is,
    // though — the warning order this comment used to except is sorted above.
    results.sort_by(|a, b| a.loc.cmp(&b.loc));

    let options: Vec<OptionEntry> = results.into_iter().map(to_entry).collect();
    let file_index = build_file_index(&options);
    let data = ConfigData {
        version: SCHEMA_VERSION,
        id: format!("{}/{}", kind.as_str(), name),
        options,
        file_index,
    };
    Ok(OptionsResult {
        data,
        warnings,
        duration_ms: t0.elapsed().as_millis() as u64,
    })
}

#[allow(clippy::too_many_arguments)]
async fn worker(
    shared: &Shared,
    flake_ref: &str,
    kind: ConfigKind,
    name: &str,
    label: &str,
    timeout: Duration,
    skip_invisible: bool,
    on_progress: Option<ProgressFn>,
) {
    use std::sync::atomic::Ordering;
    loop {
        let batch = { shared.batches.lock().await.pop_front() };
        let Some(batch) = batch else { return };
        let n = batch.len();
        // Progress counts CHUNKS, not batches — the caller's totals mean the
        // same thing they meant before batching existed.
        shared.in_flight.fetch_add(n, Ordering::SeqCst);
        let current = chunk_label(&batch[0]);
        run_batch(
            shared,
            flake_ref,
            kind,
            name,
            label,
            timeout,
            skip_invisible,
            batch,
        )
        .await;
        shared.in_flight.fetch_sub(n, Ordering::SeqCst);
        let done = shared.done.fetch_add(n, Ordering::SeqCst) + n;
        if let Some(cb) = &on_progress {
            let queued: usize = shared.batches.lock().await.iter().map(Vec::len).sum();
            let total = done
                + queued
                + shared.queue.lock().await.len()
                + shared.in_flight.load(Ordering::SeqCst);
            cb(OptionsProgress {
                done,
                total,
                current,
            });
        }
    }
}

/// One `nix` process for a whole batch.
///
/// A batch of one is not a batch: it goes down the single-chunk path unchanged,
/// which is what keeps the rung ladder and its blast-radius argument exactly as
/// they were. Everything above that is the same discipline one level up — a
/// batch that dies SPLITS rather than degrading, because the alternative is
/// letting one poisoned option cost its batch-mates their values.
#[allow(clippy::too_many_arguments)]
async fn run_batch(
    shared: &Shared,
    flake_ref: &str,
    kind: ConfigKind,
    name: &str,
    label: &str,
    timeout: Duration,
    skip_invisible: bool,
    batch: Vec<Chunk>,
) {
    if batch.len() == 1 {
        let chunk = batch.into_iter().next().unwrap();
        run_chunk(
            shared,
            flake_ref,
            kind,
            name,
            label,
            timeout,
            skip_invisible,
            chunk,
        )
        .await;
        return;
    }

    let rung = &LADDER[batch[0].rung];
    let attempt: Result<OptionsBatchEval, _> = eval_extract(
        &ExtractArgs {
            flake_ref: flake_ref.to_string(),
            mode: "optionsBatch",
            kind: Some(kind.as_str()),
            name: Some(name.to_string()),
            chunks: Some(
                batch
                    .iter()
                    .map(|c| ChunkSpec {
                        path: c.path.clone(),
                        child_names: c.children.clone(),
                    })
                    .collect(),
            ),
            skip_invisible: Some(skip_invisible),
            with_values: Some(rung.with_values),
            with_descriptions: Some(rung.with_descriptions),
            ..Default::default()
        },
        timeout,
    )
    .await;

    match attempt {
        Ok(r) if r.results.len() == batch.len() => {
            let mut results = shared.results.lock().await;
            let mut warnings = shared.warnings.lock().await;
            for (chunk, got) in batch.iter().zip(r.results) {
                if !rung.note.is_empty() {
                    warnings.push((
                        chunk_key(chunk),
                        format!(
                            "{label} options.{}: {} (eval error at full detail)",
                            chunk_label(chunk),
                            rung.note
                        ),
                    ));
                }
                results.extend(got.options);
            }
        }
        // Either the eval died, or it came back a shape that cannot be
        // attributed chunk-to-chunk. Both mean this batch taught us nothing
        // about any individual chunk, so split it and ask smaller questions —
        // never degrade, which would charge the healthy members for one bad one.
        _ => {
            let mid = batch.len().div_ceil(2);
            let mut q = shared.batches.lock().await;
            let mut batch = batch;
            let tail = batch.split_off(mid);
            q.push_front(tail);
            q.push_front(batch);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_chunk(
    shared: &Shared,
    flake_ref: &str,
    kind: ConfigKind,
    name: &str,
    label: &str,
    timeout: Duration,
    skip_invisible: bool,
    chunk: Chunk,
) {
    let rung = &LADDER[chunk.rung];
    let attempt: Result<OptionsEval, _> = eval_extract(
        &ExtractArgs {
            flake_ref: flake_ref.to_string(),
            mode: "options",
            kind: Some(kind.as_str()),
            name: Some(name.to_string()),
            path: Some(chunk.path.clone()),
            child_names: chunk.children.clone(),
            skip_invisible: Some(skip_invisible),
            with_values: Some(rung.with_values),
            with_descriptions: Some(rung.with_descriptions),
            ..Default::default()
        },
        timeout,
    )
    .await;

    let last_err = match attempt {
        Ok(r) => {
            if !rung.note.is_empty() {
                shared.warnings.lock().await.push((
                    chunk_key(&chunk),
                    format!(
                        "{label} options.{}: {} (eval error at full detail)",
                        chunk_label(&chunk),
                        rung.note
                    ),
                ));
            }
            shared.results.lock().await.extend(r.options);
            return;
        }
        Err(e) => e.to_string(),
    };

    // Failed. Prefer splitting at the same detail level to isolate the bad
    // option; healthy siblings keep full detail.
    if let Some(children) = &chunk.children
        && children.len() > 1
    {
        let mid = children.len().div_ceil(2);
        let mut q = shared.queue.lock().await;
        q.push_back(Chunk {
            children: Some(children[..mid].to_vec()),
            ..chunk.clone()
        });
        q.push_back(Chunk {
            children: Some(children[mid..].to_vec()),
            ..chunk
        });
        return;
    }
    // Single child descends a level; a bare namespace splits by its children.
    let deeper: Vec<String> = match &chunk.children {
        Some(children) => {
            let mut p = chunk.path.clone();
            p.push(children[0].clone());
            p
        }
        None => chunk.path.clone(),
    };
    if deeper.len() < MAX_DEPTH {
        let kids: Result<Vec<String>, _> = eval_extract(
            &ExtractArgs {
                flake_ref: flake_ref.to_string(),
                mode: "optionNames",
                kind: Some(kind.as_str()),
                name: Some(name.to_string()),
                path: Some(deeper.clone()),
                ..Default::default()
            },
            timeout,
        )
        .await;
        if let Ok(kids) = kids
            && !kids.is_empty()
        {
            shared.queue.lock().await.push_back(Chunk {
                path: deeper,
                children: Some(kids),
                rung: chunk.rung,
            });
            return;
        }
        // unlistable — fall through to rung escalation
    }
    // Unsplittable: walk down the ladder, then give up.
    if chunk.rung + 1 < LADDER.len() {
        shared.queue.lock().await.push_back(Chunk {
            rung: chunk.rung + 1,
            ..chunk
        });
        return;
    }
    shared.warnings.lock().await.push((
        deeper.clone(),
        format!(
            "{label} options.{}: extraction failed — {}",
            deeper.join("."),
            err_line(&last_err)
        ),
    ));
}

/// Last substantive `error: <msg>` line — nix prefixes traces with bare
/// "error:" lines.
pub fn err_line(s: &str) -> String {
    let errs: Vec<&str> = s
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with("error:") && l.len() > "error:".len())
        .collect();
    errs.last()
        .copied()
        .or_else(|| s.trim().lines().next())
        .unwrap_or("unknown error")
        .to_string()
}

/// "path, via option foo.bar" -> (path, Some("foo.bar")); plain paths pass through.
pub fn split_via(file: &str) -> (String, Option<String>) {
    match file.find(", via option ") {
        None => (file.to_string(), None),
        Some(i) => (
            file[..i].to_string(),
            Some(file[i + ", via option ".len()..].to_string()),
        ),
    }
}

pub struct Unwrapped {
    pub value: Option<Value>,
    pub value_error: bool,
    pub value_skipped: bool,
    pub value_names: Option<Vec<String>>,
}

pub fn unwrap(v: &ValueEnvelope) -> Unwrapped {
    let mut out = Unwrapped {
        value: None,
        value_error: false,
        value_skipped: false,
        value_names: None,
    };
    let Some(Value::Object(o)) = v else {
        return out;
    };
    if let Some(ok) = o.get("ok") {
        out.value = Some(ok.clone());
    } else if o.contains_key("err") {
        out.value_error = true;
    } else if o.contains_key("skipped") {
        out.value_skipped = true;
    } else if let Some(Value::Array(names)) = o.get("names") {
        // Names-only extraction of a package-typed value: the value is still
        // skipped, but the drv names survive.
        out.value_skipped = true;
        out.value_names = Some(
            names
                .iter()
                .filter_map(|n| n.as_str().map(String::from))
                .collect(),
        );
    }
    out
}

/// Definition values are pre-merge, so the {mkOverride, content} envelope
/// survives here — lift it into a first-class per-definition priority.
fn to_definition(file: String, value: &ValueEnvelope) -> DefinitionRef {
    let (file, via) = split_via(&file);
    let u = unwrap(value);
    let mut r#ref = DefinitionRef {
        file,
        value: None,
        value_error: u.value_error.then_some(true),
        value_skipped: u.value_skipped.then_some(true),
        value_names: u.value_names,
        via,
        prio: None,
    };
    let mut v = u.value;
    if let Some(Value::Object(o)) = &v
        && o.len() == 2
        && o.contains_key("mkOverride")
        && o.contains_key("content")
    {
        if let Some(prio) = o.get("mkOverride").and_then(|p| p.as_i64()) {
            r#ref.prio = Some(prio);
        }
        v = o.get("content").cloned();
    }
    r#ref.value = v;
    r#ref
}

pub fn to_entry(o: RawOption) -> OptionEntry {
    let val = unwrap(&o.value);
    let def = unwrap(&o.default);
    let customized = o.is_defined && o.highest_prio.is_some_and(|p| p < PRIO_OPTION_DEFAULT);
    OptionEntry {
        loc: o.loc,
        r#type: o.r#type,
        description: o.description,
        read_only: o.read_only,
        is_defined: o.is_defined,
        highest_prio: o.highest_prio,
        customized,
        value: val.value,
        value_error: val.value_error.then_some(true),
        value_skipped: val.value_skipped.then_some(true),
        value_names: val.value_names,
        default: def.value,
        default_names: def.value_names,
        default_text: o.default_text,
        declarations: o
            .declarations
            .into_iter()
            .map(|d| {
                let (file, via) = split_via(&d.file);
                DeclarationRef {
                    file,
                    line: d.line,
                    column: d.column,
                    via,
                }
            })
            .collect(),
        definitions: o
            .definitions
            .into_iter()
            .map(|d| to_definition(d.file, &d.value))
            .collect(),
    }
}

/// storePath (or "<unknown-file>") -> option indices, split by role.
/// "defines" only counts CUSTOMIZED definitions.
pub fn build_file_index(options: &[OptionEntry]) -> IndexMap<String, FileOptionRefs> {
    let mut index: IndexMap<String, FileOptionRefs> = IndexMap::new();
    for (i, o) in options.iter().enumerate() {
        let mut declared = HashSet::new();
        for d in &o.declarations {
            if !declared.insert(d.file.clone()) {
                continue;
            }
            index.entry(d.file.clone()).or_default().declares.push(i);
        }
        if o.customized {
            let mut defined = HashSet::new();
            for d in &o.definitions {
                if !defined.insert(d.file.clone()) {
                    continue;
                }
                index.entry(d.file.clone()).or_default().defines.push(i);
            }
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn err_line_takes_last_substantive() {
        let s = "error:\n  trace stuff\nerror: attribute 'foo' missing\n";
        assert_eq!(err_line(s), "error: attribute 'foo' missing");
        assert_eq!(err_line("plain failure"), "plain failure");
    }

    #[test]
    fn split_via_works() {
        let (f, v) = split_via("/nix/store/x.nix, via option flake.modules.nixos.desktop");
        assert_eq!(f, "/nix/store/x.nix");
        assert_eq!(v.as_deref(), Some("flake.modules.nixos.desktop"));
        let (f, v) = split_via("/nix/store/y.nix");
        assert_eq!(f, "/nix/store/y.nix");
        assert!(v.is_none());
    }

    #[test]
    fn unwrap_envelopes() {
        assert_eq!(unwrap(&Some(json!({"ok": 42}))).value, Some(json!(42)));
        assert!(unwrap(&Some(json!({"err": true}))).value_error);
        assert!(unwrap(&Some(json!({"skipped": true}))).value_skipped);
        let n = unwrap(&Some(json!({"names": ["hello-2.12"]})));
        assert!(n.value_skipped);
        assert_eq!(n.value_names, Some(vec!["hello-2.12".to_string()]));
        assert!(unwrap(&None).value.is_none());
    }

    #[test]
    fn mkoverride_lifted() {
        let d = to_definition(
            "/f.nix".into(),
            &Some(json!({"ok": {"mkOverride": 50, "content": "forced"}})),
        );
        assert_eq!(d.prio, Some(50));
        assert_eq!(d.value, Some(json!("forced")));
    }

    #[test]
    fn file_index_defines_only_customized() {
        let opts = vec![OptionEntry {
            loc: vec!["a".into()],
            r#type: None,
            description: None,
            read_only: false,
            is_defined: true,
            highest_prio: Some(100),
            customized: true,
            value: None,
            value_error: None,
            value_skipped: None,
            value_names: None,
            default: None,
            default_names: None,
            default_text: None,
            declarations: vec![DeclarationRef {
                file: "/decl.nix".into(),
                line: None,
                column: None,
                via: None,
            }],
            definitions: vec![DefinitionRef {
                file: "/def.nix".into(),
                value: None,
                value_error: None,
                value_skipped: None,
                value_names: None,
                via: None,
                prio: None,
            }],
        }];
        let idx = build_file_index(&opts);
        assert_eq!(idx["/decl.nix"].declares, vec![0]);
        assert_eq!(idx["/def.nix"].defines, vec![0]);
    }
}

#[cfg(test)]
mod null_repro {
    use super::*;

    #[test]
    fn ok_null_envelope_survives_to_json() {
        let raw: crate::run_nix::RawOption = serde_json::from_str(
            r#"{"loc":["a"],"type":"null or string","description":null,"readOnly":false,
                "isDefined":true,"highestPrio":1500,"defaultText":null,
                "default":{"ok":null},"value":{"ok":null},
                "declarations":[{"file":"/f.nix","line":1,"column":1}],
                "definitions":[{"file":"/f.nix","value":{"ok":null}}]}"#,
        )
        .unwrap();
        let entry = to_entry(raw);
        let json = serde_json::to_string(&entry).unwrap();
        assert!(
            json.contains(r#""value":null"#),
            "merged value lost: {json}"
        );
        assert!(json.contains(r#""default":null"#), "default lost: {json}");
    }
}
