// Dev/explore server — port of src/serve.ts on axum: serves the prebuilt
// SPA page, manifest + config blobs from the data dir, and extracts a
// pending configuration ON DEMAND when the UI first requests it
// (single-flight per id; the request is held open until extraction
// finishes). POST /api/refresh re-runs the manifest pass.

use crate::cache::{
    CacheKey, apply_extracted, apply_extracted_package, cache_key_of, extract_and_persist,
    extract_and_persist_package, reconcile,
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
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{Mutex, RwLock, broadcast, watch};

pub struct ServeFlags {
    pub out: String,
    pub all_systems: bool,
    pub timeout: Duration,
    pub port: u16,
    pub host: String,
    pub dev: bool,
}

struct AppState {
    flake_ref: String,
    flags: ServeFlags,
    manifest: RwLock<Manifest>,
    page: RwLock<String>,
    inflight: Mutex<HashMap<String, watch::Receiver<bool>>>,
    reload_tx: broadcast::Sender<()>,
}

pub async fn serve(flake_ref: String, flags: ServeFlags) -> anyhow::Result<()> {
    check_nix().await?;
    std::fs::create_dir_all(Path::new(&flags.out).join("config"))?;
    std::fs::create_dir_all(Path::new(&flags.out).join("package"))?;

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
        },
    )
    .await?;
    reconcile(&flags.out, &mut manifest);

    let (reload_tx, _) = broadcast::channel(8);
    let state = Arc::new(AppState {
        flake_ref,
        manifest: RwLock::new(manifest),
        page: RwLock::new(page),
        inflight: Mutex::new(HashMap::new()),
        reload_tx,
        flags,
    });

    if state.flags.dev {
        spawn_dev_watcher(state.clone(), dist, title.clone());
    }

    let addr = format!("{}:{}", state.flags.host, state.flags.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    let port = listener.local_addr()?.port();
    println!(
        "flake-explorer serving {} at http://localhost:{port}",
        state.flake_ref
    );

    let app = axum::Router::new().fallback({
        let state = state.clone();
        move |req: Request<Body>| handle(state.clone(), req)
    });
    axum::serve(listener, app).await?;
    Ok(())
}

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
            .unwrap();
    }

    if path == "/data/manifest.json" {
        let manifest = state.manifest.read().await;
        return axum::Json(&*manifest).into_response();
    }

    // /data/(config|package)/<name>.json — same charset as the TS route.
    static BLOB_RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let blob_re = BLOB_RE
        .get_or_init(|| Regex::new(r"^/data/((?:config|package)/[\w@%.+-]+\.json)$").unwrap());
    if let Some(m) = blob_re.captures(&path) {
        let rel = percent_decode_str(&m[1]).decode_utf8_lossy().into_owned();
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
            },
        )
        .await;
        return match built {
            Ok(mut m) => {
                reconcile(&state.flags.out, &mut m);
                *state.manifest.write().await = m;
                axum::Json(json!({"ok": true})).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, format!("{e}")).into_response(),
        };
    }

    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// On-demand extraction of one entity (configuration or package), single-
/// flighted so concurrent requests for the same id extract once. The cache
/// key is captured at extraction START (see serve.ts for the rationale), and
/// results settle onto the ref in the manifest CURRENT at completion.
async fn serve_blob(state: &Arc<AppState>, rel: &str) -> Response {
    let is_package = rel.starts_with("package/");

    // No manifest ref claims this dataFile → 404 before touching disk. This
    // keeps sidecar .meta.json files private and stops encoded-traversal
    // names from serving files outside the data dir.
    let (id, status) = {
        let m = state.manifest.read().await;
        let found = if is_package {
            m.packages
                .iter()
                .find(|p| p.data_file == rel)
                .map(|p| (p.id.clone(), p.status))
        } else {
            m.configurations
                .iter()
                .find(|c| c.data_file == rel)
                .map(|c| (c.id.clone(), c.status))
        };
        match found {
            Some(x) => x,
            None => return (StatusCode::NOT_FOUND, "not found").into_response(),
        }
    };

    if status != RefStatus::Ok {
        on_demand(state, is_package, &id).await;
        // Re-resolve: /api/refresh may have swapped the manifest while the
        // extraction ran.
        let m = state.manifest.read().await;
        let cur = if is_package {
            m.packages
                .iter()
                .find(|p| p.data_file == rel)
                .map(|p| (p.status, p.error.clone()))
        } else {
            m.configurations
                .iter()
                .find(|c| c.data_file == rel)
                .map(|c| (c.status, c.error.clone()))
        };
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

    match std::fs::read(Path::new(&state.flags.out).join(rel)) {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, "not found").into_response(),
    }
}

async fn on_demand(state: &Arc<AppState>, is_package: bool, id: &str) {
    // Keyspace prefix — a package id must never collide with a config id.
    let key = if is_package {
        format!("pkg:{id}")
    } else {
        id.to_string()
    };
    let mut rx = {
        let mut inflight = state.inflight.lock().await;
        if let Some(rx) = inflight.get(&key) {
            rx.clone()
        } else {
            let (tx, rx) = watch::channel(false);
            inflight.insert(key.clone(), rx.clone());
            let state = state.clone();
            let id = id.to_string();
            tokio::spawn(async move {
                let cache_key = cache_key_of(&*state.manifest.read().await);
                run_extraction(&state, is_package, &id, &cache_key).await;
                let _ = tx.send(true);
                state.inflight.lock().await.remove(&key);
            });
            rx
        }
    };
    // A dropped sender also means the task finished.
    let _ = rx.wait_for(|done| *done).await;
}

async fn run_extraction(state: &Arc<AppState>, is_package: bool, id: &str, cache_key: &CacheKey) {
    if is_package {
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
                println!(
                    "  {id}: builder={} in {:.1}s",
                    r.result.data.builder.as_str(),
                    r.result.duration_ms as f64 / 1000.0
                );
            }
            Err(e) => stamp_error(state, is_package, id, &e).await,
        }
    } else {
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
                println!(
                    "  {id}: {} options in {:.1}s",
                    r.result.data.options.len(),
                    r.result.duration_ms as f64 / 1000.0
                );
            }
            Err(e) => stamp_error(state, is_package, id, &e).await,
        }
    }
}

async fn stamp_error(state: &Arc<AppState>, is_package: bool, id: &str, e: &anyhow::Error) {
    let msg = e.to_string().lines().take(3).collect::<Vec<_>>().join(" ");
    let mut m = state.manifest.write().await;
    if is_package {
        if let Some(cur) = m.packages.iter_mut().find(|p| p.id == id) {
            cur.status = RefStatus::Error;
            cur.error = Some(msg.clone());
        }
    } else if let Some(cur) = m.configurations.iter_mut().find(|c| c.id == id) {
        cur.status = RefStatus::Error;
        cur.error = Some(msg.clone());
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
    let text = match std::fs::read_to_string(&store_path) {
        Ok(t) => t,
        Err(_) => {
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
                            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string())
                                .into_response();
                        }
                    }
                }
                _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
            }
        }
    };
    let tokens = tokenize_nix(&text);
    axum::Json(crate::schema::FileSource { text, tokens }).into_response()
}

/// Roots the /data/file/ route may read from: the Nix store and the flake's
/// own tree. Compared after normalization so `..` cannot walk out, and with a
/// trailing separator so `/nix/store-evil` can't pass as `/nix/store`.
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
            "" | "." => continue,
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
    let reloads =
        BroadcastStream::new(rx).filter_map(|r| r.ok().map(|_| Ok("data: reload\n\n".to_string())));
    hello.chain(reloads)
}

/// Dev mode: rebuild the bundle via bun when app/ (or src/, which the bundle
/// pulls in) changes, then push a reload to connected browsers over SSE.
fn spawn_dev_watcher(state: Arc<AppState>, dist: std::path::PathBuf, title: String) {
    use notify::{RecursiveMode, Watcher};
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let app_dir = repo.join("app");
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
                    eprintln!("dev: cannot watch app/: {e}");
                    return;
                }
            };
        if let Err(e) = watcher.watch(&app_dir, RecursiveMode::Recursive) {
            eprintln!("dev: cannot watch app/: {e}");
            return;
        }
        println!("dev: watching app/ for UI changes");
        // Keep the watcher alive for the process lifetime.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    });

    tokio::spawn(async move {
        loop {
            if rx.recv().await.is_none() {
                return;
            }
            // Debounce: absorb the burst of events a save produces.
            while let Ok(Some(())) =
                tokio::time::timeout(Duration::from_millis(150), rx.recv()).await
            {}
            let t0 = std::time::Instant::now();
            let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
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
