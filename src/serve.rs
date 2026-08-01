// Dev/explore server (axum): serves the prebuilt
// SPA page, manifest + config blobs from the data dir, and extracts a
// pending configuration ON DEMAND when the UI first requests it
// (single-flight per id; the request is held open until extraction
// finishes). POST /api/refresh re-runs the manifest pass.

use crate::cache::{
    CacheKey, apply_extracted, apply_extracted_graph, apply_extracted_package, cache_key_of,
    extract_and_persist, extract_and_persist_graph, extract_and_persist_package, reconcile,
};
use crate::highlight::tokenize_nix;
use crate::manifest::{ManifestOptions, build_manifest};
use crate::page::{PageOpts, find_app_dist, load_bundle, page_html};
use crate::run_nix::{check_nix, read_input_file};
use crate::schema::{Manifest, ParsedFileId, RefStatus, parse_file_id};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use axum::response::{IntoResponse, Response};
use percent_encoding::percent_decode_str;
use regex::Regex;
use serde_json::json;
use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock, broadcast, watch};

#[expect(
    clippy::struct_excessive_bools,
    reason = "a 1:1 image of independent CLI switches, each set once at startup; \
              an enum-per-flag would obscure that mapping"
)]
pub struct ServeFlags {
    pub out: String,
    /// Opt-in: expose configuration graphs (a ~10 s toplevel eval each).
    pub config_graphs: bool,
    /// Opt-in: the T3 dry-run tier on every graph extraction this server runs.
    pub graph_dry_run: bool,
    pub all_systems: bool,
    pub timeout: Duration,
    pub port: u16,
    pub host: String,
    pub dev: bool,
}

/// Shared server state. Public so the integration tests (`tests/serve_http.rs`)
/// can hold one and drive `router()` in-process; fields stay module-private.
pub struct AppState {
    flake_ref: String,
    flags: ServeFlags,
    title: String,
    dist: std::path::PathBuf,
    manifest: RwLock<Manifest>,
    page: RwLock<String>,
    inflight: Mutex<HashMap<String, watch::Receiver<bool>>>,
    /// `nix --version` for this process, captured once at init. Part of the
    /// cache key (`cache.rs::CacheKey`), so it has to be the same string for the
    /// whole run rather than re-read per extraction.
    nix_version: String,
    reload_tx: broadcast::Sender<()>,
}

/// Everything serve does before binding a socket: nix check, data dirs, UI
/// bundle, initial manifest + reconcile. Split from `serve` so tests can
/// build the state and call `router()` without networking.
///
/// # Errors
///
/// Fails when `nix` is missing or unusable, the data directories cannot be
/// created, the UI bundle cannot be located or loaded, or the initial
/// manifest extraction fails.
pub async fn init(flake_ref: String, flags: ServeFlags) -> anyhow::Result<Arc<AppState>> {
    let nix_version = check_nix().await?;
    std::fs::create_dir_all(Path::new(&flags.out).join("config"))?;
    std::fs::create_dir_all(Path::new(&flags.out).join("package"))?;
    std::fs::create_dir_all(Path::new(&flags.out).join("graph"))?;

    println!("loading UI ...");
    let title = format!("flake-explorer — {flake_ref}");
    let dist = find_app_dist()?;
    let bundle = load_bundle(&dist)?;
    let page = page_html(
        &bundle,
        &title,
        &PageOpts {
            dev: flags.dev,
            embeds: &[],
        },
    );

    println!("extracting manifest of {flake_ref} ...");
    let mut manifest = build_manifest(
        &flake_ref,
        &ManifestOptions {
            all_systems: flags.all_systems,
            timeout: flags.timeout,
            config_graphs: flags.config_graphs,
        },
    )
    .await?;
    reconcile(&flags.out, &mut manifest, &nix_version);

    let (reload_tx, _) = broadcast::channel(8);
    Ok(Arc::new(AppState {
        flake_ref,
        title,
        dist,
        manifest: RwLock::new(manifest),
        page: RwLock::new(page),
        inflight: Mutex::new(HashMap::new()),
        nix_version,
        reload_tx,
        flags,
    }))
}

/// The server's whole route surface, as an axum Router over the shared state.
pub fn router(state: Arc<AppState>) -> axum::Router {
    axum::Router::new().fallback(move |req: Request<Body>| handle(state.clone(), req))
}

/// Bring the server up (`init`) and serve until the process ends.
///
/// # Errors
///
/// Fails on anything [`init`] can fail on, on binding `host:port`, or when
/// the accept loop itself errors out.
pub async fn serve(flake_ref: String, flags: ServeFlags) -> anyhow::Result<()> {
    let state = init(flake_ref, flags).await?;

    if state.flags.dev {
        spawn_dev_watcher(state.clone(), state.dist.clone(), state.title.clone());
    }

    let addr = format!("{}:{}", state.flags.host, state.flags.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let port = listener.local_addr()?.port();
    println!(
        "flake-explorer serving {} at http://localhost:{port}",
        state.flake_ref
    );
    axum::serve(listener, router(state)).await?;
    Ok(())
}

// /data/(config|package|graph)/<name>.json — deliberately narrow charset.
// `None` (an unparsable pattern, impossible short of a typo) degrades the
// blob route to a plain 404 instead of panicking the handler.
static BLOB_RE: std::sync::LazyLock<Option<Regex>> = std::sync::LazyLock::new(|| {
    Regex::new(r"^/data/((?:config|package|graph)/[\w@%.+-]+\.json)$").ok()
});

async fn handle(state: Arc<AppState>, req: Request<Body>) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if path == "/" {
        let page = state.page.read().await.clone();
        return ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response();
    }

    if path == "/dev/events" {
        if !state.flags.dev {
            return (StatusCode::NOT_FOUND, "not found").into_response();
        }
        let rx = state.reload_tx.subscribe();
        let stream = async_stream_events(rx);
        return Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from_stream(stream))
            .unwrap_or_else(|_| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "event stream unavailable",
                )
                    .into_response()
            });
    }

    if path == "/data/manifest.json" {
        let manifest = state.manifest.read().await;
        return axum::Json(&*manifest).into_response();
    }

    if let Some(rel) = BLOB_RE
        .as_ref()
        .and_then(|re| re.captures(&path))
        .and_then(|m| m.get(1))
    {
        let rel = percent_decode_str(rel.as_str())
            .decode_utf8_lossy()
            .into_owned();
        return serve_blob(&state, &rel).await;
    }

    if let Some(enc_id) = path.strip_prefix("/data/file/") {
        return serve_file(&state, enc_id, req.uri().query().unwrap_or("")).await;
    }

    if path == "/api/refresh" && method == Method::POST {
        println!("refreshing manifest ...");
        let built = build_manifest(
            &state.flake_ref,
            &ManifestOptions {
                all_systems: state.flags.all_systems,
                timeout: state.flags.timeout,
                config_graphs: state.flags.config_graphs,
            },
        )
        .await;
        return match built {
            Ok(mut m) => {
                reconcile(&state.flags.out, &mut m, &state.nix_version);
                *state.manifest.write().await = m;
                axum::Json(json!({"ok": true})).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
        };
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Which document kind a /data blob path names — decides the manifest ref
/// list, the extraction driver, and the in-flight keyspace.
#[derive(Clone, Copy, PartialEq)]
enum BlobKind {
    Config,
    Package,
    Graph,
}

impl BlobKind {
    fn of_rel(rel: &str) -> Self {
        if rel.starts_with("package/") {
            Self::Package
        } else if rel.starts_with("graph/") {
            Self::Graph
        } else {
            Self::Config
        }
    }
}

/// On-demand extraction of one entity (configuration, package, or graph),
/// single-flighted so concurrent requests for the same id extract once. The
/// cache key is captured at extraction START (a refresh can swap the
/// manifest), and results settle onto the ref in the manifest CURRENT at
/// completion.
async fn serve_blob(state: &Arc<AppState>, rel: &str) -> Response {
    let kind = BlobKind::of_rel(rel);

    // No manifest ref claims this dataFile → 404 before touching disk. This
    // keeps sidecar .meta.json files private and stops encoded-traversal
    // names from serving files outside the data dir.
    let (id, status) = {
        let m = state.manifest.read().await;
        let found = match kind {
            BlobKind::Package => m
                .packages
                .iter()
                .find(|p| p.data_file == rel)
                .map(|p| (p.id.clone(), p.status)),
            BlobKind::Graph => m
                .graphs
                .iter()
                .find(|g| g.data_file == rel)
                .map(|g| (g.id.clone(), g.status)),
            BlobKind::Config => m
                .configurations
                .iter()
                .find(|c| c.data_file == rel)
                .map(|c| (c.id.clone(), c.status)),
        };
        drop(m);
        match found {
            Some(x) => x,
            None => return (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    };

    if status != RefStatus::Ok {
        on_demand(state, kind, &id).await;
        // Re-resolve: /api/refresh may have swapped the manifest while the
        // extraction ran.
        let m = state.manifest.read().await;
        let cur = match kind {
            BlobKind::Package => m
                .packages
                .iter()
                .find(|p| p.data_file == rel)
                .map(|p| (p.status, p.error.clone())),
            BlobKind::Graph => m
                .graphs
                .iter()
                .find(|g| g.data_file == rel)
                .map(|g| (g.status, g.error.clone())),
            BlobKind::Config => m
                .configurations
                .iter()
                .find(|c| c.data_file == rel)
                .map(|c| (c.status, c.error.clone())),
        };
        drop(m);
        match cur {
            Some((RefStatus::Ok, _)) => {}
            Some((_, err)) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    err.unwrap_or_else(|| "extraction failed".into()),
                )
                    .into_response();
            }
            None => return (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    }

    std::fs::read(Path::new(&state.flags.out).join(rel)).map_or_else(
        |_| (StatusCode::NOT_FOUND, "not found").into_response(),
        |bytes| ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
    )
}

async fn on_demand(state: &Arc<AppState>, kind: BlobKind, id: &str) {
    // Keyspace prefix — the three ref kinds must never collide. Configs keep
    // the bare id (the original keyspace); graphs reuse package/config ids,
    // so their prefix is what keeps "packages/x/y" the package apart from
    // "packages/x/y" the graph.
    let key = match kind {
        BlobKind::Config => id.to_string(),
        BlobKind::Package => format!("pkg:{id}"),
        BlobKind::Graph => format!("graph:{id}"),
    };
    let mut rx = {
        let mut inflight = state.inflight.lock().await;
        match inflight.entry(key) {
            Entry::Occupied(entry) => entry.get().clone(),
            Entry::Vacant(entry) => {
                let key = entry.key().clone();
                let (tx, rx) = watch::channel(false);
                entry.insert(rx.clone());
                let state = state.clone();
                let id = id.to_string();
                tokio::spawn(async move {
                    let cache_key = cache_key_of(&*state.manifest.read().await, &state.nix_version);
                    run_extraction(&state, kind, &id, &cache_key).await;
                    // Drop the entry BEFORE signalling, so an entry always means
                    // live work: `wait_for` returns immediately on an already-true
                    // value, so a request that cloned the receiver in between would
                    // "wait" on finished work and re-serve the stale status — an
                    // errored ref would 500 again instead of retrying. No wakeup is
                    // lost, waiters already hold their own receiver clones.
                    state.inflight.lock().await.remove(&key);
                    let _ = tx.send(true);
                });
                rx
            }
        }
    };
    // A dropped sender also means the task finished.
    let _ = rx.wait_for(|done| *done).await;
}

/// Milliseconds as seconds, for the progress lines.
#[expect(
    clippy::as_conversions,
    clippy::cast_precision_loss,
    reason = "display-only math; u64→f64 has no From impl and real durations sit far below 2^52 ms"
)]
fn secs(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

#[expect(
    clippy::too_many_lines,
    reason = "three parallel per-kind arms that read as one table; splitting them would hide the symmetry"
)]
async fn run_extraction(state: &Arc<AppState>, kind: BlobKind, id: &str, cache_key: &CacheKey) {
    match kind {
        BlobKind::Package => {
            let r#ref = {
                let m = state.manifest.read().await;
                m.packages.iter().find(|p| p.id == id).cloned()
            };
            let Some(r#ref) = r#ref else { return };
            if r#ref.status == RefStatus::Ok {
                return;
            }
            println!("extracting package {id} ...");
            match extract_and_persist_package(
                &state.flags.out,
                &state.flake_ref,
                cache_key,
                &r#ref,
                state.flags.timeout,
            )
            .await
            {
                Ok(r) => {
                    let mut m = state.manifest.write().await;
                    if let Some(cur) = m.packages.iter_mut().find(|p| p.id == id) {
                        apply_extracted_package(cur, &r);
                    }
                    m.warnings.extend(r.result.warnings.clone());
                    drop(m);
                    println!(
                        "  {id}: builder={} in {:.1}s",
                        r.result.data.builder.as_str(),
                        secs(r.result.duration_ms)
                    );
                }
                Err(e) => stamp_error(state, kind, id, &e).await,
            }
        }
        BlobKind::Graph => {
            let r#ref = {
                let m = state.manifest.read().await;
                m.graphs.iter().find(|g| g.id == id).cloned()
            };
            let Some(r#ref) = r#ref else { return };
            if r#ref.status == RefStatus::Ok {
                return;
            }
            println!("extracting graph of {id} ...");
            match extract_and_persist_graph(
                &state.flags.out,
                &state.flake_ref,
                cache_key,
                &r#ref,
                state.flags.graph_dry_run,
                state.flags.timeout,
            )
            .await
            {
                Ok(r) => {
                    let mut m = state.manifest.write().await;
                    if let Some(cur) = m.graphs.iter_mut().find(|g| g.id == id) {
                        apply_extracted_graph(cur, &r);
                    }
                    m.warnings.extend(r.result.warnings.clone());
                    drop(m);
                    println!(
                        "  {id}: {} nodes, {} edges in {:.1}s",
                        r.result.data.stats.node_count,
                        r.result.data.stats.edge_count,
                        secs(r.result.duration_ms)
                    );
                }
                Err(e) => stamp_error(state, kind, id, &e).await,
            }
        }
        BlobKind::Config => {
            let r#ref = {
                let m = state.manifest.read().await;
                m.configurations.iter().find(|c| c.id == id).cloned()
            };
            let Some(r#ref) = r#ref else { return };
            if r#ref.status == RefStatus::Ok {
                return;
            }
            println!("extracting options of {id} ...");
            match extract_and_persist(
                &state.flags.out,
                &state.flake_ref,
                cache_key,
                &r#ref,
                state.flags.timeout,
                None,
            )
            .await
            {
                Ok(r) => {
                    let mut m = state.manifest.write().await;
                    if let Some(cur) = m.configurations.iter_mut().find(|c| c.id == id) {
                        apply_extracted(cur, &r);
                    }
                    m.warnings.extend(r.result.warnings.clone());
                    drop(m);
                    println!(
                        "  {id}: {} options in {:.1}s",
                        r.result.data.options.len(),
                        secs(r.result.duration_ms)
                    );
                }
                Err(e) => stamp_error(state, kind, id, &e).await,
            }
        }
    }
}

async fn stamp_error(state: &Arc<AppState>, kind: BlobKind, id: &str, e: &anyhow::Error) {
    let msg = e.to_string().lines().take(3).collect::<Vec<_>>().join(" ");
    let mut m = state.manifest.write().await;
    match kind {
        BlobKind::Package => {
            if let Some(cur) = m.packages.iter_mut().find(|p| p.id == id) {
                cur.status = RefStatus::Error;
                cur.error = Some(msg.clone());
            }
        }
        BlobKind::Graph => {
            if let Some(cur) = m.graphs.iter_mut().find(|g| g.id == id) {
                cur.status = RefStatus::Error;
                cur.error = Some(msg.clone());
            }
        }
        BlobKind::Config => {
            if let Some(cur) = m.configurations.iter_mut().find(|c| c.id == id) {
                cur.status = RefStatus::Error;
                cur.error = Some(msg.clone());
            }
        }
    }
    eprintln!("  {id} failed: {msg}");
}

async fn serve_file(state: &Arc<AppState>, enc_id: &str, query: &str) -> Response {
    // The id alone isn't enough: option declarations/definitions can point
    // anywhere (e.g. inside nixpkgs), so the client resolves and sends the
    // real storePath.
    let store_path = query.split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=')?;
        (k == "storePath").then(|| percent_decode_str(v).decode_utf8_lossy().into_owned())
    });
    let Some(store_path) = store_path.filter(|p| p.starts_with('/')) else {
        return (StatusCode::BAD_REQUEST, "storePath required").into_response();
    };
    // Confinement: only the Nix store and the flake's own tree are readable —
    // without this the route hands out any file the serving user can open.
    let flake_path = state.manifest.read().await.flake.path.clone();
    if !under_readable_root(&store_path, &flake_path) {
        return (
            StatusCode::FORBIDDEN,
            "storePath outside the store and flake",
        )
            .into_response();
    }
    let text = if let Ok(t) = std::fs::read_to_string(&store_path) {
        t
    } else {
        // A cached blob's storePath can be stale (GC'd, or lazy-trees
        // synthetic) — for input-origin files, re-fetch straight from the
        // flake input instead of 404ing.
        let id = percent_decode_str(enc_id).decode_utf8_lossy().into_owned();
        match parse_file_id(&id) {
            Some(ParsedFileId::InputFile { input, rel_path }) => {
                match read_input_file(&state.flake_ref, &input, &rel_path, state.flags.timeout)
                    .await
                {
                    Ok(t) => t,
                    Err(e) => {
                        return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
                    }
                }
            }
            _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    };
    let tokens = tokenize_nix(&text);
    axum::Json(crate::schema::FileSource { text, tokens }).into_response()
}

/// Roots the /data/file/ route may read from: the Nix store and the flake's
/// own tree.
///
/// Compared after normalization so `..` cannot walk out, and with a
/// trailing separator so `/nix/store-evil` can't pass as `/nix/store`.
#[must_use]
pub fn under_readable_root(candidate: &str, flake_path: &str) -> bool {
    let path = normalize_path(candidate);
    if path.starts_with("/nix/store/") {
        return true;
    }
    if flake_path.is_empty() {
        return false;
    }
    let root = normalize_path(flake_path);
    let root_slash = if root.ends_with('/') {
        root.clone()
    } else {
        format!("{root}/")
    };
    path == root || path.starts_with(&root_slash)
}

/// Lexical path normalization matching Node's path.normalize enough for the
/// confinement check: collapse "//", ".", and ".." segments (".." above the
/// root stays clamped at "/").
fn normalize_path(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.pop().is_none() && !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let joined = out.join("/");
    if absolute {
        format!("/{joined}")
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

fn async_stream_events(
    rx: broadcast::Receiver<()>,
) -> impl futures::Stream<Item = Result<String, std::convert::Infallible>> {
    use tokio_stream::StreamExt;
    use tokio_stream::wrappers::BroadcastStream;
    let hello = tokio_stream::once(Ok(": connected\n\n".to_string()));
    let reloads = BroadcastStream::new(rx)
        .filter_map(|r| r.ok().map(|()| Ok("data: reload\n\n".to_string())));
    hello.chain(reloads)
}

/// Dev mode: rebuild the bundle via bun when web/ changes, then push a reload
/// to connected browsers over SSE.
fn spawn_dev_watcher(state: Arc<AppState>, dist: std::path::PathBuf, title: String) {
    use notify::{RecursiveMode, Watcher};
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    let app_dir = repo.join("web");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();

    std::thread::spawn(move || {
        let tx2 = tx.clone();
        let mut watcher =
            match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
                if let Ok(ev) = res {
                    let relevant = ev.paths.iter().any(|p| {
                        p.extension()
                            .is_some_and(|e| e == "svelte" || e == "ts" || e == "css")
                    });
                    if relevant {
                        let _ = tx2.send(());
                    }
                }
            }) {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("dev: cannot watch web/: {e}");
                    return;
                }
            };
        if let Err(e) = watcher.watch(&app_dir, RecursiveMode::Recursive) {
            eprintln!("dev: cannot watch web/: {e}");
            return;
        }
        println!("dev: watching web/ for UI changes");
        // Keep the watcher alive for the process lifetime.
        loop {
            std::thread::sleep(std::time::Duration::from_hours(1));
        }
    });

    tokio::spawn(async move {
        loop {
            if rx.recv().await.is_none() {
                return;
            }
            // Debounce: absorb the burst of events a save produces.
            while matches!(
                tokio::time::timeout(Duration::from_millis(150), rx.recv()).await,
                Ok(Some(()))
            ) {}
            let t0 = std::time::Instant::now();
            let repo = Path::new(env!("CARGO_MANIFEST_DIR"));
            let status = tokio::process::Command::new("bun")
                .arg("scripts/bundle-app.ts")
                .arg("--dev")
                .arg("--out")
                .arg(&dist)
                .current_dir(repo)
                .status()
                .await;
            if !matches!(status, Ok(s) if s.success()) {
                eprintln!("dev: UI rebuild failed");
                continue;
            }
            match load_bundle(&dist) {
                Ok(bundle) => {
                    let page = page_html(
                        &bundle,
                        &title,
                        &PageOpts {
                            dev: true,
                            embeds: &[],
                        },
                    );
                    *state.page.write().await = page;
                    println!(
                        "dev: UI rebuilt in {}ms — reloading clients",
                        t0.elapsed().as_millis()
                    );
                    let _ = state.reload_tx.send(());
                }
                Err(e) => eprintln!("dev: UI rebuild failed: {e}"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_roots() {
        assert!(under_readable_root("/nix/store/abc-src/x.nix", "/home/f"));
        assert!(!under_readable_root("/nix/store-evil/x", "/home/f"));
        assert!(!under_readable_root(
            "/nix/store/../../etc/passwd",
            "/home/f"
        ));
        assert!(under_readable_root("/home/f/mod.nix", "/home/f"));
        assert!(under_readable_root("/home/f", "/home/f"));
        assert!(!under_readable_root("/home/frank/x", "/home/f"));
        assert!(!under_readable_root("/home/f/../k/.ssh/id_rsa", "/home/f"));
        assert!(!under_readable_root("/etc/passwd", ""));
    }
}
