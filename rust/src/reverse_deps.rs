// Reverse-dependency index over the flake's OWN packages — port of
// src/extract/reverse-deps.ts. The sound join key is drvPath; matches are
// false-positive-free and the index is silently PARTIAL over whatever
// package set it is given.

use crate::schema::PackageData;
use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};

/// Depended-on package refId -> sorted refIds that depend on it.
pub fn build_package_reverse_deps(
    package_data: &IndexMap<String, PackageData>,
) -> IndexMap<String, Vec<String>> {
    // drvPath -> owning refIds. A LIST, not one id: aliased outputs share a
    // drvPath and both must be credited.
    let mut by_drv: HashMap<&str, Vec<&str>> = HashMap::new();
    for (id, data) in package_data {
        if let Some(drv) = &data.drv {
            by_drv
                .entry(drv.drv_path.as_str())
                .or_default()
                .push(id.as_str());
        }
    }

    let mut reverse: IndexMap<String, Vec<String>> = IndexMap::new();
    for (id, data) in package_data {
        let mut seen: HashSet<&str> = HashSet::new();
        for inp in data.drv.iter().flat_map(|d| d.input_drvs.iter()) {
            for dep in by_drv.get(inp.drv_path.as_str()).into_iter().flatten() {
                if *dep == id.as_str() || !seen.insert(dep) {
                    continue;
                }
                reverse.entry(dep.to_string()).or_default().push(id.clone());
            }
        }
    }
    for v in reverse.values_mut() {
        v.sort();
    }
    reverse
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::*;

    /// Minimal PackageData: just the id + a drv with a drvPath and inputDrvs.
    fn pkg(id: &str, drv_path: Option<&str>, input_drv_paths: &[&str]) -> PackageData {
        PackageData {
            version: SCHEMA_VERSION,
            id: id.to_string(),
            path: id.split('/').map(String::from).collect(),
            name: None,
            pname: None,
            pkg_version: None,
            builder: BuilderKind::Unknown,
            stdenv: None,
            system: None,
            meta: None,
            src: None,
            outputs: vec![],
            deps: PackageDeps {
                native_build_inputs: vec![],
                build_inputs: vec![],
                propagated_build_inputs: vec![],
            },
            drv: drv_path.map(|p| DrvInfo {
                drv_path: p.to_string(),
                system: "x86_64-linux".into(),
                builder_path: "/bin/sh".into(),
                input_drvs: input_drv_paths
                    .iter()
                    .map(|p| DrvInputRef {
                        drv_path: p.to_string(),
                        name: "x".into(),
                        outputs: vec!["out".into()],
                    })
                    .collect(),
                phases: vec![],
                do_check: None,
                strict_deps: None,
                structured_attrs: None,
            }),
            runtime: None,
            warnings: vec![],
        }
    }

    fn map_of(pkgs: Vec<PackageData>) -> IndexMap<String, PackageData> {
        pkgs.into_iter().map(|p| (p.id.clone(), p)).collect()
    }

    #[test]
    fn joins_on_drv_path() {
        let rev = build_package_reverse_deps(&map_of(vec![
            pkg("b", Some("/nix/store/b.drv"), &[]),
            pkg("a", Some("/nix/store/a.drv"), &["/nix/store/b.drv"]),
        ]));
        assert_eq!(rev.len(), 1);
        assert_eq!(rev["b"], ["a"]);
    }

    #[test]
    fn aliased_derivations_both_get_credited() {
        // packages.default = packages.myapp → same drvPath under two refIds;
        // a dependent must show up on BOTH pages.
        let rev = build_package_reverse_deps(&map_of(vec![
            pkg("myapp", Some("/nix/store/app.drv"), &[]),
            pkg("default", Some("/nix/store/app.drv"), &[]),
            pkg("tool", Some("/nix/store/tool.drv"), &["/nix/store/app.drv"]),
        ]));
        assert_eq!(rev["myapp"], ["tool"]);
        assert_eq!(rev["default"], ["tool"]);
    }

    #[test]
    fn skips_self_edges_missing_drvs_and_unknown_drv_paths() {
        let rev = build_package_reverse_deps(&map_of(vec![
            // self-referential inputDrv must not list itself
            pkg("selfish", Some("/nix/store/s.drv"), &["/nix/store/s.drv"]),
            // depends only on an un-extracted nixpkgs drv → no edge
            pkg(
                "leaf",
                Some("/nix/store/leaf.drv"),
                &["/nix/store/nixpkgs-hello.drv"],
            ),
            // no drv at all → contributes nothing, crashes nothing
            pkg("nodrv", None, &[]),
        ]));
        assert!(rev.is_empty());
    }

    #[test]
    fn duplicate_input_drv_listed_once() {
        let rev = build_package_reverse_deps(&map_of(vec![
            pkg("lib", Some("/nix/store/lib.drv"), &[]),
            pkg(
                "app",
                Some("/nix/store/app.drv"),
                &["/nix/store/lib.drv", "/nix/store/lib.drv"],
            ),
        ]));
        assert_eq!(rev.len(), 1);
        assert_eq!(rev["lib"], ["app"]);
    }
}
