// JSON data contract between the extractor and the SPA — a 1:1 port of
// src/schema.ts. Field names, tag values, and optional-field omission must
// match the TypeScript output byte-for-byte in shape: the Svelte app consumes
// these documents unchanged.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: u32,
    pub generated_at: String,
    pub extractor: String,
    pub flake: FlakeInfo,
    pub outputs: OutputNode,
    pub inputs: IndexMap<String, InputInfo>,
    pub files: Vec<FileEntry>,
    pub import_edges: Vec<ImportEdge>,
    pub input_refs: Vec<InputRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overlay_defs: Option<Vec<OverlayDef>>,
    pub input_follows: Vec<InputFollow>,
    pub configurations: Vec<ConfigRef>,
    pub packages: Vec<PackageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub package_reverse_deps: Option<IndexMap<String, Vec<String>>>,
    pub grafts: Vec<GraftInfo>,
    pub output_names: IndexMap<String, Vec<String>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraftInfo {
    pub output: String,
    pub input: String,
    pub added: Vec<String>,
    pub inherited: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlakeInfo {
    pub r#ref: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nar_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OutputNode {
    #[serde(rename = "attrset")]
    Attrset { children: IndexMap<String, OutputNode> },
    #[serde(rename = "leaf")]
    Leaf {
        r#type: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    #[serde(rename = "omitted")]
    Omitted,
    #[serde(rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputInfo {
    pub name: String,
    pub node_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transitive: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aliases: Option<Vec<String>>,
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nar_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub follows: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileOrigin {
    #[serde(rename = "self")]
    SelfOrigin,
    #[serde(rename = "input")]
    Input {
        input: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        patched: Option<bool>,
    },
    #[serde(rename = "unknown")]
    Unknown {
        #[serde(skip_serializing_if = "Option::is_none")]
        group: Option<String>,
    },
}

/// FileEntry.id codec — "self:<rel>" | "input:<name>:<rel>" (client-server protocol).
pub fn make_file_id_self(rel_path: &str) -> String {
    format!("self:{rel_path}")
}

pub fn make_file_id_input(input: &str, rel_path: &str) -> String {
    format!("input:{input}:{rel_path}")
}

#[derive(Debug, Clone, PartialEq)]
pub enum ParsedFileId {
    SelfFile { rel_path: String },
    InputFile { input: String, rel_path: String },
}

pub fn parse_file_id(id: &str) -> Option<ParsedFileId> {
    if let Some(rel) = id.strip_prefix("self:") {
        return Some(ParsedFileId::SelfFile { rel_path: rel.to_string() });
    }
    let rest = id.strip_prefix("input:")?;
    let colon = rest.find(':')?;
    let (input, rel) = (&rest[..colon], &rest[colon + 1..]);
    if input.is_empty() || rel.is_empty() {
        return None;
    }
    Some(ParsedFileId::InputFile { input: input.to_string(), rel_path: rel.to_string() })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub rel_path: String,
    pub origin: FileOrigin,
    pub store_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git: Option<GitFileInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileInfo {
    pub commit: String,
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSource {
    pub text: String,
    pub tokens: Vec<TokenRun>,
}

/// Highlight span over the text — start/end are UTF-16 code-unit indices
/// (the client slices JS strings with them).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenRun {
    pub start: usize,
    pub end: usize,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputRef {
    pub file: String,
    pub input: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayDef {
    pub name: String,
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Vec<OverlayAttr>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayAttr {
    pub name: String,
    pub kind: OverlayAttrKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayAttrKind {
    Add,
    Override,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputFollow {
    pub name: String,
    pub target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConfigKind {
    Nixos,
    Darwin,
}

impl ConfigKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConfigKind::Nixos => "nixos",
            ConfigKind::Darwin => "darwin",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RefStatus {
    Pending,
    Ok,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigRef {
    pub id: String,
    pub kind: ConfigKind,
    pub name: String,
    pub data_file: String,
    pub status: RefStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRef {
    pub id: String,
    pub path: Vec<String>,
    pub data_file: String,
    pub status: RefStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum BuilderKind {
    #[serde(rename = "rustPlatform")]
    RustPlatform,
    #[serde(rename = "buildGoModule")]
    BuildGoModule,
    #[serde(rename = "node")]
    Node,
    #[serde(rename = "trivial")]
    Trivial,
    #[serde(rename = "stdenv")]
    Stdenv,
    #[serde(rename = "unknown")]
    Unknown,
}

impl BuilderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuilderKind::RustPlatform => "rustPlatform",
            BuilderKind::BuildGoModule => "buildGoModule",
            BuilderKind::Node => "node",
            BuilderKind::Trivial => "trivial",
            BuilderKind::Stdenv => "stdenv",
            BuilderKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageLicense {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spdx_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMaintainer {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<Vec<PackageLicense>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub main_program: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintainers: Option<Vec<PackageMaintainer>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub broken: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unfree: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageSrc {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageDeps {
    pub native_build_inputs: Vec<String>,
    pub build_inputs: Vec<String>,
    pub propagated_build_inputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrvPhase {
    pub name: String,
    pub script: String,
    pub tokens: Vec<TokenRun>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrvInputRef {
    pub drv_path: String,
    pub name: String,
    pub outputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrvInfo {
    pub drv_path: String,
    pub system: String,
    pub builder_path: String,
    pub input_drvs: Vec<DrvInputRef>,
    pub phases: Vec<DrvPhase>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub do_check: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strict_deps: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_attrs: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub out_path: String,
    pub references: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nar_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closure_size: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageOutput {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageData {
    pub version: u32,
    pub id: String,
    pub path: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkg_version: Option<String>,
    pub builder: BuilderKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdenv: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<PackageMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub src: Option<PackageSrc>,
    pub outputs: Vec<PackageOutput>,
    pub deps: PackageDeps,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drv: Option<DrvInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<IndexMap<String, RuntimeInfo>>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigData {
    pub version: u32,
    pub id: String,
    pub options: Vec<OptionEntry>,
    pub file_index: IndexMap<String, FileOptionRefs>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOptionRefs {
    pub defines: Vec<usize>,
    pub declares: Vec<usize>,
}

/// Well-known mk-priority values (lib.mkOverride n).
pub const PRIO_OPTION_DEFAULT: i64 = 1500;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionEntry {
    pub loc: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub read_only: bool,
    pub is_defined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highest_prio: Option<i64>,
    pub customized: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_text: Option<String>,
    pub declarations: Vec<DeclarationRef>,
    pub definitions: Vec<DefinitionRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationRef {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionRef {
    pub file: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prio: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_id_round_trip() {
        assert_eq!(
            parse_file_id("self:modules/a.nix"),
            Some(ParsedFileId::SelfFile { rel_path: "modules/a.nix".into() })
        );
        assert_eq!(
            parse_file_id("input:nixpkgs:lib/default.nix"),
            Some(ParsedFileId::InputFile {
                input: "nixpkgs".into(),
                rel_path: "lib/default.nix".into()
            })
        );
        assert_eq!(parse_file_id("unknown:whatever"), None);
        assert_eq!(parse_file_id("inline"), None);
    }

    #[test]
    fn output_node_tags() {
        let leaf = OutputNode::Leaf { r#type: "derivation".into(), name: None, description: None };
        assert_eq!(serde_json::to_string(&leaf).unwrap(), r#"{"kind":"leaf","type":"derivation"}"#);
        let omitted = OutputNode::Omitted;
        assert_eq!(serde_json::to_string(&omitted).unwrap(), r#"{"kind":"omitted"}"#);
    }

    #[test]
    fn origin_tags() {
        assert_eq!(
            serde_json::to_string(&FileOrigin::SelfOrigin).unwrap(),
            r#"{"kind":"self"}"#
        );
        assert_eq!(
            serde_json::to_string(&FileOrigin::Input { input: "nixpkgs".into(), patched: None })
                .unwrap(),
            r#"{"kind":"input","input":"nixpkgs"}"#
        );
    }
}
