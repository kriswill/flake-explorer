// Projection of `nix derivation show -r` output into a GraphData document.
//
// The raw dump is big — 71.7 MB for a real system graph, most of it `env`
// blobs — so it is NEVER parsed as serde_json::Value (measured 470 MB peak
// RSS against 127 MB for the typed structs here, which skip `env`/`args`
// entirely). Projection only; enrichment tiers are stamped on afterwards.

use crate::package::name_from_drv_basename;
use crate::run_nix::{attr_selector, check_validity_invalid, derivation_show_recursive};
use crate::schema::*;
use indexmap::IndexMap;
use serde::Deserialize;
use serde::de::IgnoredAny;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

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

/// Stamp tier T2 (sizes) from a `path-info` answer map. Present paths only:
/// a path that is absent (or was not asked about) keeps its sizes ABSENT —
/// the UI must render "not collected", never zero.
pub fn apply_sizes(
    g: &mut GraphData,
    info: &std::collections::HashMap<String, Option<crate::run_nix::PathInfoRaw>>,
) {
    for n in &mut g.nodes {
        for o in &mut n.outputs {
            if o.present != Some(true) {
                continue;
            }
            let Some(p) = &o.path else { continue };
            if let Some(Some(i)) = info.get(p) {
                o.nar_size = Some(i.nar_size);
                o.closure_size = i.closure_size;
            }
        }
    }
    g.tiers.sizes = true;
}

// ------------------------------------------------------------- dry-run (T3)

/// The exact partition `nix build --dry-run` reported. Both lists empty is a
/// legal, meaningful answer: the closure is satisfied locally.
#[derive(Debug, Default, PartialEq)]
pub struct DryRunPartition {
    pub to_build: Vec<String>,
    pub to_fetch: Vec<String>,
    pub download_bytes: Option<u64>,
    pub unpacked_bytes: Option<u64>,
}

/// "9.6 MiB" → bytes. Unknown unit → None (the header then parses without
/// sizes rather than inventing numbers).
fn parse_size(s: &str) -> Option<u64> {
    let (num, unit) = s.trim().split_once(' ')?;
    let v: f64 = num.parse().ok()?;
    let mul: f64 = match unit {
        "B" => 1.0,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0f64.powi(4),
        _ => return None,
    };
    Some((v * mul).round() as u64)
}

/// Defensive parse of `nix build --dry-run` stderr. The output is PROSE, not
/// a contract (version-sensitive, localizable in principle), so the rules
/// are explicit about what degrades and what fails:
///
/// - `None` = unparseable — the tier must be reported ABSENT.
/// - `Some(default)` = a satisfied closure: dry-run printed no partition at
///   all (verified live: a valid root emits zero build/fetch lines). This is
///   tier-PRESENT with zero work, distinct from failure.
/// - `warning:` lines and other noise are ignored, EXCEPT lines containing
///   "will be" that match no known sentence — a changed load-bearing
///   sentence must fail the parse, not silently produce an empty partition.
/// - A section's item count must equal the number its header stated.
pub fn parse_dry_run_stderr(stderr: &str) -> Option<DryRunPartition> {
    let built_re =
        regex::Regex::new(r"^(?:these (\d+) derivations|this derivation) will be built:$").unwrap();
    let fetch_re = regex::Regex::new(
        r"^(?:these (\d+) paths|this path) will be fetched(?: \(([^)]+) download, ([^)]+) unpacked\))?:$",
    )
    .unwrap();

    let mut p = DryRunPartition::default();
    let mut lines = stderr.lines().peekable();
    let mut saw_built = false;
    let mut saw_fetch = false;
    while let Some(line) = lines.next() {
        let take_items = |lines: &mut std::iter::Peekable<std::str::Lines>| {
            let mut items = Vec::new();
            while let Some(next) = lines.peek() {
                let t = next.trim_start();
                if next.starts_with(' ') && t.starts_with("/nix/store/") {
                    items.push(t.to_string());
                    lines.next();
                } else {
                    break;
                }
            }
            items
        };
        if let Some(c) = built_re.captures(line) {
            if saw_built {
                return None; // two build sections is not a shape we know
            }
            saw_built = true;
            let stated: usize = c.get(1).map_or(Some(1), |m| m.as_str().parse().ok())?;
            p.to_build = take_items(&mut lines);
            if p.to_build.len() != stated {
                return None;
            }
        } else if let Some(c) = fetch_re.captures(line) {
            if saw_fetch {
                return None;
            }
            saw_fetch = true;
            let stated: usize = c.get(1).map_or(Some(1), |m| m.as_str().parse().ok())?;
            p.download_bytes = c.get(2).and_then(|m| parse_size(m.as_str()));
            p.unpacked_bytes = c.get(3).and_then(|m| parse_size(m.as_str()));
            p.to_fetch = take_items(&mut lines);
            if p.to_fetch.len() != stated {
                return None;
            }
        } else if line.contains("will be") {
            return None;
        }
    }
    Some(p)
}

/// Stamp tier T3 onto the graph. Fetch paths stay path-strings (they can
/// name outputs of nodes we have, or paths outside every node); build items
/// map onto node indices by drvPath, with a warning if any don't resolve.
pub fn apply_dry_run(g: &mut GraphData, p: &DryRunPartition) {
    let index: HashMap<&str, u32> = g
        .nodes
        .iter()
        .enumerate()
        .map(|(i, n)| (n.drv_path.as_str(), i as u32))
        .collect();
    let mut to_build_nodes: Vec<u32> = Vec::new();
    let mut unknown = 0usize;
    for drv in &p.to_build {
        match index.get(drv.as_str()) {
            Some(&i) => to_build_nodes.push(i),
            None => unknown += 1,
        }
    }
    if unknown > 0 {
        g.warnings.push(format!(
            "dry-run named {unknown} derivation(s) outside the graph"
        ));
    }
    to_build_nodes.sort_unstable();
    g.stats.to_build_count = Some(p.to_build.len() as u32);
    g.stats.to_fetch_count = Some(p.to_fetch.len() as u32);
    g.stats.download_bytes = p.download_bytes;
    g.stats.unpacked_bytes = p.unpacked_bytes;
    g.dry_run = Some(GraphDryRun {
        to_build_nodes,
        to_fetch_paths: p.to_fetch.clone(),
    });
    g.tiers.dry_run = true;
}

pub struct GraphResult {
    pub data: GraphData,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

/// One installable's dependency graph: instantiate the closure
/// (`derivation show -r`, never builds), project it, stamp T1 presence and
/// T2 sizes, and — opt-in — the T3 dry-run partition. Every tier failure
/// degrades to tier-absent with a warning — structure alone is still a
/// useful document.
pub async fn extract_graph(
    flake_ref: &str,
    id: &str,
    path: &[String],
    dry_run_tier: bool,
    timeout: Duration,
) -> anyhow::Result<GraphResult> {
    let start = Instant::now();
    let installable = format!("{flake_ref}#{}", attr_selector(path));
    let raw = derivation_show_recursive(&installable, timeout).await?;
    let mut data = project_graph(id, &raw, &crate::manifest::now_iso())?;

    let paths = unique_output_paths(&data);
    match check_validity_invalid(&paths, timeout).await {
        Ok(invalid) => {
            apply_presence(&mut data, &invalid);
            // T2 rides on T1: sizes only exist for paths T1 proved present.
            let present: Vec<String> = paths
                .iter()
                .filter(|p| !invalid.contains(p.as_str()))
                .cloned()
                .collect();
            match crate::run_nix::path_info_batch(&present, timeout).await {
                Ok(info) => apply_sizes(&mut data, &info),
                Err(e) => data.warnings.push(format!(
                    "{id}: size tier unavailable: {}",
                    e.to_string().lines().next().unwrap_or("")
                )),
            }
        }
        Err(e) => data.warnings.push(format!(
            "{id}: presence tier unavailable: {}",
            e.to_string().lines().next().unwrap_or("")
        )),
    }

    // T3 costs a second full eval (~8 s on a system graph) — only on request,
    // and its stderr is prose: a parse failure leaves the tier absent, never
    // fails the extraction (an empty partition, by contrast, is a real
    // answer: nothing to build, nothing to fetch).
    if dry_run_tier {
        match crate::run_nix::build_dry_run(&installable, timeout).await {
            Ok(stderr) => match parse_dry_run_stderr(&stderr) {
                Some(p) => apply_dry_run(&mut data, &p),
                None => data
                    .warnings
                    .push(format!("{id}: dry-run output not understood; tier skipped")),
            },
            Err(e) => data.warnings.push(format!(
                "{id}: dry-run tier unavailable: {}",
                e.to_string().lines().next().unwrap_or("")
            )),
        }
    }

    let warnings = data.warnings.clone();
    Ok(GraphResult {
        data,
        warnings,
        duration_ms: start.elapsed().as_millis() as u64,
    })
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

    /// A dump with TWO in-degree-0 nodes (should not happen for a single
    /// installable, but the code must not pick silently): deterministic pick
    /// of the first by drvPath, plus a warning saying so.
    #[test]
    fn multiple_roots_warn_and_pick_first_by_drv_path() {
        let doc = json!({"version": 4, "derivations": {
            format!("{}-zeta.drv", hash('9')): {
                "name": "zeta", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-zeta", hash('8'))}},
                "inputs": {"drvs": {
                    format!("{}-shared.drv", hash('5')): {"outputs": ["out"]},
                }, "srcs": []},
            },
            format!("{}-alpha.drv", hash('1')): {
                "name": "alpha", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-alpha", hash('2'))}},
                "inputs": {"drvs": {
                    format!("{}-shared.drv", hash('5')): {"outputs": ["out"]},
                }, "srcs": []},
            },
            format!("{}-shared.drv", hash('5')): {
                "name": "shared", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-shared", hash('6'))}},
                "inputs": {"drvs": {}, "srcs": []},
            },
        }})
        .to_string();
        let g = project_graph("packages/x/y", &doc, TS).unwrap();
        // alpha's drv basename (hash '1') sorts before zeta's (hash '9').
        assert_eq!(g.nodes[g.root as usize].name, "alpha");
        assert!(
            g.warnings.iter().any(|w| w.contains("2 in-degree-0 nodes")),
            "warnings: {:?}",
            g.warnings
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

    /// Line-for-line the shape a real `nix build --dry-run` emitted on
    /// 2026-07-28 (headers' counts adjusted to the trimmed lists).
    const DRY_RICH: &str = "\
warning: Git tree '/home/k/dotfiles' has uncommitted changes
these 3 derivations will be built:
  /nix/store/0fw6dhyv9njill1l2d5xlas98zvchfbj-config.ini.drv
  /nix/store/6s9aivjsvrl2awb2m86k5mqs7m6kdqsn-xwayland-24.1.13.drv
  /nix/store/a2k6gh6v8kizv0g984xp3hamdm5g4hwz-vi--nvim.drv
these 2 paths will be fetched (9.6 MiB download, 15.2 GiB unpacked):
  /nix/store/xidh3mfk8440irr3mvx65f353msqqpia-1password-8.12.28
  /nix/store/8klgpwdz7zf3jzaj5smslmv1p4wyyw95-50-coredump.conf
";

    #[test]
    fn dry_run_rich_output_parses_exactly() {
        let p = parse_dry_run_stderr(DRY_RICH).unwrap();
        assert_eq!(p.to_build.len(), 3);
        assert_eq!(
            p.to_build[0],
            "/nix/store/0fw6dhyv9njill1l2d5xlas98zvchfbj-config.ini.drv"
        );
        assert_eq!(p.to_fetch.len(), 2);
        assert_eq!(
            p.download_bytes,
            Some((9.6f64 * 1024.0 * 1024.0).round() as u64)
        );
        assert_eq!(
            p.unpacked_bytes,
            Some((15.2f64 * 1024.0 * 1024.0 * 1024.0).round() as u64)
        );
    }

    /// K0 finding (validator): a satisfied closure emits NO partition lines
    /// at all. That parses as an EMPTY partition — tier present with zero
    /// work — never as a failure.
    #[test]
    fn dry_run_empty_output_is_a_real_empty_partition() {
        let p =
            parse_dry_run_stderr("warning: Git tree '/home/k/dotfiles' has uncommitted changes\n")
                .unwrap();
        assert_eq!(p, DryRunPartition::default());
        // And stamping it marks the tier PRESENT with zeros, not absent.
        let doc = json!({"version": 4, "derivations": {
            format!("{}-a.drv", hash('1')): {
                "name": "a", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-a", hash('2'))}},
                "inputs": {"drvs": {}, "srcs": []},
            },
        }})
        .to_string();
        let mut g = project_graph("p", &doc, TS).unwrap();
        apply_dry_run(&mut g, &p);
        assert!(g.tiers.dry_run);
        assert_eq!(g.stats.to_build_count, Some(0));
        assert_eq!(g.stats.to_fetch_count, Some(0));
    }

    #[test]
    fn dry_run_singular_sentences_parse() {
        let p = parse_dry_run_stderr(
            "this derivation will be built:\n  /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-x.drv\n\
             this path will be fetched (1.0 KiB download, 2 B unpacked):\n  /nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-y\n",
        )
        .unwrap();
        assert_eq!(p.to_build.len(), 1);
        assert_eq!(p.to_fetch.len(), 1);
        assert_eq!(p.download_bytes, Some(1024));
        assert_eq!(p.unpacked_bytes, Some(2));
    }

    /// Deliberately unparseable variants → None (tier degrades), each for a
    /// different reason: count mismatch, and a changed load-bearing sentence.
    #[test]
    fn dry_run_unparseable_variants_fail_the_parse() {
        // Header says 5, list has 2.
        assert!(parse_dry_run_stderr(
            "these 5 derivations will be built:\n  /nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-x.drv\n  /nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-y.drv\n"
        )
        .is_none());
        // A "will be" sentence we do not know must NOT read as "nothing to do".
        assert!(parse_dry_run_stderr("these 3 store paths will be copied:\n").is_none());
        // A malformed size clause degrades sizes but not the partition.
        let p = parse_dry_run_stderr(
            "these 1 paths will be fetched (lots download, plenty unpacked):\n  /nix/store/cccccccccccccccccccccccccccccccc-z\n",
        )
        .unwrap();
        assert_eq!(p.to_fetch.len(), 1);
        assert_eq!(p.download_bytes, None);
    }

    /// T2 semantics: sizes land only on outputs T1 proved present; an absent
    /// output never gets a size even if path-info answered for its path, and
    /// a present path with no answer stays "not collected".
    #[test]
    fn sizes_stamp_only_present_outputs() {
        let doc = json!({"version": 4, "derivations": {
            format!("{}-a.drv", hash('1')): {
                "name": "a", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-a", hash('2'))}},
                "inputs": {"drvs": {
                    format!("{}-b.drv", hash('3')): {"outputs": ["out"]},
                    format!("{}-c.drv", hash('5')): {"outputs": ["out"]},
                }, "srcs": []},
            },
            format!("{}-b.drv", hash('3')): {
                "name": "b", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-b", hash('4'))}},
                "inputs": {"drvs": {}, "srcs": []},
            },
            format!("{}-c.drv", hash('5')): {
                "name": "c", "system": "x86_64-linux",
                "outputs": {"out": {"path": format!("{}-c", hash('6'))}},
                "inputs": {"drvs": {}, "srcs": []},
            },
        }})
        .to_string();
        let mut g = project_graph("packages/x/y", &doc, TS).unwrap();
        let absent_b: std::collections::HashSet<String> =
            [format!("/nix/store/{}-b", hash('4'))].into();
        apply_presence(&mut g, &absent_b);

        let info: std::collections::HashMap<String, Option<crate::run_nix::PathInfoRaw>> = [
            // b is ABSENT — an answer for it must be ignored.
            (
                format!("/nix/store/{}-b", hash('4')),
                Some(crate::run_nix::PathInfoRaw {
                    nar_size: 111,
                    closure_size: Some(222),
                    references: vec![],
                }),
            ),
            (
                format!("/nix/store/{}-a", hash('2')),
                Some(crate::run_nix::PathInfoRaw {
                    nar_size: 1000,
                    closure_size: Some(5000),
                    references: vec![],
                }),
            ),
            // c is present but path-info said null: stays not-collected.
            (format!("/nix/store/{}-c", hash('6')), None),
        ]
        .into();
        apply_sizes(&mut g, &info);

        assert!(g.tiers.sizes);
        let by_name = |name: &str| g.nodes.iter().find(|n| n.name == name).unwrap();
        assert_eq!(by_name("a").outputs[0].nar_size, Some(1000));
        assert_eq!(by_name("a").outputs[0].closure_size, Some(5000));
        assert_eq!(
            by_name("b").outputs[0].nar_size,
            None,
            "absent stays sizeless"
        );
        assert_eq!(
            by_name("c").outputs[0].nar_size,
            None,
            "no answer stays absent"
        );
    }

    #[test]
    fn garbage_and_empty_inputs_error() {
        assert!(project_graph("p", "not json", TS).is_err());
        assert!(project_graph("p", r#"{"version":4,"derivations":{}}"#, TS).is_err());
    }
}
