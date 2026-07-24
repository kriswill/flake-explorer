// Real-nix integration test against test/fixtures/mini-flake — port of the
// bun suite's mini-flake.test.ts: exercises the actual extraction pipeline
// (build_manifest + extract_options + extract_package, all shelling out to
// `nix`) end to end, not synthetic fixture data. Skipped without nix (the
// crane check sandbox); CI sets FLAKE_EXPLORER_REQUIRE_NIX so a silent skip
// there is impossible.

mod common;

use common::{TempDir, fixture, nix_available};
use flake_explorer::cache::{
    apply_extracted, apply_extracted_package, cache_key_of, extract_and_persist,
    extract_and_persist_package, reconcile,
};
use flake_explorer::manifest::{ManifestOptions, build_manifest};
use flake_explorer::options::{ExtractOptionsOpts, OptionsProgress, extract_options};
use flake_explorer::schema::*;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn opts() -> ManifestOptions {
    ManifestOptions {
        all_systems: false,
        timeout: Duration::from_secs(60),
    }
}

fn fixture_ref() -> String {
    fixture()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[tokio::test]
async fn manifest_flake_input_files_imports_configurations() {
    if !nix_available() {
        return;
    }
    let m = build_manifest(&fixture_ref(), &opts()).await.unwrap();

    assert_eq!(
        m.flake.description.as_deref(),
        Some("flake-explorer test fixture")
    );

    // A real input, locked and store-fetched.
    let vendor = &m.inputs["vendor"];
    assert_eq!(vendor.r#type, "path");
    assert!(vendor.store_path.is_some());

    let mut rel_paths: Vec<&str> = m.files.iter().map(|f| f.rel_path.as_str()).collect();
    rel_paths.sort();
    assert_eq!(
        rel_paths,
        [
            "extras/default.nix",
            "flake.nix",
            "hosts/mini.nix",
            "lib/greeting.nix",
            "lib/helper.nix",
            "modules/networking.nix",
            "modules/nginx.nix",
            "modules/packages.nix",
            "vendor/flake.nix",
            "vendor/modules/extra.nix",
        ]
    );
    // vendor is nested: its files surface as "self" too (local-path-input
    // behavior, see the fixture's flake.nix comment).
    let vendor_flake = m
        .files
        .iter()
        .find(|f| f.rel_path == "vendor/flake.nix")
        .unwrap();
    assert!(matches!(vendor_flake.origin, FileOrigin::SelfOrigin));

    // flake.nix's own `inputs.vendor.url = …` line is a source reference too.
    assert_eq!(m.input_refs.len(), 1);
    assert_eq!(m.input_refs[0].file, "self:flake.nix");
    assert_eq!(m.input_refs[0].input, "vendor");
    assert!(m.input_follows.is_empty()); // vendor has no inputs of its own

    // `overlays.demo = final: prev: { };` in flake.nix — the regex scan's
    // defining-file signal.
    let overlays = m.overlay_defs.as_ref().unwrap();
    assert_eq!(overlays.len(), 1);
    assert_eq!(overlays[0].name, "demo");
    assert_eq!(overlays[0].file, "self:flake.nix");

    let edges: std::collections::HashSet<String> = m
        .import_edges
        .iter()
        .map(|e| format!("{}->{}", e.from, e.to))
        .collect();
    for expected in [
        "self:lib/greeting.nix->self:lib/helper.nix",
        "self:lib/greeting.nix->self:extras/default.nix",
        "self:flake.nix->self:modules/networking.nix",
        "self:flake.nix->self:modules/nginx.nix",
        "self:flake.nix->self:modules/packages.nix",
        "self:flake.nix->self:hosts/mini.nix",
    ] {
        assert!(edges.contains(expected), "missing import edge {expected}");
    }

    assert_eq!(m.configurations.len(), 1);
    let c = &m.configurations[0];
    assert_eq!(c.id, "nixos/mini");
    assert_eq!(c.kind, ConfigKind::Nixos);
    assert_eq!(c.name, "mini");
    assert_eq!(c.data_file, "config/nixos.mini.json");
    assert_eq!(c.status, RefStatus::Pending);

    // packages/devShells/checks/formatter, enumerated straight from the
    // outputs tree (no extra eval) — apps is intentionally out of scope.
    let ids: std::collections::HashSet<&str> = m.packages.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "packages/x86_64-linux/mini",
            "packages/x86_64-linux/mini-broken-meta",
            "devShells/x86_64-linux/default",
            "checks/x86_64-linux/mini-check",
            "formatter/x86_64-linux",
        ]
        .into_iter()
        .collect()
    );
    let mini = m
        .packages
        .iter()
        .find(|p| p.id == "packages/x86_64-linux/mini")
        .unwrap();
    assert_eq!(mini.path, ["packages", "x86_64-linux", "mini"]);
    assert_eq!(mini.data_file, "package/packages.x86_64-linux.mini.json");
    assert_eq!(mini.status, RefStatus::Pending);
}

#[tokio::test]
async fn options_declares_vs_defines_span_the_fixture_modules() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture_ref();
    let m = build_manifest(&flake_ref, &opts()).await.unwrap();
    let r = extract_options(
        &flake_ref,
        ConfigKind::Nixos,
        "mini",
        ExtractOptionsOpts {
            timeout: Duration::from_secs(60),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let data = r.data;

    let by_loc: std::collections::HashMap<String, &OptionEntry> =
        data.options.iter().map(|o| (o.loc.join("."), o)).collect();

    let host_name = by_loc["networking.hostName"];
    assert!(host_name.customized);
    assert_eq!(host_name.value, Some(serde_json::json!("mini")));
    assert_eq!(host_name.default, Some(serde_json::json!("unset")));
    // networking.nix supplies declarationPositions → line/column survive;
    // nginx.nix does not → bare-declarations fallback, file only.
    assert_eq!(host_name.declarations.len(), 1);
    assert_eq!(
        host_name.declarations[0].file,
        format!("{}/modules/networking.nix", m.flake.path)
    );
    assert_eq!(host_name.declarations[0].line, Some(12));
    assert_eq!(host_name.declarations[0].column, Some(3));

    let nginx_enable = by_loc["services.nginx.enable"];
    assert_eq!(nginx_enable.declarations.len(), 1);
    assert_eq!(
        nginx_enable.declarations[0].file,
        format!("{}/modules/nginx.nix", m.flake.path)
    );
    assert_eq!(nginx_enable.declarations[0].line, None);
    assert!(nginx_enable.customized);
    assert_eq!(nginx_enable.value, Some(serde_json::json!(true)));
    assert_eq!(nginx_enable.default, Some(serde_json::json!(false)));

    let nginx_package = by_loc["services.nginx.package"];
    assert!(!nginx_package.customized);
    assert!(!nginx_package.is_defined);
    assert_eq!(nginx_package.default, Some(serde_json::json!("nginx")));

    // Package-typed option: the value is skipped (closure risk) but the drv
    // names survive — merged, per-definition, and for the empty default.
    let sys_pkgs = by_loc["environment.systemPackages"];
    assert_eq!(sys_pkgs.value, None);
    assert_eq!(sys_pkgs.value_skipped, Some(true));
    assert_eq!(
        sys_pkgs.value_names,
        Some(vec!["mini-dep".to_string(), "mini-0.1.0".to_string()])
    );
    assert_eq!(sys_pkgs.default_names, Some(vec![]));
    // The via-stamped file strings split into a clean path + provenance;
    // the mkIf-wrapped second definition unwraps before naming.
    assert_eq!(sys_pkgs.declarations.len(), 1);
    assert_eq!(
        sys_pkgs.declarations[0].file,
        format!("{}/modules/packages.nix", m.flake.path)
    );
    assert_eq!(
        sys_pkgs.declarations[0].via.as_deref(),
        Some("flake.modules.nixos.demo")
    );
    assert_eq!(sys_pkgs.definitions.len(), 2);
    let d0 = &sys_pkgs.definitions[0];
    assert_eq!(d0.file, format!("{}/hosts/mini.nix", m.flake.path));
    assert_eq!(d0.via.as_deref(), Some("flake.modules.nixos.demo"));
    assert_eq!(d0.value_skipped, Some(true));
    assert_eq!(
        d0.value_names,
        Some(vec!["mini-dep".to_string(), "mini-0.1.0".to_string()])
    );
    let d1 = &sys_pkgs.definitions[1];
    assert_eq!(d1.file, format!("{}/modules/packages.nix", m.flake.path));
    assert_eq!(d1.value_skipped, Some(true));
    assert_eq!(d1.value_names, Some(vec!["mini-dep".to_string()]));

    // The precomputed fileIndex carries the same cross-highlighting facts the
    // bun test checked through the client's buildConfigIndexes: hosts/mini.nix
    // defines 3 customized options, nginx.nix declares 2 and defines none.
    let host_refs = &data.file_index[&format!("{}/hosts/mini.nix", m.flake.path)];
    assert_eq!(host_refs.defines.len(), 3); // hostName + nginx.enable + systemPackages
    assert_eq!(host_refs.declares.len(), 0);
    let nginx_refs = &data.file_index[&format!("{}/modules/nginx.nix", m.flake.path)];
    assert_eq!(nginx_refs.declares.len(), 2); // enable + package
    assert_eq!(nginx_refs.defines.len(), 0);
}

#[tokio::test]
async fn nested_repos_and_worktrees_stay_out_of_the_file_map() {
    if !nix_available() {
        return;
    }
    // A worktree carries a `.git` FILE, a nested clone a `.git` dir — either
    // marks a different project whose .nix files must not leak in.
    let tmp = TempDir::new("mini-nested");
    let dir = &tmp.0;
    copy_tree(&fixture(), dir);
    let scratch = dir.join(".claude/worktrees/scratch");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join(".git"), "gitdir: /elsewhere/.git\n").unwrap();
    std::fs::write(scratch.join("junk.nix"), "{ }\n").unwrap();

    let m = build_manifest(&dir.to_string_lossy(), &opts())
        .await
        .unwrap();
    let rel_paths: Vec<&str> = m.files.iter().map(|f| f.rel_path.as_str()).collect();
    assert!(rel_paths.contains(&"flake.nix"));
    assert!(!rel_paths.iter().any(|p| p.contains("worktrees")));
}

#[tokio::test]
async fn vendor_input_is_listed() {
    if !nix_available() {
        return;
    }
    let m = build_manifest(&fixture_ref(), &opts()).await.unwrap();
    assert_eq!(m.inputs.keys().collect::<Vec<_>>(), ["vendor"]);
}

#[tokio::test]
async fn extract_and_persist_writes_blob_and_sidecar_reconcile_accepts() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture_ref();
    let tmp = TempDir::new("mini-extract");
    let out_dir = tmp.0.to_string_lossy().into_owned();
    std::fs::create_dir_all(tmp.0.join("config")).unwrap();

    let mut m = build_manifest(&flake_ref, &opts()).await.unwrap();
    let key = cache_key_of(&m);
    let r#ref = m.configurations[0].clone();
    let progress: Arc<Mutex<Vec<OptionsProgress>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = progress.clone();

    let r = extract_and_persist(
        &out_dir,
        &flake_ref,
        &key,
        &r#ref,
        Duration::from_secs(60),
        Some(Arc::new(move |p: OptionsProgress| {
            sink.lock().unwrap().push(p);
        })),
    )
    .await
    .unwrap();
    apply_extracted(&mut m.configurations[0], &r);
    assert_eq!(m.configurations[0].status, RefStatus::Ok);
    assert_eq!(
        m.configurations[0].option_count,
        Some(r.result.data.options.len())
    );
    assert!(r.result.data.options.len() > 0);

    // Progress totals must account for chunks held by in-flight sibling
    // workers, not just the queue: done == total may only be reported by the
    // final callback.
    let progress = progress.lock().unwrap();
    assert!(!progress.is_empty());
    for (i, p) in progress.iter().enumerate() {
        assert_eq!(p.done, i + 1); // one callback per finished chunk, in order
        if i < progress.len() - 1 {
            assert!(p.total > p.done);
        }
    }
    let last = progress.last().unwrap();
    assert_eq!(last.total, last.done);

    let blob: ConfigData = serde_json::from_str(
        &std::fs::read_to_string(tmp.0.join(&m.configurations[0].data_file)).unwrap(),
    )
    .unwrap();
    assert_eq!(blob.id, "nixos/mini");

    // A fresh manifest reconciles against the persisted sidecar → no re-eval.
    let mut m2 = build_manifest(&flake_ref, &opts()).await.unwrap();
    reconcile(&out_dir, &mut m2);
    assert_eq!(m2.configurations[0].status, RefStatus::Ok);
    assert_eq!(
        m2.configurations[0].option_count,
        m.configurations[0].option_count
    );
}

#[tokio::test]
async fn extract_package_writes_blob_and_sidecar_reconcile_accepts() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture_ref();
    let tmp = TempDir::new("mini-extract-pkg");
    let out_dir = tmp.0.to_string_lossy().into_owned();
    std::fs::create_dir_all(tmp.0.join("package")).unwrap();

    let mut m = build_manifest(&flake_ref, &opts()).await.unwrap();
    let key = cache_key_of(&m);
    let idx = m
        .packages
        .iter()
        .position(|p| p.id == "packages/x86_64-linux/mini")
        .unwrap();
    let r#ref = m.packages[idx].clone();

    let r =
        extract_and_persist_package(&out_dir, &flake_ref, &key, &r#ref, Duration::from_secs(60))
            .await
            .unwrap();
    apply_extracted_package(&mut m.packages[idx], &r);
    assert_eq!(m.packages[idx].status, RefStatus::Ok);

    // The full real-nix pipeline, end to end: eval markers/meta/deps,
    // `nix derivation show` (drv-level inputs), `nix path-info` (absent —
    // mini is never built).
    let data = &r.result.data;
    assert_eq!(data.pname.as_deref(), Some("mini"));
    assert_eq!(data.pkg_version.as_deref(), Some("0.1.0"));
    assert_eq!(data.deps.native_build_inputs, ["mini-dep"]);
    let license = data.meta.as_ref().unwrap().license.as_ref().unwrap();
    assert_eq!(license[0].spdx_id.as_deref(), Some("MIT"));
    assert_eq!(data.drv.as_ref().unwrap().input_drvs[0].name, "mini-dep");
    assert!(data.runtime.is_none()); // never built

    let blob: PackageData = serde_json::from_str(
        &std::fs::read_to_string(tmp.0.join(&m.packages[idx].data_file)).unwrap(),
    )
    .unwrap();
    assert_eq!(blob.id, "packages/x86_64-linux/mini");

    // A fresh manifest reconciles against the persisted sidecar → no re-eval.
    let mut m2 = build_manifest(&flake_ref, &opts()).await.unwrap();
    reconcile(&out_dir, &mut m2);
    let ref2 = m2
        .packages
        .iter()
        .find(|p| p.id == "packages/x86_64-linux/mini")
        .unwrap();
    assert_eq!(ref2.status, RefStatus::Ok);
}

#[tokio::test]
async fn dev_shells_checks_formatter_extract_as_builder_unknown() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture_ref();
    let tmp = TempDir::new("mini-extract-pkgs");
    let out_dir = tmp.0.to_string_lossy().into_owned();
    std::fs::create_dir_all(tmp.0.join("package")).unwrap();

    let m = build_manifest(&flake_ref, &opts()).await.unwrap();
    let key = cache_key_of(&m);
    for id in [
        "devShells/x86_64-linux/default",
        "checks/x86_64-linux/mini-check",
        "formatter/x86_64-linux",
    ] {
        let r#ref = m.packages.iter().find(|p| p.id == id).unwrap().clone();
        let r = extract_and_persist_package(
            &out_dir,
            &flake_ref,
            &key,
            &r#ref,
            Duration::from_secs(60),
        )
        .await
        .unwrap();
        // Raw derivations, no phases → classify as unknown.
        assert_eq!(r.result.data.builder, BuilderKind::Unknown, "{id}");
        assert!(
            r.result.data.outputs[0]
                .out_path
                .as_deref()
                .unwrap()
                .contains("/nix/store/"),
            "{id}"
        );
    }
}

#[tokio::test]
async fn broken_meta_degrades_to_a_warning_not_a_failure() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture_ref();
    let tmp = TempDir::new("mini-extract-broken-meta");
    let out_dir = tmp.0.to_string_lossy().into_owned();
    std::fs::create_dir_all(tmp.0.join("package")).unwrap();

    let mut m = build_manifest(&flake_ref, &opts()).await.unwrap();
    let key = cache_key_of(&m);
    let idx = m
        .packages
        .iter()
        .position(|p| p.id == "packages/x86_64-linux/mini-broken-meta")
        .unwrap();
    let r#ref = m.packages[idx].clone();
    let r =
        extract_and_persist_package(&out_dir, &flake_ref, &key, &r#ref, Duration::from_secs(60))
            .await
            .unwrap();
    apply_extracted_package(&mut m.packages[idx], &r);
    assert_eq!(m.packages[idx].status, RefStatus::Ok); // a meta failure is a warning
    assert_eq!(r.result.data.pname.as_deref(), Some("mini-broken-meta"));
    assert_eq!(r.result.data.pkg_version.as_deref(), Some("0.1.0"));
    assert!(r.result.data.meta.is_none());
    assert!(
        r.result
            .warnings
            .iter()
            .any(|w| w.contains("meta unavailable"))
    );
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).unwrap();
        }
    }
}
