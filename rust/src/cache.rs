// Extraction cache — port of src/extract/cache.ts: a config blob is fresh
// when its sidecar records the same cache key a fresh extraction would use
// (extractor fingerprint + flake identity + lock hash). Sidecars live next
// to the blobs (config/<kind>.<name>.meta.json).

use crate::manifest::{now_iso, FINGERPRINT};
use crate::options::{extract_options, ExtractOptionsOpts, OptionsResult, ProgressFn};
use crate::package::{extract_package, PackageResult};
use crate::schema::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone, PartialEq)]
pub struct CacheKey {
    /// The flake's narHash when it has one; else its self store path.
    pub flake_key: String,
    /// Fingerprint over the resolved input set (the effective flake.lock).
    pub lock_hash: String,
}

pub fn cache_key_of(manifest: &Manifest) -> CacheKey {
    let mut hasher = Sha256::new();
    let mut names: Vec<&String> = manifest.inputs.keys().collect();
    names.sort();
    for name in names {
        let i = &manifest.inputs[name];
        let id = i
            .nar_hash
            .as_deref()
            .or(i.rev.as_deref())
            .or(i.url.as_deref())
            .unwrap_or("");
        hasher.update(format!("{name}={id}\n"));
    }
    CacheKey {
        flake_key: manifest
            .flake
            .nar_hash
            .clone()
            .unwrap_or_else(|| manifest.flake.path.clone()),
        lock_hash: hex::encode(hasher.finalize())[..16].to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMeta {
    /// Both optional only so pre-CacheKey sidecars still parse; absent always
    /// means stale.
    flake_key: Option<String>,
    lock_hash: Option<String>,
    extractor: String,
    extracted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    option_count: Option<usize>,
    duration_ms: u64,
    warnings: Vec<String>,
}

fn sidecar_path(out_dir: &str, data_file: &str) -> PathBuf {
    let meta = if let Some(stripped) = data_file.strip_suffix(".json") {
        format!("{stripped}.meta.json")
    } else {
        format!("{data_file}.meta.json")
    };
    Path::new(out_dir).join(meta)
}

fn write_sidecar(
    out_dir: &str,
    data_file: &str,
    key: &CacheKey,
    extracted_at: &str,
    option_count: Option<usize>,
    duration_ms: u64,
    warnings: &[String],
) -> anyhow::Result<()> {
    let meta = SidecarMeta {
        flake_key: Some(key.flake_key.clone()),
        lock_hash: Some(key.lock_hash.clone()),
        extractor: FINGERPRINT.to_string(),
        extracted_at: extracted_at.to_string(),
        option_count,
        duration_ms,
        warnings: warnings.to_vec(),
    };
    std::fs::write(sidecar_path(out_dir, data_file), serde_json::to_string(&meta)?)?;
    Ok(())
}

/// Defense in depth: dataFile derives from a Nix attr name (sanitized in
/// manifest.rs) — never let a hostile name write outside the data dir.
fn guarded_blob_path(out_dir: &str, data_file: &str) -> anyhow::Result<PathBuf> {
    let blob = Path::new(out_dir).join(data_file);
    let out_canon = std::fs::canonicalize(out_dir)?;
    // The blob may not exist yet; canonicalize its parent.
    let parent = blob.parent().ok_or_else(|| anyhow::anyhow!("bad dataFile: {data_file}"))?;
    let parent_canon = std::fs::canonicalize(parent)?;
    if !parent_canon.starts_with(&out_canon) {
        anyhow::bail!("refusing to write outside the data dir: {data_file}");
    }
    Ok(blob)
}

pub struct Extracted<T> {
    pub result: T,
    pub extracted_at: String,
}

/// Extraction driver shared by the CLI and serve: evaluate one
/// configuration's options, write the blob + sidecar. Deliberately does NOT
/// touch the ConfigRef — the caller applies the outcome to whichever
/// manifest is current when the extraction settles.
pub async fn extract_and_persist(
    out_dir: &str,
    flake_ref: &str,
    key: &CacheKey,
    r#ref: &ConfigRef,
    timeout: Duration,
    on_progress: Option<ProgressFn>,
) -> anyhow::Result<Extracted<OptionsResult>> {
    let blob_path = guarded_blob_path(out_dir, &r#ref.data_file)?;
    let r = extract_options(
        flake_ref,
        r#ref.kind,
        &r#ref.name,
        ExtractOptionsOpts { timeout, on_progress, ..Default::default() },
    )
    .await?;
    std::fs::write(&blob_path, serde_json::to_string(&r.data)?)?;
    let extracted_at = now_iso();
    write_sidecar(
        out_dir,
        &r#ref.data_file,
        key,
        &extracted_at,
        Some(r.data.options.len()),
        r.duration_ms,
        &r.warnings,
    )?;
    Ok(Extracted { result: r, extracted_at })
}

/// Record a finished extraction on a (current-manifest) ConfigRef.
pub fn apply_extracted(r#ref: &mut ConfigRef, r: &Extracted<OptionsResult>) {
    r#ref.status = RefStatus::Ok;
    r#ref.extracted_at = Some(r.extracted_at.clone());
    r#ref.option_count = Some(r.result.data.options.len());
    r#ref.duration_ms = Some(r.result.duration_ms);
}

/// Extraction driver for one derivation-typed output — same blob+sidecar
/// shape and path-traversal guard as extract_and_persist.
pub async fn extract_and_persist_package(
    out_dir: &str,
    flake_ref: &str,
    key: &CacheKey,
    r#ref: &PackageRef,
    timeout: Duration,
) -> anyhow::Result<Extracted<PackageResult>> {
    let blob_path = guarded_blob_path(out_dir, &r#ref.data_file)?;
    let r = extract_package(flake_ref, &r#ref.id, &r#ref.path, timeout).await?;
    std::fs::write(&blob_path, serde_json::to_string(&r.data)?)?;
    let extracted_at = now_iso();
    write_sidecar(out_dir, &r#ref.data_file, key, &extracted_at, None, r.duration_ms, &r.warnings)?;
    Ok(Extracted { result: r, extracted_at })
}

/// Record a finished extraction on a (current-manifest) PackageRef.
pub fn apply_extracted_package(r#ref: &mut PackageRef, r: &Extracted<PackageResult>) {
    r#ref.status = RefStatus::Ok;
    r#ref.extracted_at = Some(r.extracted_at.clone());
    r#ref.duration_ms = Some(r.result.duration_ms);
}

/// Shared freshness check: same sidecar body for both configurations and
/// packages. Returns the fields to stamp onto the ref, or None (stays pending).
fn reconcile_one(out_dir: &str, key: &CacheKey, data_file: &str) -> Option<(SidecarMeta, ())> {
    if !Path::new(out_dir).join(data_file).exists() {
        return None;
    }
    let meta: SidecarMeta =
        serde_json::from_str(&std::fs::read_to_string(sidecar_path(out_dir, data_file)).ok()?)
            .ok()?;
    if meta.extractor != FINGERPRINT {
        return None;
    }
    if meta.flake_key.as_deref() != Some(&key.flake_key)
        || meta.lock_hash.as_deref() != Some(&key.lock_hash)
    {
        return None;
    }
    Some((meta, ()))
}

/// Reconcile a freshly built manifest with blobs already on disk: refs whose
/// sidecar matches the current cache key flip to "ok".
pub fn reconcile(out_dir: &str, manifest: &mut Manifest) {
    let key = cache_key_of(manifest);
    let mut cached_warnings: Vec<String> = Vec::new();
    for r#ref in &mut manifest.configurations {
        if let Some((meta, ())) = reconcile_one(out_dir, &key, &r#ref.data_file) {
            r#ref.status = RefStatus::Ok;
            r#ref.extracted_at = Some(meta.extracted_at.clone());
            r#ref.duration_ms = Some(meta.duration_ms);
            if meta.option_count.is_some() {
                r#ref.option_count = meta.option_count;
            }
            cached_warnings.extend(meta.warnings.iter().map(|w| format!("[cached] {w}")));
        }
    }
    for r#ref in &mut manifest.packages {
        if let Some((meta, ())) = reconcile_one(out_dir, &key, &r#ref.data_file) {
            r#ref.status = RefStatus::Ok;
            r#ref.extracted_at = Some(meta.extracted_at.clone());
            r#ref.duration_ms = Some(meta.duration_ms);
            cached_warnings.extend(meta.warnings.iter().map(|w| format!("[cached] {w}")));
        }
    }
    manifest.warnings.extend(cached_warnings);
}
