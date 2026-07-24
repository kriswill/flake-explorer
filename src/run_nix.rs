// Thin wrapper around the host's `nix` binary.
// All calls are JSON-in/JSON-out with a timeout and errors surfaced with the
// underlying stderr attached. extract.nix is embedded in the binary and
// materialized once into the user's cache dir, keyed by content hash, so the
// Rust binary is self-contained.

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub const EXTRACT_NIX: &str = include_str!("extract.nix");

#[derive(Debug)]
pub struct NixError {
    pub message: String,
    pub stderr: String,
    #[allow(dead_code)] // kept for API completeness alongside message/stderr
    pub exit_code: Option<i32>,
}

impl fmt::Display for NixError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for NixError {}

impl NixError {
    fn plain(message: impl Into<String>) -> Self {
        NixError {
            message: message.into(),
            stderr: String::new(),
            exit_code: None,
        }
    }
}

const MIN_NIX: (u64, u64) = (2, 19);

/// Errors with a clear message when nix is missing or too old.
pub async fn check_nix() -> Result<String, NixError> {
    let out = run(&["--version"], Duration::from_secs(10))
        .await
        .map_err(|_| {
            NixError::plain(
                "flake-explorer needs `nix` on PATH (>= 2.19 with flakes enabled) — none found.",
            )
        })?;
    // e.g. "nix (Nix) 2.34.7" or "nix (Determinate Nix 3.21.1) 2.34.7"
    let re = regex::Regex::new(r"\s(\d+)\.(\d+)\.\d+\s*$").unwrap();
    for line in out.lines() {
        if let Some(c) = re.captures(line) {
            let maj: u64 = c[1].parse().unwrap_or(0);
            let min: u64 = c[2].parse().unwrap_or(0);
            if maj < MIN_NIX.0 || (maj == MIN_NIX.0 && min < MIN_NIX.1) {
                return Err(NixError::plain(format!(
                    "flake-explorer needs nix >= {}.{}, found: {}",
                    MIN_NIX.0,
                    MIN_NIX.1,
                    out.trim()
                )));
            }
            break;
        }
    }
    Ok(out.trim().to_string())
}

// Lazy trees (Determinate Nix) mint per-access-route virtual store paths;
// force real content-addressed paths. On nix variants without the setting
// this is just an "unknown setting" warning.
const COMMON_OPTS: [&str; 4] = [
    "--option",
    "lazy-trees",
    "false",
    "--extra-experimental-features",
];
const COMMON_FEATURES: &str = "nix-command flakes";

pub async fn run(args: &[&str], timeout: Duration) -> Result<String, NixError> {
    let mut cmd = Command::new("nix");
    cmd.args(COMMON_OPTS).arg(COMMON_FEATURES).args(args);
    cmd.stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| NixError::plain(format!("failed to spawn nix: {e}")))?;

    let mut stdout_pipe = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take().unwrap();
    let read_all = async {
        let mut stdout = String::new();
        let mut stderr = String::new();
        let (a, b) = tokio::join!(
            stdout_pipe.read_to_string(&mut stdout),
            stderr_pipe.read_to_string(&mut stderr)
        );
        a.ok();
        b.ok();
        let status = child.wait().await.ok();
        (stdout, stderr, status.and_then(|s| s.code()))
    };

    let (stdout, stderr, exit_code) = match tokio::time::timeout(timeout, read_all).await {
        Ok(r) => r,
        Err(_) => {
            return Err(NixError {
                message: format!(
                    "nix {} timed out after {}s",
                    args.first().unwrap_or(&""),
                    timeout.as_secs()
                ),
                stderr: String::new(),
                exit_code: None,
            });
        }
    };

    if exit_code != Some(0) {
        let tail: Vec<&str> = stderr.trim().lines().collect();
        let tail = tail[tail.len().saturating_sub(15)..].join("\n");
        return Err(NixError {
            message: format!(
                "nix {} failed (exit {}):\n{}",
                args.iter().take(3).cloned().collect::<Vec<_>>().join(" "),
                exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into()),
                tail
            ),
            stderr,
            exit_code,
        });
    }
    Ok(stdout)
}

pub async fn run_json<T: serde::de::DeserializeOwned>(
    args: &[&str],
    timeout: Duration,
) -> Result<T, NixError> {
    let out = run(args, timeout).await?;
    serde_json::from_str(&out)
        .map_err(|e| NixError::plain(format!("nix returned unparseable JSON: {e}")))
}

/// `nix flake metadata --json <ref>`
pub async fn flake_metadata(r#ref: &str, timeout: Duration) -> Result<FlakeMetadataJson, NixError> {
    run_json(&["flake", "metadata", "--json", r#ref], timeout).await
}

/// `nix flake show --json <ref>`
pub async fn flake_show(
    r#ref: &str,
    all_systems: bool,
    timeout: Duration,
) -> Result<Value, NixError> {
    if all_systems {
        run_json(
            &["flake", "show", "--json", "--all-systems", r#ref],
            timeout,
        )
        .await
    } else {
        run_json(&["flake", "show", "--json", r#ref], timeout).await
    }
}

/// Materialize the embedded extract.nix into the cache dir once per process,
/// keyed by content hash so upgrades never reuse a stale copy.
fn extract_nix_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let hash = hex::encode(Sha256::digest(EXTRACT_NIX.as_bytes()));
        let dir = std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cache")))
            .unwrap_or_else(std::env::temp_dir)
            .join("flake-explorer");
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join(format!("extract-{}.nix", &hash[..16]));
        if !path.exists() {
            std::fs::write(&path, EXTRACT_NIX).expect("cannot write extract.nix to cache dir");
        }
        path.to_string_lossy().into_owned()
    })
}

/// Evaluate extract.nix with the given args. The args object is passed
/// through JSON twice: a JSON string literal is a valid Nix string literal.
pub async fn eval_extract<T: serde::de::DeserializeOwned>(
    args: &ExtractArgs,
    timeout: Duration,
) -> Result<T, NixError> {
    let json = serde_json::to_string(args).unwrap();
    let expr = format!(
        "import {} (builtins.fromJSON {})",
        serde_json::to_string(extract_nix_path()).unwrap(),
        serde_json::to_string(&json).unwrap()
    );
    run_json(&["eval", "--impure", "--json", "--expr", &expr], timeout).await
}

/// Quote a flake attrpath segment unless it's already a bare nix identifier.
pub fn attr_selector(path: &[String]) -> String {
    let bare = regex::Regex::new(r"^[A-Za-z_][A-Za-z0-9_'-]*$").unwrap();
    path.iter()
        .map(|seg| {
            if bare.is_match(seg) {
                seg.clone()
            } else {
                serde_json::to_string(seg).unwrap()
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}

/// `nix derivation show <flakeRef>#<attr>` — instantiates the .drv, never builds.
pub async fn derivation_show(
    flake_ref: &str,
    path: &[String],
    timeout: Duration,
) -> Result<Value, NixError> {
    let installable = format!("{flake_ref}#{}", attr_selector(path));
    run_json(&["derivation", "show", "--impure", &installable], timeout).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathInfoRaw {
    pub nar_size: u64,
    pub closure_size: Option<u64>,
    pub references: Vec<String>,
}

/// `nix path-info` for one already-instantiated output path — query only.
/// An invalid/not-yet-built path maps to `null` in the JSON rather than a
/// nonzero exit, so that's the signal checked (not the exit code).
pub async fn path_info(out_path: &str, timeout: Duration) -> Result<Option<PathInfoRaw>, NixError> {
    let result: std::collections::HashMap<String, Option<PathInfoRaw>> = run_json(
        &[
            "path-info",
            "--json",
            "--json-format",
            "1",
            "--closure-size",
            out_path,
        ],
        timeout,
    )
    .await?;
    Ok(result.get(out_path).cloned().flatten())
}

/// Read a file out of a flake input directly through Nix, bypassing the
/// (possibly stale) store path. A directory-mounted "module" resolves to
/// default.nix on retry.
pub async fn read_input_file(
    flake_ref: &str,
    input_name: &str,
    rel_path: &str,
    timeout: Duration,
) -> Result<String, NixError> {
    match read_input_file_raw(flake_ref, input_name, rel_path, timeout).await {
        Ok(s) => Ok(s),
        Err(e) if e.stderr.contains("Is a directory") => {
            read_input_file_raw(
                flake_ref,
                input_name,
                &format!("{rel_path}/default.nix"),
                timeout,
            )
            .await
        }
        Err(e) => Err(e),
    }
}

async fn read_input_file_raw(
    flake_ref: &str,
    input_name: &str,
    rel_path: &str,
    timeout: Duration,
) -> Result<String, NixError> {
    let expr = format!(
        "builtins.readFile ((builtins.getFlake {}).inputs.{} + {})",
        serde_json::to_string(flake_ref).unwrap(),
        serde_json::to_string(input_name).unwrap(),
        serde_json::to_string(&format!("/{rel_path}")).unwrap()
    );
    run(&["eval", "--impure", "--raw", "--expr", &expr], timeout).await
}

// ---------------------------------------------------------------- arg/JSON shapes

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractArgs {
    pub flake_ref: String,
    pub mode: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_names: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_invisible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub with_values: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub with_descriptions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs_depth: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlakeMetadataJson {
    pub description: Option<String>,
    #[allow(dead_code)]
    pub path: Option<String>,
    pub resolved_url: Option<String>,
    pub revision: Option<String>,
    pub locked: Option<MetaLocked>,
    pub locks: Locks,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaLocked {
    pub nar_hash: Option<String>,
    #[allow(dead_code)]
    pub rev: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Locks {
    pub root: String,
    pub nodes: std::collections::HashMap<String, LockNode>,
}

/// A lock-node input edge: a node key, or a follows path.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum LockInputRef {
    Key(String),
    Follows(Vec<String>),
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct LockNode {
    pub inputs: Option<indexmap::IndexMap<String, LockInputRef>>,
    pub locked: Option<LockedInfo>,
    pub original: Option<OriginalInfo>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockedInfo {
    #[serde(default)]
    pub r#type: Option<String>,
    pub nar_hash: Option<String>,
    pub rev: Option<String>,
    pub r#ref: Option<String>,
    pub owner: Option<String>,
    pub repo: Option<String>,
    pub url: Option<String>,
    pub path: Option<String>,
    pub last_modified: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OriginalInfo {
    #[serde(default)]
    pub r#type: Option<String>,
    pub r#ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct InputsTreeNode {
    /// Store path of the input's source ("path" — see extract.nix outPath note).
    pub path: Option<String>,
    #[serde(default)]
    pub inputs: indexmap::IndexMap<String, InputsTreeNode>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEval {
    #[serde(rename = "self")]
    pub self_path: String,
    pub description: Option<String>,
    pub inputs: indexmap::IndexMap<String, InputsTreeNode>,
    pub configurations: Vec<ConfigEntry>,
    pub files: Vec<String>,
    #[serde(default)]
    pub grafts: Vec<crate::schema::GraftInfo>,
    #[serde(default)]
    pub output_names: indexmap::IndexMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConfigEntry {
    pub kind: crate::schema::ConfigKind,
    pub n: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OptionsEval {
    pub options: Vec<RawOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageEval {
    pub is_drv: bool,
    pub name: Option<String>,
    pub pname: Option<String>,
    pub pkg_version: Option<String>,
    pub stdenv: Option<String>,
    pub system: Option<String>,
    pub markers: PackageMarkers,
    pub outputs: Vec<PackageEvalOutput>,
    pub meta: Option<serde_json::Map<String, Value>>,
    pub meta_error: bool,
    pub src: Option<PackageEvalSrc>,
    pub deps: crate::schema::PackageDeps,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageMarkers {
    pub cargo_deps: bool,
    pub go_modules: bool,
    pub npm_deps: bool,
    pub build_command: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackageEvalOutput {
    pub name: String,
    /// `path`, not `outPath` — see extract.nix's outputInfo comment.
    pub path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageEvalSrc {
    pub store_path: Option<String>,
    pub url: Option<String>,
    pub rev: Option<String>,
    pub output_hash: Option<String>,
}

/// Envelope from extract.nix deepSafe/namesOf:
/// value | error | skipped-as-unsafe | drv names only — or null.
pub type ValueEnvelope = Option<Value>;

/// String-or-null that tolerates stray scalars: nixpkgs modules occasionally
/// set e.g. `defaultText = false` (bluesky-pds does, live), which the module
/// system passes through untyped. Coerce stray scalars to their JSON
/// rendering instead of failing the whole chunk.
fn lenient_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(d)? {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s),
        Some(other) => Some(other.to_string()),
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawOption {
    pub loc: Vec<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub r#type: Option<String>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub description: Option<String>,
    pub read_only: bool,
    pub is_defined: bool,
    pub highest_prio: Option<i64>,
    #[serde(default, deserialize_with = "lenient_string")]
    pub default_text: Option<String>,
    pub default: ValueEnvelope,
    pub value: ValueEnvelope,
    pub declarations: Vec<RawDeclaration>,
    pub definitions: Vec<RawDefinition>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawDeclaration {
    pub file: String,
    pub line: Option<i64>,
    pub column: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RawDefinition {
    pub file: String,
    pub value: ValueEnvelope,
}
