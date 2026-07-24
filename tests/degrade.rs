// build_manifest's transitive-input degradation, hermetic via a scripted
// `nix` shim on PATH.
//
// Resolving an input-of-an-input can abort the eval from below the Nix
// exception layer (a lock entry whose recorded `url` disagrees with what the
// fetcher returns — flakehub pins do this), which not even tryEval catches.
// The shim reproduces that: the full-depth manifest eval fails, the
// inputsDepth-0 retry succeeds.
//
// Env/PATH mutation is process-global, so this file holds exactly ONE test:
// every tests/*.rs is its own process, making the mutation race-free here.

mod common;

use common::TempDir;
use flake_explorer::manifest::{ManifestOptions, build_manifest};
use flake_explorer::schema::OutputNode;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

const FLAKE_REF: &str = "github:example/degrade-flake";
const NIXPKGS: &str = "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-source";

// The `--expr` argv embeds the args JSON with escaped quotes, so the shim
// matches the literal backslash-quote sequences. A manifest call carrying
// `inputsDepth: 0` is the retry; anything else is the full-depth attempt,
// which fails the way the real fetcher does.
const SHIM: &str = r#"#!/bin/sh
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *"flake metadata"*) cat "$NIX_SHIM_DIR/metadata.json" ;;
  *"flake show"*) cat "$NIX_SHIM_DIR/show.json" ;;
  *'inputsDepth\":0'*) cat "$NIX_SHIM_DIR/manifest-shallow.json" ;;
  *'mode\":\"manifest'*)
    echo "error: mismatch in field 'url' of input '{\"type\":\"tarball\"}'" >&2
    exit 1 ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

#[tokio::test]
async fn unresolvable_transitive_input_degrades_with_warning_and_scans_still_run() {
    let shim = TempDir::new("degrade-shim");
    let self_dir = TempDir::new("degrade-self");
    let self_path = self_dir.0.to_string_lossy().into_owned();

    // Self files the source scans read: an input reference, a relative
    // import, and both overlay definition forms.
    std::fs::write(
        self_dir.0.join("flake.nix"),
        "{ inputs.nixpkgs.url = \"github:NixOS/nixpkgs\";\n  outputs = _: { imports = [ ./overlays.nix ]; }; }\n",
    )
    .unwrap();
    std::fs::write(
        self_dir.0.join("overlays.nix"),
        "{ flake.overlays.demo = final: prev: { };\n  overlays.other = final: prev: { }; }\n",
    )
    .unwrap();

    let metadata = serde_json::json!({
        "description": "degrade test flake",
        "path": self_path,
        "resolvedUrl": FLAKE_REF,
        "url": FLAKE_REF,
        "revision": "deadbeef",
        "locked": { "narHash": "sha256-selfnarhash=", "rev": "deadbeef" },
        "locks": {
            "version": 7,
            "root": "root",
            "nodes": {
                // The lock graph is unaffected by the fetcher failure, so the
                // transitive entry must still surface — only its store path
                // is lost.
                "root": { "inputs": { "nixpkgs": "nixpkgs" } },
                "nixpkgs": {
                    "inputs": { "nixos-hardware": "nixos-hardware" },
                    "locked": { "type": "github", "owner": "NixOS", "repo": "nixpkgs", "rev": "cafebabe" },
                    "original": { "type": "github", "owner": "NixOS", "repo": "nixpkgs" }
                },
                "nixos-hardware": {
                    "locked": { "type": "tarball", "url": "https://api.flakehub.com/f/pinned/x?rev=1" },
                    "original": { "type": "tarball", "url": "https://api.flakehub.com/f/pinned/x" }
                }
            }
        }
    });
    let show =
        serde_json::json!({ "nixosConfigurations": { "test": { "type": "nixos-configuration" } } });
    // What extract.nix returns at inputsDepth 0: direct inputs, no children.
    let manifest_shallow = serde_json::json!({
        "self": self_path,
        "description": "degrade test flake",
        "inputs": { "nixpkgs": { "path": NIXPKGS, "inputs": {} } },
        "configurations": [{ "kind": "nixos", "n": "test" }],
        "files": [format!("{self_path}/flake.nix"), format!("{self_path}/overlays.nix")],
        "grafts": [],
        "outputNames": {}
    });

    std::fs::write(shim.0.join("metadata.json"), metadata.to_string()).unwrap();
    std::fs::write(shim.0.join("show.json"), show.to_string()).unwrap();
    std::fs::write(
        shim.0.join("manifest-shallow.json"),
        manifest_shallow.to_string(),
    )
    .unwrap();
    let nix = shim.0.join("nix");
    std::fs::write(&nix, SHIM).unwrap();
    std::fs::set_permissions(&nix, std::fs::Permissions::from_mode(0o755)).unwrap();

    // SAFETY: single test in this binary; no other thread reads the env yet.
    unsafe {
        std::env::set_var("NIX_SHIM_DIR", &shim.0);
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                shim.0.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
    }

    let m = build_manifest(
        FLAKE_REF,
        &ManifestOptions {
            all_systems: false,
            timeout: Duration::from_secs(20),
        },
    )
    .await
    .unwrap();

    // The manifest is usable: flake identity, configurations, outputs survive.
    assert_eq!(m.flake.path, self_path);
    assert_eq!(
        m.configurations
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>(),
        ["nixos/test"]
    );
    assert!(matches!(m.outputs, OutputNode::Attrset { .. }));

    // Every input still appears — the lock graph never depended on the eval.
    let mut names: Vec<&str> = m.inputs.keys().map(String::as_str).collect();
    names.sort();
    assert_eq!(names, ["nixpkgs", "nixpkgs/nixos-hardware"]);
    assert_eq!(m.inputs["nixpkgs"].store_path.as_deref(), Some(NIXPKGS));
    // ...but the transitive one lost the store path the deep walk would have
    // given it.
    let hw = &m.inputs["nixpkgs/nixos-hardware"];
    assert_eq!(hw.transitive, Some(true));
    assert!(hw.store_path.is_none());

    // The degradation is stated, naming the underlying nix error.
    let warning = m
        .warnings
        .iter()
        .find(|w| w.contains("transitive inputs could not be resolved"))
        .expect("degradation warning present");
    assert!(
        warning.contains("mismatch in field 'url'"),
        "warning: {warning}"
    );

    // Degrading the INPUT walk must not quietly drop the file-level scans —
    // they read self files off disk and never touched the failing eval.
    let mut rel_paths: Vec<&str> = m.files.iter().map(|f| f.rel_path.as_str()).collect();
    rel_paths.sort();
    assert_eq!(rel_paths, ["flake.nix", "overlays.nix"]);

    // Both overlay definition forms, attributed to the file defining them.
    let mut overlays = m.overlay_defs.clone().unwrap();
    overlays.sort_by(|a, b| a.name.cmp(&b.name));
    assert_eq!(overlays.len(), 2);
    assert_eq!(
        (overlays[0].name.as_str(), overlays[0].file.as_str()),
        ("demo", "self:overlays.nix")
    );
    assert_eq!(
        (overlays[1].name.as_str(), overlays[1].file.as_str()),
        ("other", "self:overlays.nix")
    );

    assert_eq!(m.input_refs.len(), 1);
    assert_eq!(
        (
            m.input_refs[0].file.as_str(),
            m.input_refs[0].input.as_str()
        ),
        ("self:flake.nix", "nixpkgs")
    );
    assert_eq!(m.import_edges.len(), 1);
    assert_eq!(
        (
            m.import_edges[0].from.as_str(),
            m.import_edges[0].to.as_str()
        ),
        ("self:flake.nix", "self:overlays.nix")
    );
}
