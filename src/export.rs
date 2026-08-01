// Single-file static export: compose the SPA plus
// every data document it could ask for into ONE standalone HTML file. The
// slice of the client's file-attribution logic the "--sources all" walk
// needs (mirroring buildFlakeIndexes/resolveFile in web/lib/indexes.ts)
// lives at the bottom.

use crate::highlight::tokenize_nix;
use crate::page::{PageOpts, find_app_dist, load_bundle, page_html};
use crate::reverse_deps::build_package_reverse_deps;
use crate::run_nix::read_input_file;
use crate::schema::{
    ConfigData, FileSource, GraphData, Manifest, PackageData, ParsedFileId, RefStatus,
    make_file_id_input, make_file_id_self, parse_file_id,
};
use indexmap::IndexMap;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

pub struct ExportOptions {
    pub out_dir: String,
    pub html_path: String,
    pub sources_all: bool,
    pub timeout: Duration,
    pub wanted: Vec<String>,
    pub wanted_packages: Vec<String>,
    /// Explicit --graphs selection only — never implied by --all (a system
    /// graph is ~1.4 MB gzipped in the file, a cost the user names).
    pub wanted_graphs: Vec<String>,
}

/// Compose the SPA and every requested data document into one standalone
/// HTML file at `opts.html_path`.
///
/// # Errors
///
/// Fails when the SPA bundle cannot be located or loaded, when an embed
/// fails to serialize, or when the output file cannot be written. Per-item
/// problems (a config/package/graph blob that won't parse, a source file
/// that can't be read) are downgraded to warnings embedded in the manifest,
/// not errors.
#[expect(
    clippy::too_many_lines,
    reason = "linear embed-assembly pipeline; splitting it would scatter the ordering invariants (manifest must embed last)"
)]
pub async fn export_html(
    flake_ref: &str,
    manifest: &Manifest,
    opts: &ExportOptions,
) -> anyhow::Result<()> {
    let mut warnings: Vec<String> = Vec::new();
    let mut embeds: Vec<(String, Value)> = Vec::new();

    // Requested configurations, read back from the data dir (parsing
    // validates the blob). Anything not ok here failed extraction.
    let mut config_data: IndexMap<String, ConfigData> = IndexMap::new();
    for id in &opts.wanted {
        let Some(r#ref) = manifest.configurations.iter().find(|c| &c.id == id) else {
            continue;
        };
        if r#ref.status != RefStatus::Ok {
            continue;
        }
        match read_json::<ConfigData>(&opts.out_dir, &r#ref.data_file) {
            Ok((data, raw)) => {
                embeds.push((r#ref.data_file.clone(), raw));
                config_data.insert(id.clone(), data);
            }
            Err(e) => warnings.push(format!(
                "configuration not exported: {id} ({})",
                e.to_string().lines().next().unwrap_or("")
            )),
        }
    }

    let mut package_data: IndexMap<String, PackageData> = IndexMap::new();
    for id in &opts.wanted_packages {
        let Some(r#ref) = manifest.packages.iter().find(|p| &p.id == id) else {
            continue;
        };
        if r#ref.status != RefStatus::Ok {
            continue;
        }
        match read_json::<PackageData>(&opts.out_dir, &r#ref.data_file) {
            Ok((data, raw)) => {
                embeds.push((r#ref.data_file.clone(), raw));
                package_data.insert(id.clone(), data);
            }
            Err(e) => warnings.push(format!(
                "package not exported: {id} ({})",
                e.to_string().lines().next().unwrap_or("")
            )),
        }
    }

    let mut graph_data: IndexMap<String, GraphData> = IndexMap::new();
    for id in &opts.wanted_graphs {
        let Some(r#ref) = manifest.graphs.iter().find(|g| &g.id == id) else {
            continue;
        };
        if r#ref.status != RefStatus::Ok {
            continue;
        }
        match read_json::<GraphData>(&opts.out_dir, &r#ref.data_file) {
            Ok((data, raw)) => {
                embeds.push((r#ref.data_file.clone(), raw));
                graph_data.insert(id.clone(), data);
            }
            Err(e) => warnings.push(format!(
                "graph not exported: {id} ({})",
                e.to_string().lines().next().unwrap_or("")
            )),
        }
    }

    // Source files to embed, id -> store path. Self files and each input's
    // own flake.nix always; with --sources all, everything the embedded
    // configs' fileIndex references.
    let mut sources: IndexMap<String, String> = IndexMap::new();
    for f in &manifest.files {
        sources.insert(f.id.clone(), f.store_path.clone());
    }
    for input in manifest.inputs.values() {
        let Some(store_path) = &input.store_path else {
            continue;
        };
        let id = make_file_id_input(&input.name, "flake.nix");
        sources
            .entry(id)
            .or_insert_with(|| format!("{store_path}/flake.nix"));
    }
    if opts.sources_all {
        let fx = FlakeIndexes::build(manifest);
        for data in config_data.values() {
            for store_path in data.file_index.keys() {
                // Virtual pseudo-paths and <unknown-file> have no file behind them.
                if !store_path.starts_with('/') {
                    continue;
                }
                let meta = resolve_file(store_path, manifest, &fx);
                if meta.id == "inline" || sources.contains_key(&meta.id) {
                    continue;
                }
                sources.insert(meta.id, meta.store_path);
            }
        }
    }

    let mut file_ids: Vec<String> = Vec::new();
    for (file_id, store_path) in &sources {
        let Some(text) =
            read_source(flake_ref, file_id, store_path, opts.timeout, &mut warnings).await
        else {
            continue;
        };
        let tokens = tokenize_nix(&text);
        embeds.push((
            format!("file/{}", url_encode(file_id)),
            serde_json::to_value(FileSource { text, tokens })?,
        ));
        file_ids.push(file_id.clone());
    }

    // The embedded manifest goes in last so export warnings surface in the
    // UI. A config/package that is ok on disk but NOT embedded is downgraded
    // to a fresh pending ref.
    let mut embedded = manifest.clone();
    for c in &mut embedded.configurations {
        if !config_data.contains_key(&c.id) && c.status == RefStatus::Ok {
            c.status = RefStatus::Pending;
            c.error = None;
            c.extracted_at = None;
            c.option_count = None;
            c.duration_ms = None;
        }
    }
    for p in &mut embedded.packages {
        if !package_data.contains_key(&p.id) && p.status == RefStatus::Ok {
            p.status = RefStatus::Pending;
            p.error = None;
            p.extracted_at = None;
            p.duration_ms = None;
        }
    }
    for g in &mut embedded.graphs {
        if !graph_data.contains_key(&g.id) && g.status == RefStatus::Ok {
            g.status = RefStatus::Pending;
            g.error = None;
            g.extracted_at = None;
            g.duration_ms = None;
        }
    }
    embedded.package_reverse_deps = Some(build_package_reverse_deps(&package_data));
    embedded.warnings.extend(warnings.iter().cloned());
    embeds.push((
        "manifest.json".to_string(),
        serde_json::to_value(&embedded)?,
    ));

    println!("building UI ...");
    let title = format!(
        "flake-explorer — {}",
        manifest.flake.description.as_deref().unwrap_or(flake_ref)
    );
    let bundle = load_bundle(&find_app_dist()?)?;
    let html = page_html(
        &bundle,
        &title,
        &PageOpts {
            dev: false,
            embeds: &embeds,
        },
    );
    let html_bytes = html.len();
    std::fs::write(&opts.html_path, html)?;

    #[expect(
        clippy::as_conversions,
        clippy::cast_precision_loss,
        reason = "byte count to MB for display only; f64::from does not exist for usize"
    )]
    let html_mb = html_bytes as f64 / 1024.0 / 1024.0;
    println!(
        "wrote {} ({:.1} MB, {} configurations, {} packages, {} graphs, {} source files)",
        opts.html_path,
        html_mb,
        config_data.len(),
        package_data.len(),
        graph_data.len(),
        file_ids.len()
    );
    for w in &warnings {
        eprintln!("  warn: {w}");
    }
    Ok(())
}

/// Parse a blob twice: typed (validation + downstream use) and as a raw
/// Value for the embed. The embed must NOT be a re-serialization of the
/// typed struct: serde's Option collapses an explicit `"value": null` (a
/// legitimate Nix null, e.g. a "null or string" option) into an ABSENT
/// field, which the UI renders differently from a present null.
fn read_json<T: serde::de::DeserializeOwned>(
    out_dir: &str,
    data_file: &str,
) -> anyhow::Result<(T, Value)> {
    let text = std::fs::read_to_string(Path::new(out_dir).join(data_file))?;
    Ok((serde_json::from_str(&text)?, serde_json::from_str(&text)?))
}

/// encodeURIComponent-alike for embed ids — must match the client's
/// encodeURIComponent(fileId) exactly.
fn url_encode(s: &str) -> String {
    // encodeURIComponent leaves A-Za-z0-9 - _ . ! ~ * ' ( ) unescaped.
    const KEEP: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
        .remove(b'-')
        .remove(b'_')
        .remove(b'.')
        .remove(b'!')
        .remove(b'~')
        .remove(b'*')
        .remove(b'\'')
        .remove(b'(')
        .remove(b')');
    percent_encoding::utf8_percent_encode(s, KEEP).to_string()
}

/// A store path can be stale or a directory — mirror serve's fallback:
/// input-origin files re-fetch through Nix; anything else is skipped with a
/// warning.
async fn read_source(
    flake_ref: &str,
    file_id: &str,
    store_path: &str,
    timeout: Duration,
    warnings: &mut Vec<String>,
) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(store_path) {
        return Some(text);
    }
    if let Some(ParsedFileId::InputFile { input, rel_path }) = parse_file_id(file_id) {
        match read_input_file(flake_ref, &input, &rel_path, timeout).await {
            Ok(text) => return Some(text),
            Err(e) => {
                warnings.push(format!(
                    "source not exported: {file_id} ({})",
                    e.to_string().lines().next().unwrap_or("")
                ));
                return None;
            }
        }
    }
    warnings.push(format!(
        "source not exported: {file_id} ({store_path} not readable)"
    ));
    None
}

// ---------------------------------------------------------------------------
// Minimal mirror of the client's buildFlakeIndexes/resolveFile
// (web/lib/indexes.ts) — just the parts the --sources all walk needs, so
// embedded ids match what the UI asks for exactly.

struct FlakeIndexes {
    self_by_store_path: std::collections::HashMap<String, (String, String)>, // storePath -> (id, relPath)
    /// Input storePath prefixes, longest first, for origin attribution.
    input_prefixes: Vec<(String, String)>, // (prefix, input)
    /// Store basename ("w8w3…-source") -> input name, for patched-copy trees.
    input_by_store_name: std::collections::HashMap<String, String>,
}

struct ResolvedFile {
    id: String,
    store_path: String,
}

impl FlakeIndexes {
    fn build(manifest: &Manifest) -> Self {
        let self_by_store_path = manifest
            .files
            .iter()
            .map(|f| (f.store_path.clone(), (f.id.clone(), f.rel_path.clone())))
            .collect();
        let with_paths: Vec<(&str, &str)> = manifest
            .inputs
            .values()
            .filter_map(|i| i.store_path.as_deref().map(|p| (p, i.name.as_str())))
            .collect();
        let mut input_prefixes: Vec<(String, String)> = with_paths
            .iter()
            .map(|&(path, name)| (format!("{path}/"), name.to_string()))
            .collect();
        input_prefixes.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        let mut input_by_store_name = std::collections::HashMap::new();
        for &(path, name) in &with_paths {
            // rsplit always yields at least one piece, so the fallback is
            // unreachable; the whole path is the honest degenerate base.
            let base = path.rsplit('/').next().unwrap_or(path).to_string();
            input_by_store_name
                .entry(base)
                .or_insert_with(|| name.to_string());
        }
        Self {
            self_by_store_path,
            input_prefixes,
            input_by_store_name,
        }
    }
}

fn resolve_file(store_path: &str, manifest: &Manifest, fx: &FlakeIndexes) -> ResolvedFile {
    if store_path == "<unknown-file>" {
        return ResolvedFile {
            id: "inline".into(),
            store_path: store_path.into(),
        };
    }
    if let Some((id, _)) = fx.self_by_store_path.get(store_path) {
        return ResolvedFile {
            id: id.clone(),
            store_path: store_path.into(),
        };
    }
    let self_prefix = format!("{}/", manifest.flake.path);
    if let Some(rel) = store_path.strip_prefix(&self_prefix) {
        return ResolvedFile {
            id: make_file_id_self(rel),
            store_path: store_path.into(),
        };
    }
    for (prefix, input) in &fx.input_prefixes {
        if let Some(rel) = store_path.strip_prefix(prefix.as_str()) {
            return ResolvedFile {
                id: make_file_id_input(input, rel),
                store_path: store_path.into(),
            };
        }
    }
    // Patched copy of an input: "<hash>-<original store basename>" trees —
    // recover the input from the middle.
    if let Some((root, rel)) = store_path
        .strip_prefix("/nix/store/")
        .and_then(|rest| rest.split_once('/'))
        .filter(|(root, _)| !root.is_empty())
    {
        let original_name = strip_store_hash(root);
        if let Some(input) = fx.input_by_store_name.get(original_name) {
            // The patched-flag id shape matches makeFileId (kind: input).
            return ResolvedFile {
                id: make_file_id_input(input, rel),
                store_path: store_path.into(),
            };
        }
        return ResolvedFile {
            id: format!("unknown:{root}:{rel}"),
            store_path: store_path.into(),
        };
    }
    ResolvedFile {
        id: format!("unknown:{store_path}"),
        store_path: store_path.into(),
    }
}

/// Strip a leading `<32-char nix hash>-` from a store basename, if present.
fn strip_store_hash(root: &str) -> &str {
    match root.split_at_checked(32) {
        Some((hash, rest))
            if hash
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) =>
        {
            // A well-formed hash prefix without the trailing dash is not a
            // hash prefix at all — keep the whole name.
            rest.strip_prefix('-').unwrap_or(root)
        }
        _ => root,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{FileEntry, FlakeInfo, InputInfo, OutputNode};

    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn mini_manifest() -> Manifest {
        let mut inputs = IndexMap::new();
        inputs.insert(
            "nixpkgs".to_string(),
            InputInfo {
                name: "nixpkgs".to_string(),
                node_key: "nixpkgs".to_string(),
                transitive: None,
                aliases: None,
                r#type: "github".to_string(),
                url: None,
                r#ref: None,
                rev: None,
                nar_hash: None,
                last_modified: None,
                store_path: Some(format!("/nix/store/{HASH_A}-source")),
                follows: None,
            },
        );
        Manifest {
            version: 1,
            generated_at: String::new(),
            extractor: String::new(),
            flake: FlakeInfo {
                r#ref: ".".to_string(),
                path: "/nix/store/x-self".to_string(),
                description: None,
                rev: None,
                nar_hash: None,
            },
            outputs: OutputNode::Omitted,
            inputs,
            files: Vec::<FileEntry>::new(),
            import_edges: Vec::new(),
            input_refs: Vec::new(),
            overlay_defs: None,
            input_follows: Vec::new(),
            configurations: Vec::new(),
            packages: Vec::new(),
            graphs: Vec::new(),
            package_reverse_deps: None,
            grafts: Vec::new(),
            output_names: IndexMap::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn strip_store_hash_strips_only_wellformed_prefixes() {
        assert_eq!(strip_store_hash(&format!("{HASH_A}-source")), "source");
        // 32 hash chars with no trailing dash: not a hash prefix at all.
        assert_eq!(strip_store_hash(HASH_A), HASH_A);
        // Too short, or non-hash chars in the first 32 bytes: untouched.
        assert_eq!(strip_store_hash("short-name"), "short-name");
        let upper = format!("{}-x", "A".repeat(32));
        assert_eq!(strip_store_hash(&upper), upper.as_str());
    }

    #[test]
    fn resolve_file_attributes_patched_input_copies() {
        let manifest = mini_manifest();
        let fx = FlakeIndexes::build(&manifest);
        // A patched copy is "<new hash>-<original store basename>".
        let path = format!("/nix/store/{HASH_B}-{HASH_A}-source/pkgs/x.nix");
        let r = resolve_file(&path, &manifest, &fx);
        assert_eq!(r.id, "input:nixpkgs:pkgs/x.nix");
        assert_eq!(r.store_path, path);
    }

    #[test]
    fn resolve_file_labels_unmatched_paths_unknown() {
        let manifest = mini_manifest();
        let fx = FlakeIndexes::build(&manifest);
        let r = resolve_file(
            &format!("/nix/store/{HASH_B}-mystery/x.nix"),
            &manifest,
            &fx,
        );
        assert_eq!(r.id, format!("unknown:{HASH_B}-mystery:x.nix"));
        let r = resolve_file("not-a-store-path", &manifest, &fx);
        assert_eq!(r.id, "unknown:not-a-store-path");
    }
}
