// Projection of `nix derivation show -r` output into a GraphData document.
//
// The raw dump is big — 71.7 MB for a real system graph, most of it `env`
// blobs — so it is NEVER parsed as serde_json::Value (measured 470 MB peak
// RSS against 127 MB for the typed structs here, which skip `env`/`args`
// entirely). Projection only; enrichment tiers are stamped on afterwards.

use crate::package::name_from_drv_basename;
use crate::schema::*;
use indexmap::IndexMap;
use serde::Deserialize;
use serde::de::IgnoredAny;
use std::collections::{HashMap, HashSet};

// ------------------------------------------------------------ raw typed shapes
//
// Everything not named here (env, args, builder, srcs, …) is lexed past and
// dropped by serde. Two envelope shapes exist, same as
// normalize_derivation_show (package.rs): v4 wraps the drv map in
// {"derivations": {…}} and nests input drvs under `inputs.drvs`; older nix
// returns the map at top level with `inputDrvs`.

#[derive(Deserialize)]
struct ShowEnvelope {
    derivations: Option<IndexMap<String, RawShowDrv>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawShowDrv {
    name: Option<String>,
    system: Option<String>,
    #[serde(default)]
    outputs: IndexMap<String, RawShowOutput>,
    inputs: Option<RawShowInputs>,
    /// Old flat shape. Values are `{outputs: […]}` objects or (very old nix)
    /// bare arrays — only the keys matter here, so both are ignored.
    input_drvs: Option<IndexMap<String, IgnoredAny>>,
}

#[derive(Deserialize)]
struct RawShowOutput {
    path: Option<String>,
}

#[derive(Deserialize)]
struct RawShowInputs {
    drvs: Option<IndexMap<String, IgnoredAny>>,
}

/// Both envelope shapes → the basename-keyed drv map. The v4 probe parse is
/// cheap on an old-shape document (unknown top-level keys are skipped), and a
/// top-level key can never literally be "derivations" — keys are store-path
/// basenames, which always carry a hash prefix.
fn parse_show(raw: &str) -> Result<IndexMap<String, RawShowDrv>, serde_json::Error> {
    let envelope: ShowEnvelope = serde_json::from_str(raw)?;
    match envelope.derivations {
        Some(drvs) => Ok(drvs),
        None => serde_json::from_str(raw),
    }
}

/// `derivation show` returns bare store-path BASENAMES as its keys and each
/// output's `path` (package.rs:249) — prefix them exactly once. Tolerates a
/// future nix returning full paths; never double-prefixes.
fn store_path(basename_or_path: &str) -> String {
    if basename_or_path.starts_with("/nix/store/") {
        basename_or_path.to_string()
    } else {
        format!("/nix/store/{basename_or_path}")
    }
}

/// Project one `derivation show -r` dump into a GraphData document.
///
/// `extracted_at` is injected rather than read from the clock so the output
/// is a pure function of the dump: byte-identical modulo extractedAt.
/// Tiers all start false — presence/sizes/dry-run are stamped on by the
/// extraction pipeline, not here.
pub fn project_graph(id: &str, raw_json: &str, extracted_at: &str) -> anyhow::Result<GraphData> {
    let drvs = parse_show(raw_json)
        .map_err(|e| anyhow::anyhow!("unparseable derivation show output: {e}"))?;
    anyhow::ensure!(!drvs.is_empty(), "derivation show returned no derivations");

    let mut warnings: Vec<String> = Vec::new();

    // Deterministic indices: sort by basename, which is sorting by drvPath.
    let mut basenames: Vec<&String> = drvs.keys().collect();
    basenames.sort();
    let index: HashMap<&str, u32> = basenames
        .iter()
        .enumerate()
        .map(|(i, k)| (k.as_str(), i as u32))
        .collect();

    let mut nodes: Vec<GraphNode> = Vec::with_capacity(basenames.len());
    let mut edges: Vec<Vec<u32>> = Vec::with_capacity(basenames.len());
    let mut output_path_count: u32 = 0;
    let mut unique_paths: HashSet<&str> = HashSet::new();

    for (i, basename) in basenames.iter().enumerate() {
        let d = &drvs[basename.as_str()];

        let outputs: Vec<GraphNodeOutput> = d
            .outputs
            .iter()
            .map(|(out_name, o)| {
                let path = o.path.as_deref().filter(|p| !p.is_empty()).map(store_path);
                if path.is_some() {
                    output_path_count += 1;
                    unique_paths.insert(o.path.as_deref().unwrap());
                }
                GraphNodeOutput {
                    name: out_name.clone(),
                    path,
                    present: None,
                    nar_size: None,
                    closure_size: None,
                }
            })
            .collect();

        // Same precedence as normalize_derivation_show: nested inputs.drvs
        // wins over flat inputDrvs when both exist.
        let nested = d.inputs.as_ref().and_then(|inp| inp.drvs.as_ref());
        let input_map = nested.or(d.input_drvs.as_ref());
        let mut deps: Vec<u32> = input_map
            .map(|m| {
                m.keys()
                    .filter_map(|dep| match index.get(dep.as_str()) {
                        Some(&j) if j as usize == i => {
                            warnings.push(format!("self-loop dropped: {basename}"));
                            None
                        }
                        Some(&j) => Some(j),
                        None => {
                            warnings.push(format!(
                                "dangling input of {basename}: {dep} not in the closure"
                            ));
                            None
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        deps.sort_unstable();
        deps.dedup();
        edges.push(deps);

        nodes.push(GraphNode {
            drv_path: store_path(basename),
            name: d
                .name
                .clone()
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| name_from_drv_basename(basename)),
            system: d.system.clone().filter(|s| !s.is_empty()),
            outputs,
        });
    }

    // The root of a single-installable `-r` closure is its unique node with
    // no incoming edge (the dump is a DAG, so one exists).
    let mut indegree = vec![0u32; nodes.len()];
    for deps in &edges {
        for &j in deps {
            indegree[j as usize] += 1;
        }
    }
    let roots: Vec<u32> = indegree
        .iter()
        .enumerate()
        .filter(|&(_, &d)| d == 0)
        .map(|(i, _)| i as u32)
        .collect();
    let root = match roots.as_slice() {
        [r] => *r,
        [] => {
            warnings.push("no in-degree-0 node (cycle?): using the first node as root".into());
            0
        }
        [first, ..] => {
            warnings.push(format!(
                "{} in-degree-0 nodes: using the first by drvPath as root",
                roots.len()
            ));
            *first
        }
    };

    let edge_count: u32 = edges.iter().map(|e| e.len() as u32).sum();
    Ok(GraphData {
        version: SCHEMA_VERSION,
        id: id.to_string(),
        root,
        extracted_at: extracted_at.to_string(),
        stats: GraphStats {
            node_count: nodes.len() as u32,
            edge_count,
            output_path_count,
            unique_output_path_count: unique_paths.len() as u32,
            absent_count: None,
            to_build_count: None,
            to_fetch_count: None,
            download_bytes: None,
            unpacked_bytes: None,
        },
        nodes,
        edges,
        tiers: GraphTiers {
            presence: false,
            sizes: false,
            dry_run: false,
            substituters: false,
        },
        dry_run: None,
        warnings,
    })
}

/// The distinct output paths of a graph, sorted — the batch fed to store
/// validity checks. Deduped because distinct outputs legitimately share a
/// path (56 measured on a real system graph), and sorted so batching is
/// deterministic.
pub fn unique_output_paths(g: &GraphData) -> Vec<String> {
    let mut paths: Vec<String> = g
        .nodes
        .iter()
        .flat_map(|n| n.outputs.iter().filter_map(|o| o.path.clone()))
        .collect();
    paths.sort_unstable();
    paths.dedup();
    paths
}

/// Stamp tier T1 onto a projected graph from the set of paths the store
/// reported INVALID. `present` means "valid in the local store at
/// extractedAt" — a snapshot, not a claim about what a build would do.
/// Pathless outputs (v4 fixed-output fetchers) stay untouched: the tier
/// structurally cannot cover them.
pub fn apply_presence(g: &mut GraphData, invalid: &std::collections::HashSet<String>) {
    let mut absent: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for n in &mut g.nodes {
        for o in &mut n.outputs {
            if let Some(p) = &o.path {
                o.present = Some(!invalid.contains(p));
            }
        }
    }
    for n in &g.nodes {
        for o in &n.outputs {
            if o.present == Some(false) {
                absent.insert(o.path.as_deref().unwrap_or_default());
            }
        }
    }
    g.stats.absent_count = Some(absent.len() as u32);
    g.tiers.presence = true;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TS: &str = "1970-01-01T00:00:00.000Z";

    fn hash(c: char) -> String {
        std::iter::repeat_n(c, 32).collect()
    }

    /// A small real-shaped closure: root depends on lib and src; lib depends
    /// on src. src is a fixed-output fetch (system "builtin", zero inputs);
    /// lib is multi-output.
    fn drv_bodies() -> Vec<(String, serde_json::Value)> {
        vec![
            (
                format!("{}-root-1.0.drv", hash('c')),
                json!({
                    "name": "root-1.0",
                    "system": "x86_64-linux",
                    "outputs": {"out": {"path": format!("{}-root-1.0", hash('f'))}},
                    "env": {"builder": "ignored"},
                    "inputs": [format!("{}-lib-2.0.drv", hash('a')), format!("{}-src.tar.gz.drv", hash('b'))],
                }),
            ),
            (
                format!("{}-lib-2.0.drv", hash('a')),
                json!({
                    "name": "lib-2.0",
                    "system": "x86_64-linux",
                    "outputs": {
                        "out": {"path": format!("{}-lib-2.0", hash('d'))},
                        "dev": {"path": format!("{}-lib-2.0-dev", hash('e'))},
                    },
                    "inputs": [format!("{}-src.tar.gz.drv", hash('b'))],
                }),
            ),
            (
                format!("{}-src.tar.gz.drv", hash('b')),
                json!({
                    "name": "src.tar.gz",
                    "system": "builtin",
                    "outputs": {"out": {"path": format!("{}-src.tar.gz", hash('9'))}},
                    "inputs": [],
                }),
            ),
        ]
    }

    /// The same closure in both envelope shapes `derivation show` emits.
    fn v4_doc() -> String {
        let mut drvs = serde_json::Map::new();
        for (basename, body) in drv_bodies() {
            let mut b = body.as_object().unwrap().clone();
            let inputs = b.remove("inputs").unwrap();
            let drv_map: serde_json::Map<String, serde_json::Value> = inputs
                .as_array()
                .unwrap()
                .iter()
                .map(|d| {
                    (
                        d.as_str().unwrap().to_string(),
                        json!({"dynamicOutputs": {}, "outputs": ["out"]}),
                    )
                })
                .collect();
            b.insert("inputs".into(), json!({"drvs": drv_map, "srcs": []}));
            drvs.insert(basename, serde_json::Value::Object(b));
        }
        json!({"version": 4, "derivations": drvs}).to_string()
    }

    fn flat_doc() -> String {
        let mut top = serde_json::Map::new();
        for (basename, body) in drv_bodies() {
            let mut b = body.as_object().unwrap().clone();
            let inputs = b.remove("inputs").unwrap();
            let drv_map: serde_json::Map<String, serde_json::Value> = inputs
                .as_array()
                .unwrap()
                .iter()
                .map(|d| (d.as_str().unwrap().to_string(), json!({"outputs": ["out"]})))
                .collect();
            b.insert("inputDrvs".into(), serde_json::Value::Object(drv_map));
            top.insert(basename, serde_json::Value::Object(b));
        }
        serde_json::Value::Object(top).to_string()
    }

    #[test]
    fn both_envelope_shapes_project_identically() {
        let a = project_graph("packages/x/y", &v4_doc(), TS).unwrap();
        let b = project_graph("packages/x/y", &flat_doc(), TS).unwrap();
        assert_eq!(
            serde_json::to_string(&a).unwrap(),
            serde_json::to_string(&b).unwrap()
        );
        assert_eq!(a.stats.node_count, 3);
        assert_eq!(a.stats.edge_count, 3);
    }

    /// THE prefix guard: every path in the document starts with /nix/store/
    /// and contains it exactly once — `derivation show` hands out bare
    /// basenames, and an unprefixed path makes downstream validity checks
    /// silently report nothing invalid.
    #[test]
    fn every_emitted_path_is_prefixed_exactly_once() {
        let g = project_graph("packages/x/y", &v4_doc(), TS).unwrap();
        let mut checked = 0;
        for n in &g.nodes {
            for p in std::iter::once(n.drv_path.as_str())
                .chain(n.outputs.iter().filter_map(|o| o.path.as_deref()))
            {
                assert_eq!(p.matches("/nix/store/").count(), 1, "bad path {p}");
                assert!(p.starts_with("/nix/store/"), "bad path {p}");
                checked += 1;
            }
        }
        assert_eq!(checked, 3 + 4); // 3 drvPaths + 4 output paths
    }

    /// A dump whose paths are already full must not get a second prefix.
    #[test]
    fn already_prefixed_paths_are_left_alone() {
        let doc = v4_doc().replace(
            &format!("\"{}-root-1.0\"", hash('f')),
            &format!("\"/nix/store/{}-root-1.0\"", hash('f')),
        );
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        let root_out = g
            .nodes
            .iter()
            .find(|n| n.name == "root-1.0")
            .unwrap()
            .outputs[0]
            .path
            .as_deref()
            .unwrap();
        assert_eq!(root_out.matches("/nix/store/").count(), 1);
    }

    #[test]
    fn edges_are_in_range_root_reaches_all_nodes() {
        let g = project_graph("packages/x/y", &v4_doc(), TS).unwrap();
        assert_eq!(g.edges.len(), g.nodes.len());
        for deps in &g.edges {
            for &j in deps {
                assert!((j as usize) < g.nodes.len(), "edge index {j} out of range");
            }
        }
        // BFS with a visited set (fan-in is heavy in real graphs).
        let mut seen = vec![false; g.nodes.len()];
        let mut queue = std::collections::VecDeque::from([g.root]);
        seen[g.root as usize] = true;
        while let Some(i) = queue.pop_front() {
            for &j in &g.edges[i as usize] {
                if !seen[j as usize] {
                    seen[j as usize] = true;
                    queue.push_back(j);
                }
            }
        }
        assert!(seen.iter().all(|&s| s), "unreachable nodes: {seen:?}");
        // And the root really is the top: it's root-1.0, not an input.
        assert_eq!(g.nodes[g.root as usize].name, "root-1.0");
    }

    /// v4 emits fixed-output fetcher outputs as `{hash, method}` with NO
    /// `path` key (8,632 of 25,568 entries on a real system graph): the
    /// output stays pathless, is excluded from the path counts, and can never
    /// carry a presence flag.
    #[test]
    fn v4_pathless_fetcher_output_stays_pathless() {
        let doc = json!({"version": 4, "derivations": {
            format!("{}-src.tar.gz.drv", hash('b')): {
                "name": "src.tar.gz", "system": "builtin",
                "outputs": {"out": {"hash": "sha256-xGjB6KPPoegFMcxRmokPhVhphnIdjjBfg0Zcw2u4Jgg=", "method": "flat"}},
                "inputs": {"drvs": {}, "srcs": []},
            },
        }})
        .to_string();
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        assert_eq!(g.nodes[0].outputs[0].path, None);
        assert_eq!(g.nodes[0].outputs[0].present, None);
        assert_eq!(g.stats.output_path_count, 0);
        assert_eq!(g.stats.unique_output_path_count, 0);
    }

    #[test]
    fn duplicate_output_paths_count_once_in_unique() {
        // Two drvs landing on the SAME output path — rare but real
        // (56 true duplicates measured on a real system graph).
        let shared = format!("{}-shared-src", hash('5'));
        let doc = json!({"version": 4, "derivations": {
            format!("{}-fetch-a.drv", hash('1')): {
                "name": "fetch-a", "system": "builtin",
                "outputs": {"out": {"path": shared}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-fetch-b.drv", hash('2')): {
                "name": "fetch-b", "system": "builtin",
                "outputs": {"out": {"path": shared}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-top.drv", hash('3')): {
                "name": "top", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-top", hash('4'))}},
                "inputs": {"drvs": {
                    format!("{}-fetch-a.drv", hash('1')): {"outputs": ["out"]},
                    format!("{}-fetch-b.drv", hash('2')): {"outputs": ["out"]},
                }, "srcs": []},
            },
        }})
        .to_string();
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        assert_eq!(g.stats.output_path_count, 3);
        assert_eq!(g.stats.unique_output_path_count, 2);
    }

    #[test]
    fn self_loops_and_dangling_inputs_are_dropped_with_warnings() {
        let doc = json!({"version": 4, "derivations": {
            format!("{}-selfy.drv", hash('7')): {
                "name": "selfy", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-selfy", hash('8'))}},
                "inputs": {"drvs": {
                    format!("{}-selfy.drv", hash('7')): {"outputs": ["out"]},
                    format!("{}-gone.drv", hash('6')): {"outputs": ["out"]},
                }, "srcs": []},
            },
        }})
        .to_string();
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        assert_eq!(g.edges, vec![Vec::<u32>::new()]);
        assert!(g.warnings.iter().any(|w| w.contains("self-loop")));
        assert!(g.warnings.iter().any(|w| w.contains("dangling input")));
    }

    /// Missing `name` (old nix has no name field) falls back to parsing the
    /// basename; a node with no static output path stays path-less.
    #[test]
    fn old_shape_details_degrade_cleanly() {
        let doc = json!({
            format!("{}-noname-3.1.drv", hash('a')): {
                "system": "x86_64-linux",
                "outputs": {"out": {}},
                "inputDrvs": {},
            },
        })
        .to_string();
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        assert_eq!(g.nodes[0].name, "noname-3.1");
        assert_eq!(g.nodes[0].outputs[0].path, None);
        assert_eq!(g.stats.output_path_count, 0);
    }

    /// extractedAt is the ONE volatile field: same dump + same timestamp →
    /// identical bytes; a different timestamp changes nothing else.
    #[test]
    fn deterministic_modulo_extracted_at() {
        let a = serde_json::to_string(&project_graph("p", &v4_doc(), TS).unwrap()).unwrap();
        let b = serde_json::to_string(&project_graph("p", &v4_doc(), TS).unwrap()).unwrap();
        assert_eq!(a, b);

        let c = project_graph("p", &v4_doc(), "2026-07-28T00:00:00.000Z").unwrap();
        let mut cv = serde_json::to_value(&c).unwrap();
        cv["extractedAt"] = serde_json::json!(TS);
        assert_eq!(
            serde_json::to_value(serde_json::from_str::<GraphData>(&a).unwrap()).unwrap(),
            cv
        );
    }

    /// Presence semantics end to end on a projected graph: flags stamped per
    /// path-bearing output, pathless outputs untouched, absentCount over
    /// UNIQUE paths, tier flipped on.
    #[test]
    fn presence_stamps_paths_skips_pathless_counts_unique() {
        let shared = format!("{}-shared-src", hash('5'));
        let doc = json!({"version": 4, "derivations": {
            format!("{}-fetch-a.drv", hash('1')): {
                "name": "fetch-a", "system": "builtin",
                "outputs": {"out": {"path": shared}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-fetch-b.drv", hash('2')): {
                "name": "fetch-b", "system": "builtin",
                "outputs": {"out": {"path": shared}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-pathless.drv", hash('9')): {
                "name": "pathless", "system": "builtin",
                "outputs": {"out": {"hash": "sha256-0000", "method": "flat"}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-top.drv", hash('3')): {
                "name": "top", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-top", hash('4'))}},
                "inputs": {"drvs": {
                    format!("{}-fetch-a.drv", hash('1')): {"outputs": ["out"]},
                    format!("{}-fetch-b.drv", hash('2')): {"outputs": ["out"]},
                    format!("{}-pathless.drv", hash('9')): {"outputs": ["out"]},
                }, "srcs": []},
            },
        }})
        .to_string();
        let mut g = project_graph("packages/x/y", &doc, TS).unwrap();

        let paths = unique_output_paths(&g);
        assert_eq!(paths.len(), 2, "deduped: shared-src once + top");
        assert!(paths.iter().all(|p| p.starts_with("/nix/store/")));

        // The shared fetch path is absent; top's output is valid.
        let invalid: std::collections::HashSet<String> =
            [format!("/nix/store/{}-shared-src", hash('5'))].into();
        apply_presence(&mut g, &invalid);

        assert!(g.tiers.presence);
        // Two output ENTRIES are absent but they are ONE path.
        assert_eq!(g.stats.absent_count, Some(1));
        let by_name = |name: &str| g.nodes.iter().find(|n| n.name == name).unwrap();
        assert_eq!(by_name("fetch-a").outputs[0].present, Some(false));
        assert_eq!(by_name("fetch-b").outputs[0].present, Some(false));
        assert_eq!(by_name("top").outputs[0].present, Some(true));
        assert_eq!(
            by_name("pathless").outputs[0].present,
            None,
            "the tier cannot cover a pathless fetcher output"
        );
    }

    #[test]
    fn garbage_and_empty_inputs_error() {
        assert!(project_graph("p", "not json", TS).is_err());
        assert!(project_graph("p", r#"{"version":4,"derivations":{}}"#, TS).is_err());
    }
}
