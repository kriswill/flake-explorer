// Extraction cache: a config blob is fresh
// when its sidecar records the same cache key a fresh extraction would use
// (extractor fingerprint + flake identity + lock hash). Sidecars live next
// to the blobs (config/<kind>.<name>.meta.json).

use crate::manifest::{FINGERPRINT, now_iso};
use crate::options::{ChunkHint, ExtractOptionsOpts, OptionsResult, ProgressFn, extract_options};
use crate::package::{PackageResult, extract_package};
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
    /// `nix --version` verbatim, e.g. "nix (Determinate Nix 3.21.5) 2.34.8".
    ///
    /// The host `nix` is the largest uncontrolled input to a blob: every eval
    /// runs `--impure`, `nix derivation show` and `nix flake show` have both
    /// changed output shape across releases (package.rs and manifest.rs each
    /// branch on which shape they got), and `path_info` reflects local store
    /// state. Before this was in the key, a nix upgrade could change what
    /// extraction produced while the key sat unmoved, and the stale blob was
    /// served with no signal at all.
    ///
    /// Deliberately the whole string rather than a parsed major.minor. Coarser
    /// would still close most of the hole and would re-extract less often, but
    /// it means choosing which of the two numbers here to keep, and dropping
    /// the Determinate wrapper version discards exactly the signal the
    /// lazy-trees concern in run_nix.rs turns on — a wrapper change at a
    /// constant underlying version. Erring coarse errs toward silently serving
    /// stale data, which is the direction this whole cache key is built to
    /// avoid. If the churn ever outweighs that, truncating here is a one-line
    /// change and the sidecar keeps enough to tell what happened.
    pub nix_version: String,
}

pub fn cache_key_of(manifest: &Manifest, nix_version: &str) -> CacheKey {
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
        nix_version: nix_version.to_string(),
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidecarMeta {
    /// All three optional only so older sidecars still parse; absent always
    /// means stale. nix_version is absent in every sidecar written before it
    /// joined the key, which is why adding it re-extracts once — see the field
    /// on CacheKey.
    flake_key: Option<String>,
    lock_hash: Option<String>,
    nix_version: Option<String>,
    extractor: String,
    extracted_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    option_count: Option<usize>,
    duration_ms: u64,
    warnings: Vec<String>,
    /// How the option tree split last time — a hint for the next WALK, never an
    /// input to freshness (see `partition_hint`). Additive: absent in every
    /// sidecar written before it existed, and `deny_unknown_fields` is not set,
    /// so a binary that predates it ignores it rather than choking.
    ///
    /// `Value` rather than the typed shape on purpose. This field is read out of
    /// files written by other versions of this program in both directions, and a
    /// plan that fails to parse must cost the re-splitting it would have saved
    /// and nothing else — so the typing happens in `partition_hint`, where a
    /// mismatch can be swallowed, instead of here, where it would take the whole
    /// sidecar down with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plan: Option<serde_json::Value>,
}

/// The recorded partition for a blob, or None.
///
/// Read WITHOUT consulting the cache key, deliberately, and that is the whole
/// design: a plan is only ever wanted when the key does NOT match, because a
/// matching key means the blob is served and nothing is walked. That includes
/// after a flake-explorer upgrade, when the fingerprint moves and every
/// configuration is re-extracted — the case where starting from a known
/// partition is worth the most. A partition describes how the FLAKE's option
/// tree splits, not how this program works, so one written by another version
/// is still a reasonable guess; and it is verified against what the eval
/// actually sees, so a wrong guess costs re-splitting.
///
/// What this must never do is influence whether the blob beside it is fresh.
/// That decision belongs to `reconcile_one` and its key comparison, alone.
pub fn partition_hint(out_dir: &str, data_file: &str) -> Option<Vec<ChunkHint>> {
    let raw = std::fs::read_to_string(sidecar_path(out_dir, data_file)).ok()?;
    let meta: SidecarMeta = serde_json::from_str(&raw).ok()?;
    let plan: Vec<ChunkHint> = serde_json::from_value(meta.plan?).ok()?;
    (!plan.is_empty()).then_some(plan)
}

fn sidecar_path(out_dir: &str, data_file: &str) -> PathBuf {
    let meta = if let Some(stripped) = data_file.strip_suffix(".json") {
        format!("{stripped}.meta.json")
    } else {
        format!("{data_file}.meta.json")
    };
    Path::new(out_dir).join(meta)
}

// One parameter per field the sidecar holds; bundling them into a struct would
// just be the same list spelled twice, since nothing else ever constructs one.
#[allow(clippy::too_many_arguments)]
fn write_sidecar(
    out_dir: &str,
    data_file: &str,
    key: &CacheKey,
    extracted_at: &str,
    option_count: Option<usize>,
    duration_ms: u64,
    warnings: &[String],
    plan: Option<&[ChunkHint]>,
) -> anyhow::Result<()> {
    let meta = SidecarMeta {
        flake_key: Some(key.flake_key.clone()),
        lock_hash: Some(key.lock_hash.clone()),
        nix_version: Some(key.nix_version.clone()),
        extractor: FINGERPRINT.to_string(),
        extracted_at: extracted_at.to_string(),
        option_count,
        duration_ms,
        warnings: warnings.to_vec(),
        // Written only when there is one, so a configuration whose option tree
        // never needed splitting adds nothing to its sidecar.
        plan: plan
            .filter(|p| !p.is_empty())
            .and_then(|p| serde_json::to_value(p).ok()),
    };
    std::fs::write(
        sidecar_path(out_dir, data_file),
        serde_json::to_string(&meta)?,
    )?;
    Ok(())
}

/// Defense in depth: dataFile derives from a Nix attr name (sanitized in
/// manifest.rs) — never let a hostile name write outside the data dir.
fn guarded_blob_path(out_dir: &str, data_file: &str) -> anyhow::Result<PathBuf> {
    let blob = Path::new(out_dir).join(data_file);
    let out_canon = std::fs::canonicalize(out_dir)?;
    // The blob may not exist yet; canonicalize its parent.
    let parent = blob
        .parent()
        .ok_or_else(|| anyhow::anyhow!("bad dataFile: {data_file}"))?;
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
    // Read unconditionally: getting here at all means the key did NOT match, so
    // the sidecar beside this blob is stale as DATA while still being the best
    // available guess at the SHAPE of the tree about to be walked.
    let hint = partition_hint(out_dir, &r#ref.data_file);
    let r = extract_options(
        flake_ref,
        r#ref.kind,
        &r#ref.name,
        ExtractOptionsOpts {
            timeout,
            on_progress,
            hint,
            ..Default::default()
        },
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
        Some(&r.partition),
    )?;
    Ok(Extracted {
        result: r,
        extracted_at,
    })
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
    write_sidecar(
        out_dir,
        &r#ref.data_file,
        key,
        &extracted_at,
        None,
        r.duration_ms,
        &r.warnings,
        None,
    )?;
    Ok(Extracted {
        result: r,
        extracted_at,
    })
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
        || meta.nix_version.as_deref() != Some(&key.nix_version)
    {
        return None;
    }
    Some((meta, ()))
}

/// Reconcile a freshly built manifest with blobs already on disk: refs whose
/// sidecar matches the current cache key flip to "ok". `nix_version` is the
/// string `check_nix` returned for this run — the caller has already had to
/// call it, so there is nothing to discover here.
pub fn reconcile(out_dir: &str, manifest: &mut Manifest, nix_version: &str) {
    let key = cache_key_of(manifest, nix_version);
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

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    /// The narrowest manifest reconcile will look at: one pending config ref
    /// pointing at `data_file`, and the flake identity + inputs that
    /// cache_key_of reads.
    fn manifest_with(data_file: &str) -> Manifest {
        Manifest {
            version: SCHEMA_VERSION,
            generated_at: "1970-01-01T00:00:00.000Z".into(),
            extractor: FINGERPRINT.to_string(),
            flake: FlakeInfo {
                r#ref: "/flake".into(),
                path: "/nix/store/flake".into(),
                description: None,
                rev: None,
                nar_hash: Some("sha256-aaaa".into()),
            },
            outputs: OutputNode::Attrset {
                children: IndexMap::new(),
            },
            inputs: IndexMap::new(),
            files: vec![],
            import_edges: vec![],
            input_refs: vec![],
            overlay_defs: None,
            input_follows: vec![],
            configurations: vec![ConfigRef {
                id: "nixos/host".into(),
                kind: ConfigKind::Nixos,
                name: "host".into(),
                data_file: data_file.into(),
                status: RefStatus::Pending,
                error: None,
                extracted_at: None,
                option_count: None,
                duration_ms: None,
            }],
            packages: vec![],
            package_reverse_deps: None,
            grafts: vec![],
            output_names: IndexMap::new(),
            warnings: vec![],
        }
    }

    /// A blob plus the sidecar a run under `nix_version` would have left.
    fn seed(dir: &Path, data_file: &str, nix_version: &str) {
        std::fs::create_dir_all(dir.join("config")).unwrap();
        std::fs::write(dir.join(data_file), "{}").unwrap();
        let key = cache_key_of(&manifest_with(data_file), nix_version);
        write_sidecar(
            dir.to_str().unwrap(),
            data_file,
            &key,
            "1970-01-01T00:00:00.000Z",
            Some(7),
            42,
            &[],
            None,
        )
        .unwrap();
    }

    /// Rewrite a sidecar's raw JSON, for the cases where the point is a shape
    /// this version would never write itself.
    fn patch_sidecar(dir: &Path, data_file: &str, f: impl FnOnce(&mut serde_json::Value)) {
        let path = sidecar_path(dir.to_str().unwrap(), data_file);
        let mut v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        f(&mut v);
        std::fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();
    }

    /// The separation that keeps a walk hint from becoming a freshness claim.
    ///
    /// A plan says how the option tree splits. It says nothing about whether the
    /// blob next to it is still valid, and the moment those two are allowed to
    /// touch, a stale blob with a plausible plan starts getting served. So a
    /// sidecar whose plan is present and perfectly good but whose key does not
    /// match is stale, exactly as if the plan were absent.
    #[test]
    fn a_plan_never_makes_a_stale_sidecar_look_fresh() {
        let dir = std::env::temp_dir().join(format!("fe-plan-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data_file = "config/nixos.host.json";
        seed(&dir, data_file, "nix (Nix) 2.34.8");
        patch_sidecar(&dir, data_file, |v| {
            v.as_object_mut().unwrap().insert(
                "plan".into(),
                serde_json::json!([{ "path": ["services"], "children": ["nginx"] }]),
            );
        });

        // The plan is readable — this is not a test about an unreadable one.
        assert!(partition_hint(dir.to_str().unwrap(), data_file).is_some());

        let mut stale = manifest_with(data_file);
        reconcile(dir.to_str().unwrap(), &mut stale, "nix (Nix) 2.35.0");
        assert_eq!(
            stale.configurations[0].status,
            RefStatus::Pending,
            "a plan must not vote on freshness"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Sidecars on disk were written by other versions of this program, in both
    /// directions: older ones have no plan at all, newer ones may have a shape
    /// this version has never heard of. Every one of those reads as "no hint" —
    /// never an error, never a warning, because a hint that cannot be read costs
    /// exactly one thing, which is the re-splitting it would have saved.
    #[test]
    fn an_unreadable_plan_reads_as_no_hint() {
        let dir = std::env::temp_dir().join(format!("fe-plan-junk-{}", std::process::id()));
        let data_file = "config/nixos.host.json";
        let at = dir.to_str().unwrap();

        for (name, junk) in [
            ("absent", None),
            ("null", Some(serde_json::json!(null))),
            ("a string", Some(serde_json::json!("services.nginx"))),
            (
                "an object",
                Some(serde_json::json!({"services": ["nginx"]})),
            ),
            (
                "entries of the wrong shape",
                Some(serde_json::json!([1, 2])),
            ),
            (
                "an entry missing its path",
                Some(serde_json::json!([{ "children": ["nginx"] }])),
            ),
        ] {
            let _ = std::fs::remove_dir_all(&dir);
            seed(&dir, data_file, "nix (Nix) 2.34.8");
            if let Some(j) = junk {
                patch_sidecar(&dir, data_file, |v| {
                    v.as_object_mut().unwrap().insert("plan".into(), j);
                });
            }
            assert!(
                partition_hint(at, data_file).is_none(),
                "a plan that is {name} should read as no hint"
            );
            // And the sidecar is still a sidecar: an unreadable plan must not
            // take the freshness decision down with it.
            let mut m = manifest_with(data_file);
            reconcile(at, &mut m, "nix (Nix) 2.34.8");
            assert_eq!(
                m.configurations[0].status,
                RefStatus::Ok,
                "an unreadable plan broke reconcile ({name})"
            );
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reason nix_version is in the key at all: a nix upgrade can change
    /// what extraction produces, and before this the blob stayed "fresh".
    #[test]
    fn nix_version_change_invalidates_the_blob() {
        let dir = std::env::temp_dir().join(format!("fe-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data_file = "config/nixos.host.json";
        seed(&dir, data_file, "nix (Nix) 2.34.8");

        // Same nix → reused.
        let mut same = manifest_with(data_file);
        reconcile(dir.to_str().unwrap(), &mut same, "nix (Nix) 2.34.8");
        assert_eq!(same.configurations[0].status, RefStatus::Ok);
        assert_eq!(same.configurations[0].option_count, Some(7));

        // Upgraded nix → stays pending, so the config is re-extracted.
        let mut upgraded = manifest_with(data_file);
        reconcile(dir.to_str().unwrap(), &mut upgraded, "nix (Nix) 2.35.0");
        assert_eq!(upgraded.configurations[0].status, RefStatus::Pending);

        // A patch bump counts too — the key is the whole version string, so
        // this is the deliberate cost of not parsing out major.minor.
        let mut patch = manifest_with(data_file);
        reconcile(dir.to_str().unwrap(), &mut patch, "nix (Nix) 2.34.9");
        assert_eq!(patch.configurations[0].status, RefStatus::Pending);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Sidecars written before nix_version joined the key have no such field.
    /// Absent must read as stale, not as "matches".
    #[test]
    fn sidecar_without_nix_version_is_stale() {
        let dir = std::env::temp_dir().join(format!("fe-cache-old-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let data_file = "config/nixos.host.json";
        seed(&dir, data_file, "nix (Nix) 2.34.8");

        // Rewrite the sidecar as a pre-upgrade one: drop nixVersion entirely.
        let path = sidecar_path(dir.to_str().unwrap(), data_file);
        let raw = std::fs::read_to_string(&path).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        v.as_object_mut().unwrap().remove("nixVersion");
        assert!(v.get("flakeKey").is_some(), "kept the rest of the sidecar");
        std::fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();

        let mut m = manifest_with(data_file);
        reconcile(dir.to_str().unwrap(), &mut m, "nix (Nix) 2.34.8");
        assert_eq!(m.configurations[0].status, RefStatus::Pending);

        std::fs::remove_dir_all(&dir).ok();
    }
}
