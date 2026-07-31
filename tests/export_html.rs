// End-to-end export against the real-nix mini-flake fixture: extract_to_dir
// (the CLI driver) then export_html, asserting the single-file HTML embeds
// exactly what it claims — the manifest, the requested blobs, and source
// files — and downgrades not-embedded refs to pending. Covers drive.rs and
// export.rs end to end.
//
// Env mutation (fake app-dist) is process-global → one test in this file.

mod common;

use common::{TempDir, fixture, nix_available};
use flake_explorer::drive::{DriveFlags, Selection, extract_to_dir};
use flake_explorer::export::{ExportOptions, export_html};
use flake_explorer::schema::{Manifest, RefStatus};
use std::time::Duration;

const MINI: &str = "packages/x86_64-linux/mini";
const CHECK: &str = "checks/x86_64-linux/mini-check";

fn embedded_json(html: &str, name: &str) -> Option<serde_json::Value> {
    let tag = format!(r#"<script type="application/json" id="data:{name}">"#);
    let start = html.find(&tag)? + tag.len();
    let end = start + html[start..].find("</script>")?;
    serde_json::from_str(&html[start..end]).ok()
}

#[tokio::test]
async fn export_embeds_blobs_and_downgrades_unembedded_refs() {
    if !nix_available() {
        return;
    }
    let dist = TempDir::new("export-dist");
    std::fs::write(dist.0.join("app.js"), "console.log('test app')").unwrap();
    std::fs::write(dist.0.join("app.css"), ".t{}").unwrap();
    std::fs::write(
        dist.0.join("meta.json"),
        serde_json::json!({
            "themeCss": ":root{}",
            "baseFontRem": 1.0,
            "about": { "name": "Flake Explorer", "version": "test" }
        })
        .to_string(),
    )
    .unwrap();
    // SAFETY: single test in this binary; nothing else reads the env yet.
    unsafe {
        std::env::set_var("FLAKE_EXPLORER_APP_DIST", &dist.0);
    }

    let flake_ref = fixture()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let out = TempDir::new("export-out");
    let out_dir = out.0.to_string_lossy().into_owned();
    let html_path = out.0.join("flake.html");

    // Extract the one configuration plus TWO packages and TWO graphs...
    let r = extract_to_dir(
        &flake_ref,
        &DriveFlags {
            out: out_dir.clone(),
            graphs: Selection::Ids(vec![MINI.to_string(), CHECK.to_string()]),
            config_graphs: false,
            graph_dry_run: false,
            configs: Selection::All,
            packages: Selection::Ids(vec![MINI.to_string(), CHECK.to_string()]),
            all_systems: false,
            timeout: Duration::from_secs(120),
        },
    )
    .await
    .unwrap();
    assert_eq!(r.wanted, ["nixos/mini"]);
    assert_eq!(r.manifest.configurations[0].status, RefStatus::Ok);
    assert!(out.0.join("manifest.json").exists());

    // ...but embed only ONE package: the other must downgrade to pending in
    // the embedded manifest (an "ok" claim without a blob would be a lie).
    export_html(
        &flake_ref,
        &r.manifest,
        &ExportOptions {
            out_dir: out_dir.clone(),
            html_path: html_path.to_string_lossy().into_owned(),
            sources_all: false,
            timeout: Duration::from_secs(60),
            wanted: r.wanted.clone(),
            wanted_packages: vec![MINI.to_string()],
            // Two graphs extracted, ONE embedded — the other must downgrade.
            wanted_graphs: vec![MINI.to_string()],
        },
    )
    .await
    .unwrap();

    let html = std::fs::read_to_string(&html_path).unwrap();
    assert!(html.contains(r#"<div id="app">"#));
    assert!(html.contains(r#"id="data:about.json""#));
    assert!(html.contains(r#"id="data:config/nixos.mini.json""#));
    assert!(html.contains(r#"id="data:package/packages.x86_64-linux.mini.json""#));
    assert!(!html.contains(r#"id="data:package/checks"#)); // not embedded
    // Source files ride along under encodeURIComponent'd ids.
    assert!(html.contains(r#"id="data:file/self%3Aflake.nix""#));

    let manifest: Manifest =
        serde_json::from_value(embedded_json(&html, "manifest.json").unwrap()).unwrap();
    assert_eq!(manifest.configurations[0].status, RefStatus::Ok);
    let mini = manifest.packages.iter().find(|p| p.id == MINI).unwrap();
    assert_eq!(mini.status, RefStatus::Ok);
    let check = manifest.packages.iter().find(|p| p.id == CHECK).unwrap();
    assert_eq!(check.status, RefStatus::Pending); // extracted but not embedded
    assert!(check.extracted_at.is_none());
    // Present in exports (built from the embedded blobs), absent in serve.
    assert!(manifest.package_reverse_deps.is_some());

    // Graph embedding mirrors packages exactly: the embedded one is verbatim
    // and ok, the extracted-but-not-embedded one downgrades to pending.
    assert!(html.contains(r#"id="data:graph/packages.x86_64-linux.mini.json""#));
    assert!(!html.contains(r#"id="data:graph/checks"#));
    let mini_graph = manifest.graphs.iter().find(|g| g.id == MINI).unwrap();
    assert_eq!(mini_graph.status, RefStatus::Ok);
    let check_graph = manifest.graphs.iter().find(|g| g.id == CHECK).unwrap();
    assert_eq!(check_graph.status, RefStatus::Pending);
    assert!(check_graph.extracted_at.is_none());
    let graph = embedded_json(&html, "graph/packages.x86_64-linux.mini.json").unwrap();
    assert_eq!(graph["id"], MINI);
    assert_eq!(graph["tiers"]["presence"], true);
    let graph_on_disk: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out.0.join("graph/packages.x86_64-linux.mini.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        graph, graph_on_disk,
        "embedded graph blob differs from the on-disk blob"
    );

    let config = embedded_json(&html, "config/nixos.mini.json").unwrap();
    assert_eq!(config["id"], "nixos/mini");
    assert!(!config["options"].as_array().unwrap().is_empty());
    // The embed must be the blob VERBATIM, not a typed round-trip: serde's
    // Option collapses an explicit `"value": null` into an absent field,
    // which the UI renders differently from a present null.
    let on_disk: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(out.0.join("config/nixos.mini.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        config, on_disk,
        "embedded config blob differs from the on-disk blob"
    );

    // --sources all additionally embeds every file the exported config's
    // fileIndex references (the resolve_file walk); everything the "self"
    // export carried must still be there.
    let html_all_path = out.0.join("flake-all.html");
    export_html(
        &flake_ref,
        &r.manifest,
        &ExportOptions {
            out_dir,
            html_path: html_all_path.to_string_lossy().into_owned(),
            sources_all: true,
            timeout: Duration::from_secs(60),
            wanted: r.wanted,
            wanted_packages: vec![MINI.to_string()],
            wanted_graphs: vec![MINI.to_string()],
        },
    )
    .await
    .unwrap();
    let html_all = std::fs::read_to_string(&html_all_path).unwrap();
    assert!(html_all.contains(r#"id="data:file/self%3Aflake.nix""#));
    assert!(html_all.len() >= html.len());
}
