// Single-file static export — port of src/export.ts: compose the SPA plus
// every data document it could ask for into ONE standalone HTML file. The
// small slice of the client's file-attribution logic the "--sources all"
// walk needs (buildFlakeIndexes/resolveFile from app/lib/indexes.ts) is
// ported at the bottom.

use crate::highlight::tokenize_nix;
use crate::page::{find_app_dist, load_bundle, page_html, PageOpts};
use crate::reverse_deps::build_package_reverse_deps;
use crate::run_nix::read_input_file;
use crate::schema::*;
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
}

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
            Ok(data) => {
                embeds.push((r#ref.data_file.clone(), serde_json::to_value(&data)?));
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
            Ok(data) => {
                embeds.push((r#ref.data_file.clone(), serde_json::to_value(&data)?));
                package_data.insert(id.clone(), data);
            }
            Err(e) => warnings.push(format!(
                "package not exported: {id} ({})",
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

    println!(
        "wrote {} ({:.1} MB, {} configurations, {} packages, {} source files)",
        opts.html_path,
        html_bytes as f64 / 1024.0 / 1024.0,
        config_data.len(),
        package_data.len(),
        file_ids.len()
    );
    for w in &warnings {
        eprintln!("  warn: {w}");
    }
    Ok(())
}

fn read_json<T: serde::de::DeserializeOwned>(out_dir: &str, data_file: &str) -> anyhow::Result<T> {
    Ok(serde_json::from_str(&std::fs::read_to_string(
        Path::new(out_dir).join(data_file),
    )?)?)
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
// Minimal port of app/lib/indexes.ts buildFlakeIndexes/resolveFile — just the
// parts the --sources all walk needs, so embedded ids match what the UI asks
// for exactly.

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
    fn build(manifest: &Manifest) -> FlakeIndexes {
        let self_by_store_path = manifest
            .files
            .iter()
            .map(|f| (f.store_path.clone(), (f.id.clone(), f.rel_path.clone())))
            .collect();
        let with_paths: Vec<&InputInfo> = manifest
            .inputs
            .values()
            .filter(|i| i.store_path.is_some())
            .collect();
        let mut input_prefixes: Vec<(String, String)> = with_paths
            .iter()
            .map(|i| {
                (
                    format!("{}/", i.store_path.as_ref().unwrap()),
                    i.name.clone(),
                )
            })
            .collect();
        input_prefixes.sort_by_key(|(p, _)| std::cmp::Reverse(p.len()));
        let mut input_by_store_name = std::collections::HashMap::new();
        for i in &with_paths {
            let base = i
                .store_path
                .as_ref()
                .unwrap()
                .rsplit('/')
                .next()
                .unwrap()
                .to_string();
            input_by_store_name
                .entry(base)
                .or_insert_with(|| i.name.clone());
        }
        FlakeIndexes {
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
    let re = regex::Regex::new(r"^/nix/store/([^/]+)/(.*)$").unwrap();
    if let Some(m) = re.captures(store_path) {
        let root = &m[1];
        let rel = &m[2];
        let hash_re = regex::Regex::new(r"^[a-z0-9]{32}-").unwrap();
        let original_name = hash_re.replace(root, "").into_owned();
        if let Some(input) = fx.input_by_store_name.get(&original_name) {
            // The patched-flag id shape matches makeFileId (kind: input).
            let _ = input;
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
