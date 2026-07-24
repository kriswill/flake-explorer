// Cheap manifest pass — port of src/extract/manifest.ts: flake metadata +
// outputs tree + file list + import graph + git info. Always regenerated;
// the expensive per-configuration options blobs are extracted separately.

use crate::git::{last_commits, repo_prefix};
use crate::run_nix::{
    eval_extract, flake_metadata, flake_show, ExtractArgs, FlakeMetadataJson, InputsTreeNode,
    LockInputRef, LockNode, ManifestEval, NixError,
};
use crate::scan::{canonical_input_names, import_graph, scan_input_refs, scan_overlay_defs};
use crate::schema::*;
use indexmap::IndexMap;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::time::Duration;

pub struct ManifestOptions {
    pub all_systems: bool,
    pub timeout: Duration,
}

pub const FINGERPRINT: &str = env!("FLAKE_EXPLORER_FINGERPRINT");

pub async fn build_manifest(flake_ref: &str, opts: &ManifestOptions) -> anyhow::Result<Manifest> {
    let mut warnings: Vec<String> = Vec::new();
    let timeout = opts.timeout;

    let meta = flake_metadata(flake_ref, timeout).await?;
    let local_checkout = detect_local_checkout(flake_ref, &meta);

    let (show_json, ev) = tokio::join!(
        flake_show(flake_ref, opts.all_systems, timeout),
        manifest_eval(flake_ref, timeout)
    );
    let show_json = match show_json {
        Ok(v) => Some(v),
        Err(e) => {
            warnings.push(format!(
                "nix flake show failed: {}",
                e.to_string().lines().next().unwrap_or("")
            ));
            None
        }
    };
    let (ev, eval_warning) = ev?;
    if let Some(w) = eval_warning {
        warnings.push(w);
    }

    let mut input_follows: Vec<InputFollow> = Vec::new();
    let inputs = input_infos(&meta, &ev, &mut warnings, &mut input_follows);
    let files = file_entries(&ev, local_checkout.as_deref(), &mut warnings).await;
    let self_files: Vec<String> = files
        .iter()
        .filter(|f| matches!(f.origin, FileOrigin::SelfOrigin))
        .map(|f| f.rel_path.clone())
        .collect();

    let self_root = ev.self_path.clone();
    let read = move |rel: &str| -> Option<String> {
        std::fs::read_to_string(format!("{self_root}/{rel}")).ok()
    };
    let self_id = |rel: &str| make_file_id_self(rel);

    let import_edges = import_graph(&self_files, &read, &self_id);
    let input_refs = scan_input_refs(&self_files, &canonical_input_names(&inputs), &read, &self_id);
    let overlay_defs = scan_overlay_defs(&self_files, &read, &self_id);

    let outputs = match show_json {
        Some(j) => normalize_show(&j),
        None => OutputNode::Attrset { children: IndexMap::new() },
    };
    let packages = package_refs(&outputs);

    Ok(Manifest {
        version: SCHEMA_VERSION,
        generated_at: now_iso(),
        extractor: FINGERPRINT.to_string(),
        flake: FlakeInfo {
            r#ref: flake_ref.to_string(),
            path: ev.self_path.clone(),
            description: meta.description.clone().or(ev.description.clone()),
            rev: meta.revision.clone(),
            nar_hash: meta.locked.as_ref().and_then(|l| l.nar_hash.clone()),
        },
        outputs,
        inputs,
        files,
        import_edges,
        input_refs,
        overlay_defs: Some(overlay_defs),
        input_follows,
        configurations: ev
            .configurations
            .iter()
            .map(|c| ConfigRef {
                id: format!("{}/{}", c.kind.as_str(), c.n),
                kind: c.kind,
                name: c.n.clone(),
                data_file: format!("config/{}.{}.json", c.kind.as_str(), safe_name(&c.n)),
                status: RefStatus::Pending,
                error: None,
                extracted_at: None,
                option_count: None,
                duration_ms: None,
            })
            .collect(),
        packages,
        package_reverse_deps: None,
        grafts: ev.grafts.clone(),
        output_names: ev.output_names.clone(),
        warnings,
    })
}

pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The manifest eval, with one degradation step: an unresolvable TRANSITIVE
/// input aborts the eval from below the Nix exception layer, so fall back to
/// a direct-inputs-only walk (inputsDepth: 0) and warn.
async fn manifest_eval(
    flake_ref: &str,
    timeout: Duration,
) -> Result<(ManifestEval, Option<String>), NixError> {
    let args = ExtractArgs { flake_ref: flake_ref.to_string(), mode: "manifest", ..Default::default() };
    match eval_extract::<ManifestEval>(&args, timeout).await {
        Ok(ev) => Ok((ev, None)),
        Err(e) => {
            let first = e
                .to_string()
                .lines()
                .find(|l| l.contains("error:"))
                .unwrap_or("eval failed")
                .trim()
                .to_string();
            let shallow = eval_extract::<ManifestEval>(
                &ExtractArgs { inputs_depth: Some(0), ..args },
                timeout,
            )
            .await?;
            Ok((
                shallow,
                Some(format!(
                    "transitive inputs could not be resolved, so only direct inputs are listed — {first}"
                )),
            ))
        }
    }
}

/// Derivation-typed outputs (packages, devShells, checks, formatter),
/// enumerated straight from the normalized outputs tree.
pub fn package_refs(outputs: &OutputNode) -> Vec<PackageRef> {
    let mut refs = Vec::new();
    let OutputNode::Attrset { children } = outputs else { return refs };

    for category in ["packages", "devShells", "checks"] {
        let Some(OutputNode::Attrset { children: systems }) = children.get(category) else {
            continue;
        };
        for (system, sys_node) in systems {
            let OutputNode::Attrset { children: names } = sys_node else { continue };
            for (name, leaf) in names {
                if matches!(leaf, OutputNode::Leaf { .. }) {
                    refs.push(make_package_ref(vec![
                        category.to_string(),
                        system.clone(),
                        name.clone(),
                    ]));
                }
            }
        }
    }

    if let Some(OutputNode::Attrset { children: systems }) = children.get("formatter") {
        for (system, leaf) in systems {
            if matches!(leaf, OutputNode::Leaf { .. }) {
                refs.push(make_package_ref(vec!["formatter".to_string(), system.clone()]));
            }
        }
    }
    refs
}

fn make_package_ref(path: Vec<String>) -> PackageRef {
    PackageRef {
        id: path.join("/"),
        data_file: format!(
            "package/{}.json",
            path.iter().map(|s| safe_name(s)).collect::<Vec<_>>().join(".")
        ),
        path,
        status: RefStatus::Pending,
        error: None,
        extracted_at: None,
        duration_ms: None,
    }
}

/// Config names are arbitrary Nix attr names — anything that could escape the
/// data dir becomes a slug plus a short collision hash. "%" is excluded from
/// the passthrough charset (see manifest.ts for the traversal rationale).
pub fn safe_name(name: &str) -> String {
    let ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '+' | '.' | '-'));
    if ok && !name.is_empty() {
        return name.to_string();
    }
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '@' | '+' | '.' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let digest = Sha256::digest(name.as_bytes());
    let n = u64::from_be_bytes(digest[..8].try_into().unwrap());
    format!("{slug}-{}", to_base36(n).chars().take(8).collect::<String>())
}

fn to_base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

/// Existing local directory of a path-like flakeref (`path:` prefix and
/// ?query stripped), or None.
pub fn local_flake_dir(r#ref: &str) -> Option<String> {
    let bare = r#ref.strip_prefix("path:").unwrap_or(r#ref);
    let bare = bare.split('?').next().unwrap_or(bare);
    if (bare.starts_with('/') || bare.starts_with('.')) && Path::new(bare).is_dir() {
        Some(bare.to_string())
    } else {
        None
    }
}

/// A path-like flakeref (possibly `path:`-prefixed) that exists locally.
fn detect_local_checkout(flake_ref: &str, meta: &FlakeMetadataJson) -> Option<String> {
    if let Some(dir) = local_flake_dir(flake_ref) {
        return std::fs::canonicalize(&dir)
            .map(|p| p.to_string_lossy().into_owned())
            .ok()
            .or(Some(dir));
    }
    let resolved = meta.resolved_url.as_deref()?;
    let rest = resolved
        .strip_prefix("path:")
        .or_else(|| resolved.strip_prefix("git+file://"))?;
    let path = rest.split('?').next().unwrap_or(rest);
    Path::new(path).exists().then(|| path.to_string())
}

/// Flatten the recursive inputs tree (eval side: store paths) against the
/// lock graph (metadata side: provenance), breadth-first — see manifest.ts
/// for the full dedup/alias-merge rationale.
pub fn input_infos(
    meta: &FlakeMetadataJson,
    ev: &ManifestEval,
    warnings: &mut Vec<String>,
    follow_edges: &mut Vec<InputFollow>,
) -> IndexMap<String, InputInfo> {
    let mut out: IndexMap<String, InputInfo> = IndexMap::new();
    let mut seen_nodes: HashSet<String> = HashSet::new();
    let mut name_by_node: HashMap<String, String> = HashMap::new();

    struct Item<'a> {
        name: String,
        node_key: Option<String>,
        ev_node: Option<&'a InputsTreeNode>,
        depth: u32,
        follows: Option<String>,
        aliases: Option<Vec<String>>,
    }

    let mut queue: VecDeque<Item> = VecDeque::new();
    let empty = LockNode::default();
    let root_node = meta.locks.nodes.get(&meta.locks.root).unwrap_or(&empty);

    // Group root inputs by resolved lock node before queueing, so aliases
    // merge deterministically. Unresolvable refs stay ungrouped.
    struct RootEntry<'a> {
        name: &'a str,
        r#ref: &'a LockInputRef,
    }
    let mut by_node: IndexMap<String, Vec<RootEntry>> = IndexMap::new();
    if let Some(root_inputs) = &root_node.inputs {
        for (name, r#ref) in root_inputs {
            let node_key = match r#ref {
                LockInputRef::Key(k) => Some(k.clone()),
                LockInputRef::Follows(path) => resolve_follows(meta, path),
            };
            match node_key {
                None => queue.push_back(Item {
                    name: name.clone(),
                    node_key: None,
                    ev_node: ev.inputs.get(name),
                    depth: 0,
                    follows: None,
                    aliases: None,
                }),
                Some(k) => by_node.entry(k).or_default().push(RootEntry { name, r#ref }),
            }
        }
    }
    for (node_key, group) in &by_node {
        // The real (non-follows) input names the entry; follows-only groups
        // fall back to their first name.
        let primary_idx = group
            .iter()
            .position(|e| matches!(e.r#ref, LockInputRef::Key(_)))
            .unwrap_or(0);
        let primary = &group[primary_idx];
        let mut aliases: Vec<String> = group
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != primary_idx)
            .map(|(_, e)| e.name.to_string())
            .collect();
        aliases.sort();
        // Same store path either way; prefer the primary's eval node.
        let ev_node = std::iter::once(primary)
            .chain(group.iter().enumerate().filter(|(i, _)| *i != primary_idx).map(|(_, e)| e))
            .find_map(|e| ev.inputs.get(e.name));
        queue.push_back(Item {
            name: primary.name.to_string(),
            node_key: Some(node_key.clone()),
            ev_node,
            depth: 0,
            follows: match primary.r#ref {
                LockInputRef::Follows(p) => Some(p.join("/")),
                LockInputRef::Key(_) => None,
            },
            aliases: (!aliases.is_empty()).then_some(aliases),
        });
    }

    while let Some(item) = queue.pop_front() {
        let node = item.node_key.as_ref().and_then(|k| meta.locks.nodes.get(k));
        let Some(node) = node else {
            if item.depth == 0 {
                warnings.push(format!("flake.lock: could not resolve input \"{}\"", item.name));
            }
            continue;
        };
        let node_key = item.node_key.clone().unwrap();
        if seen_nodes.contains(&node_key) {
            // The node already has an entry under another name — record the
            // edge the dedup would otherwise silently drop.
            if let Some(target) = name_by_node.get(&node_key) {
                follow_edges.push(InputFollow { name: item.name.clone(), target: target.clone() });
            }
            continue;
        }
        seen_nodes.insert(node_key.clone());
        name_by_node.insert(node_key.clone(), item.name.clone());

        let locked = node.locked.as_ref();
        out.insert(
            item.name.clone(),
            InputInfo {
                name: item.name.clone(),
                node_key: node_key.clone(),
                transitive: (item.depth > 0).then_some(true),
                aliases: item.aliases.clone(),
                r#type: locked
                    .and_then(|l| l.r#type.clone())
                    .or_else(|| node.original.as_ref().and_then(|o| o.r#type.clone()))
                    .unwrap_or_else(|| "unknown".to_string()),
                url: locked.and_then(|l| l.url.clone()).or_else(|| url_from_locked(locked)),
                r#ref: locked
                    .and_then(|l| l.r#ref.clone())
                    .or_else(|| node.original.as_ref().and_then(|o| o.r#ref.clone())),
                rev: locked.and_then(|l| l.rev.clone()),
                nar_hash: locked.and_then(|l| l.nar_hash.clone()),
                last_modified: locked.and_then(|l| l.last_modified),
                store_path: item.ev_node.and_then(|n| n.path.clone()),
                follows: item.follows.clone(),
            },
        );

        if let Some(children) = &node.inputs {
            for (child_name, child_ref) in children {
                queue.push_back(Item {
                    name: format!("{}/{}", item.name, child_name),
                    node_key: match child_ref {
                        LockInputRef::Key(k) => Some(k.clone()),
                        LockInputRef::Follows(p) => resolve_follows(meta, p),
                    },
                    ev_node: item.ev_node.and_then(|n| n.inputs.get(child_name)),
                    depth: item.depth + 1,
                    follows: match child_ref {
                        LockInputRef::Follows(p) => Some(p.join("/")),
                        LockInputRef::Key(_) => None,
                    },
                    aliases: None,
                });
            }
        }
    }
    out
}

fn url_from_locked(locked: Option<&crate::run_nix::LockedInfo>) -> Option<String> {
    let l = locked?;
    match l.r#type.as_deref() {
        Some("github") => l
            .owner
            .as_ref()
            .map(|o| format!("https://github.com/{}/{}", o, l.repo.as_deref().unwrap_or(""))),
        Some("path") => l.path.clone(),
        _ => None,
    }
}

/// Walk a follows path (["nixpkgs"] or ["home-manager","nixpkgs"]) to its node key.
fn resolve_follows(meta: &FlakeMetadataJson, path: &[String]) -> Option<String> {
    let mut key = meta.locks.root.clone();
    for seg in path {
        let node = meta.locks.nodes.get(&key)?;
        let r#ref = node.inputs.as_ref()?.get(seg)?;
        key = match r#ref {
            LockInputRef::Key(k) => k.clone(),
            LockInputRef::Follows(p) => resolve_follows(meta, p)?,
        };
    }
    Some(key)
}

async fn file_entries(
    ev: &ManifestEval,
    local_checkout: Option<&str>,
    warnings: &mut Vec<String>,
) -> Vec<FileEntry> {
    let self_prefix = format!("{}/", ev.self_path);
    let mut entries: Vec<FileEntry> = ev
        .files
        .iter()
        .filter_map(|store_path| {
            let rel = store_path.strip_prefix(&self_prefix)?;
            Some(FileEntry {
                id: make_file_id_self(rel),
                rel_path: rel.to_string(),
                origin: FileOrigin::SelfOrigin,
                store_path: store_path.clone(),
                git: None,
            })
        })
        .collect();

    if let Some(checkout) = local_checkout {
        match repo_prefix(checkout).await {
            None => warnings
                .push(format!("{checkout} is not a git work tree — no per-file commit info")),
            Some(prefix) => {
                let commits = last_commits(checkout, warnings).await;
                for e in &mut entries {
                    if let Some(info) = commits.get(&format!("{prefix}{}", e.rel_path)) {
                        e.git = Some(info.clone());
                    }
                }
            }
        }
    }
    entries
}

// --------------------------------------------------------------- flake show

/// Normalize `nix flake show --json`. Two formats: classic (Nix/Lix) nested
/// objects, and Determinate Nix "inventory" v2.
pub fn normalize_show(json: &Value) -> OutputNode {
    if let Some(inventory) = json.get("inventory").and_then(|v| v.as_object()) {
        let mut children = IndexMap::new();
        for (name, entry) in inventory {
            let node = match entry.get("output") {
                Some(output) if output.is_object() => inventory_node(output),
                _ => OutputNode::Unknown,
            };
            children.insert(name.clone(), node);
        }
        return OutputNode::Attrset { children };
    }
    classic_node(json)
}

fn inventory_node(node: &Value) -> OutputNode {
    if node.get("filtered") == Some(&Value::Bool(true)) {
        return OutputNode::Omitted;
    }
    if let Some(children) = node.get("children").and_then(|v| v.as_object()) {
        let mut out = IndexMap::new();
        for (name, child) in children {
            out.insert(name.clone(), inventory_node(child));
        }
        return OutputNode::Attrset { children: out };
    }
    if let Some(what) = node.get("what").and_then(|v| v.as_str()) {
        return OutputNode::Leaf {
            r#type: what.to_string(),
            name: node
                .get("derivation")
                .and_then(|d| d.get("name"))
                .and_then(|n| n.as_str())
                .map(String::from),
            description: node
                .get("shortDescription")
                .and_then(|d| d.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
        };
    }
    OutputNode::Unknown
}

fn classic_node(node: &Value) -> OutputNode {
    let Some(n) = node.as_object() else { return OutputNode::Unknown };
    if n.get("unknown") == Some(&Value::Bool(true)) {
        return OutputNode::Unknown;
    }
    if let Some(t) = n.get("type").and_then(|v| v.as_str()) {
        return OutputNode::Leaf {
            r#type: t.to_string(),
            name: n.get("name").and_then(|v| v.as_str()).map(String::from),
            description: n
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
        };
    }
    if n.is_empty() {
        return OutputNode::Omitted;
    }
    let mut children = IndexMap::new();
    for (k, v) in n {
        children.insert(k.clone(), classic_node(v));
    }
    OutputNode::Attrset { children }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_name_passthrough_and_slug() {
        assert_eq!(safe_name("nebula"), "nebula");
        assert_eq!(safe_name("x86_64-linux"), "x86_64-linux");
        let slug = safe_name("evil/../name");
        assert!(slug.starts_with("evil_.._name-"));
        assert!(!slug.contains('/'));
        assert_ne!(safe_name("a/b"), safe_name("a b")); // collision hash differs
    }

    #[test]
    fn classic_show_normalizes() {
        let j = json!({
            "packages": {
                "x86_64-linux": {
                    "rtk": {"type": "derivation", "name": "rtk-1.0", "description": ""}
                }
            },
            "unknownThing": {"unknown": true},
            "empty": {}
        });
        let n = normalize_show(&j);
        let OutputNode::Attrset { children } = &n else { panic!() };
        assert!(matches!(children["unknownThing"], OutputNode::Unknown));
        assert!(matches!(children["empty"], OutputNode::Omitted));
        let refs = package_refs(&n);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].id, "packages/x86_64-linux/rtk");
        assert_eq!(refs[0].data_file, "package/packages.x86_64-linux.rtk.json");
    }

    #[test]
    fn inventory_show_normalizes() {
        let j = json!({
            "version": 2,
            "inventory": {
                "packages": {"output": {"children": {
                    "x86_64-linux": {"children": {
                        "hello": {"what": "package", "derivation": {"name": "hello-2.12"}, "shortDescription": "greets"}
                    }}
                }}},
                "filteredOut": {"output": {"filtered": true}}
            }
        });
        let n = normalize_show(&j);
        let OutputNode::Attrset { children } = &n else { panic!() };
        assert!(matches!(children["filteredOut"], OutputNode::Omitted));
        let refs = package_refs(&n);
        assert_eq!(refs[0].id, "packages/x86_64-linux/hello");
    }
}
