// Expensive per-configuration extraction — port of src/extract/options.ts:
// the options tree, walked in chunks so an uncatchable eval error degrades
// instead of killing the whole configuration. Split first, degrade last.

use crate::run_nix::{eval_extract, ExtractArgs, OptionsEval, RawOption, ValueEnvelope};
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
    Rung { with_values: true, with_descriptions: true, note: "" },
    Rung { with_values: false, with_descriptions: true, note: "values skipped" },
    Rung { with_values: false, with_descriptions: false, note: "values+descriptions skipped" },
];

/// Below this depth a failing chunk is abandoned instead of split further.
const MAX_DEPTH: usize = 4;

#[derive(Debug, Clone)]
struct Chunk {
    path: Vec<String>,
    children: Option<Vec<String>>,
    rung: usize,
}

fn chunk_label(c: &Chunk) -> String {
    match &c.children {
        Some(ch) if ch.len() == 1 => {
            let mut p = c.path.clone();
            p.push(ch[0].clone());
            p.join(".")
        }
        _ => c.path.join("."),
    }
}

struct Shared {
    queue: Mutex<VecDeque<Chunk>>,
    results: Mutex<Vec<RawOption>>,
    warnings: Mutex<Vec<String>>,
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
    let concurrency = opts.concurrency.unwrap_or_else(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        cores.saturating_sub(2).clamp(2, 8)
    });
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
                .map(|n| Chunk { path: vec![n], children: None, rung: 0 })
                .collect(),
        ),
        results: Mutex::new(Vec::new()),
        warnings: Mutex::new(Vec::new()),
        done: std::sync::atomic::AtomicUsize::new(0),
        in_flight: std::sync::atomic::AtomicUsize::new(0),
    });

    // Workers exit when the queue is momentarily empty even though a sibling
    // may still push splits; loop until the queue fully drains — the same
    // shape as the TS implementation.
    loop {
        if shared.queue.lock().await.is_empty() {
            break;
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
                worker(&shared, &flake_ref, kind, &name, &label, timeout, skip_invisible, on_progress)
                    .await;
            }));
        }
        for h in handles {
            h.await.ok();
        }
    }

    let results = std::mem::take(&mut *shared.results.lock().await);
    let mut warnings = std::mem::take(&mut *shared.warnings.lock().await);
    // Dedup preserving order, like `[...new Set(warnings)]`.
    let mut seen = HashSet::new();
    warnings.retain(|w| seen.insert(w.clone()));

    let options: Vec<OptionEntry> = results.into_iter().map(to_entry).collect();
    let file_index = build_file_index(&options);
    let data = ConfigData {
        version: SCHEMA_VERSION,
        id: format!("{}/{}", kind.as_str(), name),
        options,
        file_index,
    };
    Ok(OptionsResult { data, warnings, duration_ms: t0.elapsed().as_millis() as u64 })
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
        let chunk = { shared.queue.lock().await.pop_front() };
        let Some(chunk) = chunk else { return };
        shared.in_flight.fetch_add(1, Ordering::SeqCst);
        let current = chunk_label(&chunk);
        run_chunk(shared, flake_ref, kind, name, label, timeout, skip_invisible, chunk).await;
        shared.in_flight.fetch_sub(1, Ordering::SeqCst);
        let done = shared.done.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(cb) = &on_progress {
            let total =
                done + shared.queue.lock().await.len() + shared.in_flight.load(Ordering::SeqCst);
            cb(OptionsProgress { done, total, current });
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
                shared.warnings.lock().await.push(format!(
                    "{label} options.{}: {} (eval error at full detail)",
                    chunk_label(&chunk),
                    rung.note
                ));
            }
            shared.results.lock().await.extend(r.options);
            return;
        }
        Err(e) => e.to_string(),
    };

    // Failed. Prefer splitting at the same detail level to isolate the bad
    // option; healthy siblings keep full detail.
    if let Some(children) = &chunk.children {
        if children.len() > 1 {
            let mid = children.len().div_ceil(2);
            let mut q = shared.queue.lock().await;
            q.push_back(Chunk { children: Some(children[..mid].to_vec()), ..chunk.clone() });
            q.push_back(Chunk { children: Some(children[mid..].to_vec()), ..chunk });
            return;
        }
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
        if let Ok(kids) = kids {
            if !kids.is_empty() {
                shared.queue.lock().await.push_back(Chunk {
                    path: deeper,
                    children: Some(kids),
                    rung: chunk.rung,
                });
                return;
            }
        }
        // unlistable — fall through to rung escalation
    }
    // Unsplittable: walk down the ladder, then give up.
    if chunk.rung + 1 < LADDER.len() {
        shared.queue.lock().await.push_back(Chunk { rung: chunk.rung + 1, ..chunk });
        return;
    }
    shared.warnings.lock().await.push(format!(
        "{label} options.{}: extraction failed — {}",
        deeper.join("."),
        err_line(&last_err)
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
    let mut out =
        Unwrapped { value: None, value_error: false, value_skipped: false, value_names: None };
    let Some(Value::Object(o)) = v else { return out };
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
            names.iter().filter_map(|n| n.as_str().map(String::from)).collect(),
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
    if let Some(Value::Object(o)) = &v {
        if o.len() == 2 && o.contains_key("mkOverride") && o.contains_key("content") {
            if let Some(prio) = o.get("mkOverride").and_then(|p| p.as_i64()) {
                r#ref.prio = Some(prio);
            }
            v = o.get("content").cloned();
        }
    }
    r#ref.value = v;
    r#ref
}

pub fn to_entry(o: RawOption) -> OptionEntry {
    let val = unwrap(&o.value);
    let def = unwrap(&o.default);
    let customized =
        o.is_defined && o.highest_prio.is_some_and(|p| p < PRIO_OPTION_DEFAULT);
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
                DeclarationRef { file, line: d.line, column: d.column, via }
            })
            .collect(),
        definitions: o.definitions.into_iter().map(|d| to_definition(d.file, &d.value)).collect(),
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
        let opts = vec![
            OptionEntry {
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
            },
        ];
        let idx = build_file_index(&opts);
        assert_eq!(idx["/decl.nix"].declares, vec![0]);
        assert_eq!(idx["/def.nix"].defines, vec![0]);
    }
}
