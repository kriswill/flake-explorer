// Integration test of the serve layer: routing + the on-demand single-flight
// extraction, hermetic
// via a scripted `nix` shim on PATH. The axum Router is driven in-process
// (tower oneshot) — same handlers, no sockets. Ordered sub-steps in ONE test
// fn: later steps deliberately depend on state earlier ones created; env
// mutation (PATH, shim vars, app-dist) is process-global, and one test per
// process keeps it race-free.

mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use common::TempDir;
use flake_explorer::schema::{ConfigData, Manifest, RefStatus};
use flake_explorer::serve::{ServeFlags, init, router};
use futures::StreamExt;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tower::ServiceExt;

const FLAKE_REF: &str = "github:example/shim-flake"; // NOT path-like: keeps git/localCheckout logic off
const PKG_ID: &str = "packages/x86_64-linux/demo";
const PKG_DATA_FILE: &str = "package/packages.x86_64-linux.demo.json";

// Scripted fake nix. Fixture JSON lives in $NIX_SHIM_DIR; every handled call
// appends its mode to $NIX_SHIM_LOG so the test can count invocations. The
// options/package evals sleep so concurrent requests overlap (single-flight
// proof). The eval --expr argv embeds the args JSON with escaped quotes, so
// the patterns match the literal backslash-quote sequences.
const SHIM: &str = r#"#!/bin/sh
log() { printf '%s\n' "$1" >> "$NIX_SHIM_LOG"; }
case "$*" in
  *--version*) log version; echo "nix (Nix) 2.34.7" ;;
  *"flake metadata"*) log metadata; cat "$NIX_SHIM_DIR/metadata.json" ;;
  *"flake show"*) log show; cat "$NIX_SHIM_DIR/show.json" ;;
  *'mode\":\"manifest'*) log manifest; cat "$NIX_SHIM_DIR/manifest-eval.json" ;;
  *'mode\":\"optionNames'*)
    log optionNames
    if [ -e "$NIX_SHIM_DIR/fail-optionNames" ]; then echo "error: shim optionNames refused" >&2; exit 1; fi
    cat "$NIX_SHIM_DIR/option-names.json" ;;
  *'mode\":\"options'*) log options; sleep 0.3; cat "$NIX_SHIM_DIR/options-eval.json" ;;
  *'mode\":\"package'*)
    log package
    if [ -e "$NIX_SHIM_DIR/fail-package" ]; then echo "error: shim package refused" >&2; exit 1; fi
    sleep 0.3
    cat "$NIX_SHIM_DIR/package-eval.json" ;;
  *"derivation show"*) log derivationShow; echo '{}' ;;
  *"path-info"*) log pathInfo; echo "error: shim path-info: not valid" >&2; exit 1 ;;
  *"builtins.readFile"*)
    log readFile
    if [ -e "$NIX_SHIM_DIR/input-file.nix" ]; then cat "$NIX_SHIM_DIR/input-file.nix"; else echo "error: shim input file gone" >&2; exit 1; fi ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

struct Ctx {
    router: axum::Router,
    shim_dir: PathBuf,
    log_file: PathBuf,
    data_dir: PathBuf,
    data_parent: PathBuf,
    self_dir: PathBuf,
}

async fn get(ctx: &Ctx, path: &str) -> (StatusCode, String) {
    request(ctx, "GET", path).await
}

async fn request(ctx: &Ctx, method: &str, path: &str) -> (StatusCode, String) {
    let res = ctx
        .router
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = res.status();
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

async fn get_manifest(ctx: &Ctx) -> Manifest {
    let (status, body) = get(ctx, "/data/manifest.json").await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_str(&body).unwrap()
}

/// Shim invocations per mode since the log was last reset.
fn shim_counts(ctx: &Ctx) -> HashMap<String, usize> {
    let text = std::fs::read_to_string(&ctx.log_file).unwrap_or_default();
    let mut counts = HashMap::new();
    for line in text.lines() {
        if !line.is_empty() {
            *counts.entry(line.to_string()).or_insert(0) += 1;
        }
    }
    counts
}

fn reset_shim_log(ctx: &Ctx) {
    std::fs::write(&ctx.log_file, "").unwrap();
}

fn counts_of(pairs: &[(&str, usize)]) -> HashMap<String, usize> {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn enc(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC).to_string()
}

fn blob_path(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("config/nixos.test.json")
}
fn sidecar_path(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join("config/nixos.test.meta.json")
}
fn pkg_blob_path(ctx: &Ctx) -> PathBuf {
    ctx.data_dir.join(PKG_DATA_FILE)
}
fn pkg_sidecar_path(ctx: &Ctx) -> PathBuf {
    ctx.data_dir
        .join(PKG_DATA_FILE.replace(".json", ".meta.json"))
}

fn write_fixtures(shim_dir: &Path, self_dir: &Path) {
    let self_path = self_dir.to_string_lossy();
    // nix flake metadata --json: one simple locked input, resolvedUrl not
    // path-like so detect_local_checkout stays None (no git calls).
    let metadata = serde_json::json!({
        "description": "shim test flake",
        "path": self_path,
        "resolvedUrl": FLAKE_REF,
        "url": FLAKE_REF,
        "revision": "deadbeef",
        "locked": { "narHash": "sha256-selfnarhash=", "rev": "deadbeef" },
        "locks": {
            "version": 7,
            "root": "root",
            "nodes": {
                "root": { "inputs": { "nixpkgs": "nixpkgs" } },
                "nixpkgs": {
                    "locked": {
                        "type": "github", "owner": "NixOS", "repo": "nixpkgs", "rev": "cafebabe",
                        "narHash": "sha256-nixpkgsnarhash=", "lastModified": 1700000000i64
                    },
                    "original": { "type": "github", "owner": "NixOS", "repo": "nixpkgs" }
                }
            }
        }
    });
    // Classic flake show: one nixosConfiguration plus one derivation-typed
    // output so the on-demand package route is reachable.
    let show = serde_json::json!({
        "nixosConfigurations": { "test": { "type": "nixos-configuration" } },
        "packages": { "x86_64-linux": { "demo": { "type": "derivation", "name": "demo-1.0" } } }
    });
    // mode=manifest: empty files list keeps the import graph trivial.
    let manifest_eval = serde_json::json!({
        "self": self_path,
        "description": "shim test flake",
        "inputs": { "nixpkgs": { "path": "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source", "inputs": {} } },
        "configurations": [{ "kind": "nixos", "n": "test" }],
        "files": [],
        "grafts": [],
        "outputNames": {}
    });
    // mode=optionNames: a single namespace → exactly one options chunk per
    // extraction run (1 optionNames + 1 options eval).
    let option_names = serde_json::json!(["services"]);
    let options_eval = serde_json::json!({
        "options": [{
            "loc": ["services", "demo", "enable"],
            "type": "boolean",
            "description": "Demo option.",
            "readOnly": false,
            "isDefined": true,
            "highestPrio": 100,
            "defaultText": null,
            "default": { "ok": false },
            "value": { "ok": true },
            "declarations": [{ "file": format!("{self_path}/module.nix"), "line": null, "column": null }],
            "definitions": [{ "file": format!("{self_path}/module.nix"), "value": { "ok": true } }]
        }]
    });
    // mode=package: the minimum extract_package needs (isDrv + one output);
    // derivation show / path-info answers come from their own shim branches.
    let package_eval = serde_json::json!({
        "isDrv": true,
        "name": "demo-1.0",
        "pname": "demo",
        "pkgVersion": "1.0",
        "stdenv": "stdenv-linux",
        "system": "x86_64-linux",
        "markers": { "cargoDeps": false, "goModules": false, "npmDeps": false, "buildCommand": false },
        "outputs": [{ "name": "out", "path": "/nix/store/dddddddddddddddddddddddddddddddd-demo-1.0" }],
        "meta": { "description": "shim demo package" },
        "metaError": false,
        "src": null,
        "deps": { "nativeBuildInputs": [], "buildInputs": [], "propagatedBuildInputs": [] }
    });

    let w = |name: &str, v: &serde_json::Value| {
        std::fs::write(shim_dir.join(name), v.to_string()).unwrap()
    };
    w("metadata.json", &metadata);
    w("show.json", &show);
    w("manifest-eval.json", &manifest_eval);
    w("option-names.json", &option_names);
    w("options-eval.json", &options_eval);
    w("package-eval.json", &package_eval);

    let nix = shim_dir.join("nix");
    std::fs::write(&nix, SHIM).unwrap();
    std::fs::set_permissions(&nix, std::fs::Permissions::from_mode(0o755)).unwrap();
}

/// Minimal fake app-dist: the serve tests exercise routes, not the bundle.
fn write_fake_app_dist(dist: &Path) {
    std::fs::create_dir_all(dist).unwrap();
    std::fs::write(dist.join("app.js"), "console.log('test app')").unwrap();
    std::fs::write(dist.join("app.css"), ".t{}").unwrap();
    std::fs::write(
        dist.join("meta.json"),
        serde_json::json!({
            "themeCss": ":root{}",
            "baseFontRem": 1.0,
            "about": { "name": "Flake Explorer", "version": "test" }
        })
        .to_string(),
    )
    .unwrap();
}

fn flags(data_dir: &Path, dev: bool) -> ServeFlags {
    ServeFlags {
        out: data_dir.to_string_lossy().into_owned(),
        all_systems: false,
        timeout: Duration::from_secs(60),
        port: 0,
        host: "127.0.0.1".to_string(),
        dev,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_routing_and_on_demand_extraction() {
    let shim = TempDir::new("serve-shim");
    let data_parent = TempDir::new("serve-data");
    let self_tmp = TempDir::new("serve-self");
    let dist_tmp = TempDir::new("serve-dist");
    let data_dir = data_parent.0.join("out");
    let log_file = shim.0.join("calls.log");

    // A file OUTSIDE the data dir, to probe path-traversal containment.
    std::fs::write(data_parent.0.join("outside.json"), r#"{"leaked":true}"#).unwrap();

    write_fixtures(&shim.0, &self_tmp.0);
    write_fake_app_dist(&dist_tmp.0);

    // SAFETY: one test in this binary; nothing else reads the env yet.
    unsafe {
        std::env::set_var("NIX_SHIM_DIR", &shim.0);
        std::env::set_var("NIX_SHIM_LOG", &log_file);
        std::env::set_var("FLAKE_EXPLORER_APP_DIST", &dist_tmp.0);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                shim.0.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
    }

    let state = init(FLAKE_REF.to_string(), flags(&data_dir, false))
        .await
        .unwrap();
    let ctx = Ctx {
        router: router(state),
        shim_dir: shim.0.clone(),
        log_file,
        data_dir,
        data_parent: data_parent.0.clone(),
        self_dir: self_tmp.0.clone(),
    };

    // ---- GET / serves the built SPA page
    let (status, html) = get(&ctx, "/").await;
    assert_eq!(status, StatusCode::OK);
    assert!(html.contains(r#"<div id="app">"#));
    assert!(html.contains(r#"<script type="module">"#));
    assert!(html.contains(&format!("flake-explorer — {FLAKE_REF}")));

    // ---- manifest: shim-built, config pending (nothing to reconcile)
    let manifest = get_manifest(&ctx).await;
    assert_eq!(manifest.configurations.len(), 1);
    let c = &manifest.configurations[0];
    assert_eq!((c.id.as_str(), c.name.as_str()), ("nixos/test", "test"));
    assert_eq!(c.data_file, "config/nixos.test.json");
    assert_eq!(c.status, RefStatus::Pending);
    assert_eq!(
        manifest.flake.nar_hash.as_deref(),
        Some("sha256-selfnarhash=")
    );
    assert_eq!(
        manifest
            .packages
            .iter()
            .map(|p| p.id.as_str())
            .collect::<Vec<_>>(),
        [PKG_ID]
    );
    assert_eq!(manifest.inputs.keys().collect::<Vec<_>>(), ["nixpkgs"]);

    // ---- config blob is held open until extraction completes
    reset_shim_log(&ctx);
    let t0 = Instant::now();
    let (status, body) = get(&ctx, "/data/config/nixos.test.json").await;
    let elapsed = t0.elapsed();
    assert_eq!(status, StatusCode::OK);
    // The shim's options eval sleeps 300ms — the response cannot have
    // arrived earlier if the request was truly held open.
    assert!(elapsed > Duration::from_millis(250), "elapsed: {elapsed:?}");
    let data: ConfigData = serde_json::from_str(&body).unwrap();
    assert_eq!(data.id, "nixos/test");
    assert_eq!(data.options.len(), 1);
    assert_eq!(data.options[0].loc, ["services", "demo", "enable"]);
    assert!(blob_path(&ctx).exists());
    assert!(sidecar_path(&ctx).exists());
    let manifest = get_manifest(&ctx).await;
    assert_eq!(manifest.configurations[0].status, RefStatus::Ok);
    assert_eq!(manifest.configurations[0].option_count, Some(1));
    // Baseline for single-flight: one run = one optionNames + one options.
    assert_eq!(
        shim_counts(&ctx),
        counts_of(&[("optionNames", 1), ("options", 1)])
    );

    // ---- single-flight: two concurrent requests extract once
    std::fs::remove_file(blob_path(&ctx)).unwrap();
    std::fs::remove_file(sidecar_path(&ctx)).unwrap();
    let (status, body) = request(&ctx, "POST", "/api/refresh").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, r#"{"ok":true}"#);
    assert_eq!(
        get_manifest(&ctx).await.configurations[0].status,
        RefStatus::Pending
    );

    reset_shim_log(&ctx);
    let (a, b) = tokio::join!(
        get(&ctx, "/data/config/nixos.test.json"),
        get(&ctx, "/data/config/nixos.test.json")
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    let da: ConfigData = serde_json::from_str(&a.1).unwrap();
    assert_eq!(da.id, "nixos/test");
    assert_eq!(a.1, b.1);
    // Same eval counts as ONE extraction: the second request rode the
    // in-flight extraction instead of re-evaluating.
    assert_eq!(
        shim_counts(&ctx),
        counts_of(&[("optionNames", 1), ("options", 1)])
    );

    // ---- refresh reconciles the extracted config back to ok from its sidecar
    let (status, _) = request(&ctx, "POST", "/api/refresh").await;
    assert_eq!(status, StatusCode::OK);
    reset_shim_log(&ctx);
    let manifest = get_manifest(&ctx).await;
    assert_eq!(manifest.configurations[0].status, RefStatus::Ok);
    assert_eq!(manifest.configurations[0].option_count, Some(1));
    let (status, _) = get(&ctx, "/data/config/nixos.test.json").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shim_counts(&ctx), HashMap::new());

    // ---- package blob is held open until the package extracts
    reset_shim_log(&ctx);
    let t0 = Instant::now();
    let (status, body) = get(&ctx, &format!("/data/{PKG_DATA_FILE}")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(t0.elapsed() > Duration::from_millis(250));
    let pkg: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(pkg["id"], PKG_ID);
    assert_eq!(pkg["pname"], "demo");
    assert!(pkg_blob_path(&ctx).exists());
    assert!(pkg_sidecar_path(&ctx).exists());
    assert_eq!(get_manifest(&ctx).await.packages[0].status, RefStatus::Ok);
    assert_eq!(shim_counts(&ctx)["package"], 1);

    // ---- an already-extracted package re-serves without re-evaluating
    reset_shim_log(&ctx);
    let (status, _) = get(&ctx, &format!("/data/{PKG_DATA_FILE}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(shim_counts(&ctx), HashMap::new());

    // ---- single-flight: two concurrent package requests extract once
    std::fs::remove_file(pkg_blob_path(&ctx)).unwrap();
    std::fs::remove_file(pkg_sidecar_path(&ctx)).unwrap();
    request(&ctx, "POST", "/api/refresh").await;
    assert_eq!(
        get_manifest(&ctx).await.packages[0].status,
        RefStatus::Pending
    );
    reset_shim_log(&ctx);
    let pkg_url = format!("/data/{PKG_DATA_FILE}");
    let (a, b) = tokio::join!(get(&ctx, &pkg_url), get(&ctx, &pkg_url));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert_eq!(a.1, b.1);
    assert_eq!(shim_counts(&ctx)["package"], 1);

    // ---- a failing package extraction marks the ref error and 500s
    std::fs::remove_file(pkg_blob_path(&ctx)).unwrap();
    std::fs::remove_file(pkg_sidecar_path(&ctx)).unwrap();
    request(&ctx, "POST", "/api/refresh").await;
    std::fs::write(ctx.shim_dir.join("fail-package"), "").unwrap();
    let (status, _) = get(&ctx, &format!("/data/{PKG_DATA_FILE}")).await;
    std::fs::remove_file(ctx.shim_dir.join("fail-package")).unwrap();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let manifest = get_manifest(&ctx).await;
    assert_eq!(manifest.packages[0].status, RefStatus::Error);
    let err = manifest.packages[0].error.as_deref().unwrap();
    // The message is truncated to its first lines, not a whole nix trace.
    assert!(err.contains("shim package refused"), "error: {err}");
    assert!(err.lines().count() <= 3);

    // ---- the next request retries an errored package and recovers
    reset_shim_log(&ctx);
    let (status, _) = get(&ctx, &format!("/data/{PKG_DATA_FILE}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(get_manifest(&ctx).await.packages[0].status, RefStatus::Ok);

    // ---- route guards: unknown /data paths 404
    assert_eq!(
        get(&ctx, "/data/config/../evil.json").await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(get(&ctx, "/data/nonsense").await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        get(&ctx, "/data/config/no-such-config.json").await.0,
        StatusCode::NOT_FOUND
    );

    // ---- sidecar .meta.json is not a public route (no ref claims it)
    assert_eq!(
        get(&ctx, "/data/config/nixos.test.meta.json").await.0,
        StatusCode::NOT_FOUND
    );

    // ---- %2F in the config path cannot escape the data dir (LFI)
    assert_eq!(
        get(&ctx, "/data/config/..%2F..%2Foutside.json").await.0,
        StatusCode::NOT_FOUND
    );
    // (outside.json really is there — the guard, not absence, must be the reason)
    assert!(ctx.data_parent.join("outside.json").exists());

    // ---- /data/file/<id> without storePath is a 400
    let (status, body) = get(&ctx, "/data/file/self:whatever").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body, "storePath required");

    // ---- serves an existing storePath (under the flake root) with tokens
    let src = ctx.self_dir.join("on-disk.nix");
    std::fs::write(&src, "{ demo = \"yes\"; } # a comment\n").unwrap();
    let (status, body) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("self:on-disk.nix"),
            enc(&src.to_string_lossy())
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let file: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(file["text"].as_str().unwrap().contains(r#"demo = "yes""#));
    assert!(!file["tokens"].as_array().unwrap().is_empty());

    // ---- storePath outside the store and the flake is refused, not read
    let secret = ctx.data_parent.join("id_rsa");
    std::fs::write(&secret, "PRIVATE KEY MATERIAL\n").unwrap();
    let (status, body) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("self:anything.nix"),
            enc(&secret.to_string_lossy())
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(!body.contains("PRIVATE KEY"));

    // ---- traversal out of an allowed root is refused after normalization
    let climbing = format!("{}/../../etc/hostname", ctx.self_dir.display());
    let (status, _) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("self:x.nix"),
            enc(&climbing)
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // ---- a sibling dir sharing the store prefix does not pass as the store
    let (status, _) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("self:x.nix"),
            enc("/nix/store-evil/leak.nix")
        ),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // ---- stale storePath on a self file is a 404 (nothing to re-fetch from)
    let (status, _) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("self:gone.nix"),
            enc("/nix/store/nope-source/gone.nix")
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // ---- stale storePath on an input file re-fetches through the flake input
    std::fs::write(ctx.shim_dir.join("input-file.nix"), "{ fromInput = 1; }\n").unwrap();
    reset_shim_log(&ctx);
    let (status, body) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("input:nixpkgs:lib/mod.nix"),
            enc("/nix/store/nope-source/mod.nix")
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let file: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert!(file["text"].as_str().unwrap().contains("fromInput"));
    assert_eq!(shim_counts(&ctx), counts_of(&[("readFile", 1)]));

    // ---- input re-fetch failure surfaces as a 500 with the nix error
    std::fs::remove_file(ctx.shim_dir.join("input-file.nix")).unwrap();
    let (status, body) = get(
        &ctx,
        &format!(
            "/data/file/{}?storePath={}",
            enc("input:nixpkgs:lib/other.nix"),
            enc("/nix/store/nope-source/other.nix")
        ),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("shim input file gone"), "body: {body}");

    // ---- a failing extraction marks the config error and the held request 500s
    std::fs::remove_file(blob_path(&ctx)).unwrap();
    std::fs::remove_file(sidecar_path(&ctx)).unwrap();
    request(&ctx, "POST", "/api/refresh").await;
    assert_eq!(
        get_manifest(&ctx).await.configurations[0].status,
        RefStatus::Pending
    );
    std::fs::write(ctx.shim_dir.join("fail-optionNames"), "").unwrap();
    let (status, body) = get(&ctx, "/data/config/nixos.test.json").await;
    std::fs::remove_file(ctx.shim_dir.join("fail-optionNames")).unwrap();
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(body.contains("optionNames refused"), "body: {body}");
    let cfg = &get_manifest(&ctx).await.configurations[0];
    assert_eq!(cfg.status, RefStatus::Error);
    assert!(
        cfg.error
            .as_deref()
            .unwrap()
            .contains("optionNames refused")
    );

    // ---- the next request retries an errored config and recovers
    reset_shim_log(&ctx);
    let (status, _) = get(&ctx, "/data/config/nixos.test.json").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        get_manifest(&ctx).await.configurations[0].status,
        RefStatus::Ok
    );
    assert_eq!(
        shim_counts(&ctx),
        counts_of(&[("optionNames", 1), ("options", 1)])
    );

    // ---- /dev/events 404s when the dev flag is off
    assert_eq!(get(&ctx, "/dev/events").await.0, StatusCode::NOT_FOUND);

    // ---- dev mode: page carries the auto-reload client; SSE says hello
    let dev_state = init(FLAKE_REF.to_string(), flags(&ctx.data_dir, true))
        .await
        .unwrap();
    let dev_router = router(dev_state);
    let res = dev_router
        .clone()
        .oneshot(Request::builder().uri("/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let html = String::from_utf8_lossy(
        &axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .into_owned();
    assert!(html.contains("/dev/events"));

    let res = dev_router
        .oneshot(
            Request::builder()
                .uri("/dev/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        res.headers()
            .get("content-type")
            .unwrap()
            .to_str()
            .unwrap()
            .contains("text/event-stream")
    );
    let first = res
        .into_body()
        .into_data_stream()
        .next()
        .await
        .unwrap()
        .unwrap();
    assert!(String::from_utf8_lossy(&first).contains(": connected"));
}
