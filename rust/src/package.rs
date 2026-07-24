// Extraction of one derivation-typed output — port of src/extract/package.ts:
// eval (name/pname/version/meta/deps/markers) + `nix derivation show` +
// `nix path-info` per output. Instantiation only, never builds.

use crate::highlight::tokenize_bash;
use crate::run_nix::{derivation_show, eval_extract, path_info, ExtractArgs, PackageEval};
use crate::schema::*;
use indexmap::IndexMap;
use serde_json::Value;
use std::time::{Duration, Instant};

pub struct PackageResult {
    pub data: PackageData,
    pub warnings: Vec<String>,
    pub duration_ms: u64,
}

pub async fn extract_package(
    flake_ref: &str,
    id: &str,
    path: &[String],
    timeout: Duration,
) -> anyhow::Result<PackageResult> {
    let start = Instant::now();
    let mut warnings: Vec<String> = Vec::new();

    let ev: PackageEval = eval_extract(
        &ExtractArgs {
            flake_ref: flake_ref.to_string(),
            mode: "package",
            path: Some(path.to_vec()),
            ..Default::default()
        },
        timeout,
    )
    .await?;

    if !ev.is_drv {
        anyhow::bail!("{id} is not a derivation (output may have changed since the last refresh)");
    }
    if ev.meta_error {
        warnings.push(format!(
            "meta unavailable for {id} (broken/unfree package?)"
        ));
    }

    let drv = match derivation_show(flake_ref, path, timeout).await {
        Ok(raw) => {
            let drv = normalize_derivation_show(&raw);
            if drv.is_none() {
                warnings.push(format!("{id}: derivation show returned no entry"));
            }
            drv
        }
        Err(e) => {
            warnings.push(format!(
                "{id}: derivation show failed: {}",
                e.to_string().lines().next().unwrap_or("")
            ));
            None
        }
    };

    let mut runtime: IndexMap<String, RuntimeInfo> = IndexMap::new();
    for out in &ev.outputs {
        let Some(out_path) = &out.path else { continue };
        match path_info(out_path, timeout).await {
            Ok(Some(info)) => {
                runtime.insert(
                    out.name.clone(),
                    RuntimeInfo {
                        out_path: out_path.clone(),
                        references: info.references,
                        nar_size: Some(info.nar_size),
                        closure_size: info.closure_size,
                    },
                );
            }
            Ok(None) => {}
            Err(e) => warnings.push(format!(
                "{id}: path-info failed for output \"{}\": {}",
                out.name,
                e.to_string().lines().next().unwrap_or("")
            )),
        }
    }

    let has_phases = drv.as_ref().is_some_and(|d| !d.phases.is_empty());
    let data = PackageData {
        version: SCHEMA_VERSION,
        id: id.to_string(),
        path: path.to_vec(),
        name: ev.name.clone(),
        pname: ev.pname.clone(),
        pkg_version: ev.pkg_version.clone(),
        builder: classify_builder(&ev.markers, &ev.deps.native_build_inputs, has_phases),
        stdenv: ev.stdenv.clone(),
        system: ev.system.clone(),
        meta: ev.meta.as_ref().map(normalize_package_meta),
        src: ev.src.as_ref().map(|s| PackageSrc {
            store_path: s.store_path.clone(),
            url: s.url.clone(),
            rev: s.rev.clone(),
            output_hash: s.output_hash.clone(),
        }),
        outputs: ev
            .outputs
            .iter()
            .map(|o| PackageOutput {
                name: o.name.clone(),
                out_path: o.path.clone(),
            })
            .collect(),
        deps: ev.deps.clone(),
        drv,
        runtime: (!runtime.is_empty()).then_some(runtime),
        warnings: warnings.clone(),
    };

    Ok(PackageResult {
        data,
        warnings,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

// --------------------------------------------------------- classify_builder

/// markers first, then a nativeBuildInputs hook-name scan, then phase
/// presence -> plain stdenv, else unknown.
pub fn classify_builder(
    markers: &crate::run_nix::PackageMarkers,
    native_build_inputs: &[String],
    has_phases: bool,
) -> BuilderKind {
    if markers.cargo_deps {
        return BuilderKind::RustPlatform;
    }
    if markers.go_modules {
        return BuilderKind::BuildGoModule;
    }
    if markers.npm_deps {
        return BuilderKind::Node;
    }
    if markers.build_command {
        return BuilderKind::Trivial;
    }
    let hooks: [(regex::Regex, BuilderKind); 3] = [
        (
            regex::Regex::new(r"(?i)cargo-build-hook|rust-cargo").unwrap(),
            BuilderKind::RustPlatform,
        ),
        (
            regex::Regex::new(r"(?i)go-modules-hook").unwrap(),
            BuilderKind::BuildGoModule,
        ),
        (
            regex::Regex::new(r"(?i)npm-install-hook|node-gyp").unwrap(),
            BuilderKind::Node,
        ),
    ];
    for dep in native_build_inputs {
        for (re, kind) in &hooks {
            if re.is_match(dep) {
                return *kind;
            }
        }
    }
    if has_phases {
        BuilderKind::Stdenv
    } else {
        BuilderKind::Unknown
    }
}

// ---------------------------------------------------- normalize_derivation_show

const PHASE_CAP: usize = 4000;

/// Main build phases in execution order, each with its pre/post hook variable.
const PHASE_ORDER: [(&str, Option<&str>, Option<&str>); 9] = [
    ("unpackPhase", Some("preUnpack"), Some("postUnpack")),
    ("patchPhase", Some("prePatch"), Some("postPatch")),
    (
        "configurePhase",
        Some("preConfigure"),
        Some("postConfigure"),
    ),
    ("buildPhase", Some("preBuild"), Some("postBuild")),
    ("checkPhase", Some("preCheck"), Some("postCheck")),
    ("installPhase", Some("preInstall"), Some("postInstall")),
    ("fixupPhase", Some("preFixup"), Some("postFixup")),
    (
        "installCheckPhase",
        Some("preInstallCheck"),
        Some("postInstallCheck"),
    ),
    ("buildCommand", None, None),
];

fn phases_from_env(env: &serde_json::Map<String, Value>) -> Vec<DrvPhase> {
    let mut scripts: Vec<(String, String)> = Vec::new();
    let mut push_if_present = |name: &str| {
        if let Some(Value::String(script)) = env.get(name) {
            if !script.is_empty() {
                let capped = if script.chars().count() > PHASE_CAP {
                    let head: String = script.chars().take(PHASE_CAP).collect();
                    format!("{head}\n… truncated")
                } else {
                    script.clone()
                };
                scripts.push((name.to_string(), capped));
            }
        }
    };
    for (key, pre, post) in PHASE_ORDER {
        if let Some(p) = pre {
            push_if_present(p);
        }
        push_if_present(key);
        if let Some(p) = post {
            push_if_present(p);
        }
    }
    scripts
        .into_iter()
        .map(|(name, script)| {
            let tokens = tokenize_bash(&script);
            DrvPhase {
                name,
                script,
                tokens,
            }
        })
        .collect()
}

fn name_from_drv_basename(basename: &str) -> String {
    let re = regex::Regex::new(r"^[a-z0-9]{32}-(.+)\.drv$").unwrap();
    match re.captures(basename) {
        Some(c) => c[1].to_string(),
        None => basename
            .strip_suffix(".drv")
            .unwrap_or(basename)
            .to_string(),
    }
}

/// `nix derivation show` returns bare store-path BASENAMES as both its
/// top-level key and each output's `path`. Newer nix wraps the result in
/// {"derivations": {...}} and nests input drvs under `inputs.drvs`; older nix
/// returns the drv map at top level with `inputDrvs`. Both normalized here.
pub fn normalize_derivation_show(raw: &Value) -> Option<DrvInfo> {
    let r = raw.as_object()?;
    let container = match r.get("derivations").and_then(|d| d.as_object()) {
        Some(d) => d,
        None => r,
    };
    let (basename, entry) = container.iter().next()?;
    let e = entry.as_object()?;

    let nested = e
        .get("inputs")
        .and_then(|i| i.get("drvs"))
        .and_then(|d| d.as_object());
    let flat = e.get("inputDrvs").and_then(|d| d.as_object());
    let raw_input_drvs = nested.or(flat);
    let input_drvs: Vec<DrvInputRef> = raw_input_drvs
        .map(|m| {
            m.iter()
                .map(|(drv_basename, info)| DrvInputRef {
                    drv_path: format!("/nix/store/{drv_basename}"),
                    name: name_from_drv_basename(drv_basename),
                    outputs: info
                        .get("outputs")
                        .and_then(|o| o.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();

    let empty = serde_json::Map::new();
    let env = e.get("env").and_then(|v| v.as_object()).unwrap_or(&empty);
    let env_flag = |k: &str| {
        env.contains_key(k)
            .then(|| env.get(k).and_then(|v| v.as_str()) == Some("1"))
    };

    Some(DrvInfo {
        drv_path: format!("/nix/store/{basename}"),
        system: e
            .get("system")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        builder_path: e
            .get("builder")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        input_drvs,
        phases: phases_from_env(env),
        do_check: env_flag("doCheck"),
        strict_deps: env_flag("strictDeps"),
        structured_attrs: env_flag("__structuredAttrs"),
    })
}

// -------------------------------------------------------- normalize_package_meta

const MAX_MAINTAINERS: usize = 20;
const MAX_PLATFORMS: usize = 64;

fn as_string(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn normalize_license(v: &Value) -> Vec<PackageLicense> {
    match v {
        Value::Null => Vec::new(),
        Value::String(s) => vec![PackageLicense {
            short_name: Some(s.clone()),
            full_name: None,
            spdx_id: None,
            url: None,
            free: None,
        }],
        Value::Array(a) => a.iter().flat_map(normalize_license).collect(),
        Value::Object(o) => vec![PackageLicense {
            short_name: as_string(o.get("shortName")),
            full_name: as_string(o.get("fullName")),
            spdx_id: as_string(o.get("spdxId")),
            url: as_string(o.get("url")),
            free: o.get("free").and_then(|f| f.as_bool()),
        }],
        _ => Vec::new(),
    }
}

fn normalize_maintainers(v: Option<&Value>) -> Vec<PackageMaintainer> {
    let Some(Value::Array(a)) = v else {
        return Vec::new();
    };
    a.iter()
        .take(MAX_MAINTAINERS)
        .map(|m| {
            let o = m.as_object();
            PackageMaintainer {
                name: as_string(o.and_then(|o| o.get("name"))),
                github: as_string(o.and_then(|o| o.get("github"))),
                email: as_string(o.and_then(|o| o.get("email"))),
            }
        })
        .collect()
}

/// Shapes extract.nix's raw scrubbed `meta` attrset into PackageMeta.
pub fn normalize_package_meta(raw: &serde_json::Map<String, Value>) -> PackageMeta {
    let license = raw
        .get("license")
        .map(normalize_license)
        .unwrap_or_default();
    let maintainers = normalize_maintainers(raw.get("maintainers"));
    let platforms: Option<Vec<String>> = raw.get("platforms").and_then(|p| p.as_array()).map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(String::from))
            .take(MAX_PLATFORMS)
            .collect()
    });
    PackageMeta {
        description: as_string(raw.get("description")),
        homepage: as_string(raw.get("homepage")),
        license: (!license.is_empty()).then_some(license),
        platforms: platforms.filter(|p| !p.is_empty()),
        main_program: as_string(raw.get("mainProgram")),
        maintainers: (!maintainers.is_empty()).then_some(maintainers),
        position: as_string(raw.get("position")),
        broken: raw.get("broken").and_then(|v| v.as_bool()),
        unfree: raw.get("unfree").and_then(|v| v.as_bool()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn derivation_show_both_shapes() {
        let drv_body = json!({
            "system": "x86_64-linux",
            "builder": "/bin/bash",
            "env": {"buildPhase": "make", "doCheck": "1"},
            "inputDrvs": {
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-hello-2.12.drv": {"outputs": ["out"]}
            }
        });
        let old = json!({"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pkg-1.0.drv": drv_body});
        let d = normalize_derivation_show(&old).unwrap();
        assert_eq!(
            d.drv_path,
            "/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pkg-1.0.drv"
        );
        assert_eq!(d.input_drvs[0].name, "hello-2.12");
        assert_eq!(d.do_check, Some(true));
        assert_eq!(d.phases.len(), 1);

        let new = json!({"version": 4, "derivations": {"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-pkg-1.0.drv": drv_body}});
        let d2 = normalize_derivation_show(&new).unwrap();
        assert_eq!(d2.drv_path, d.drv_path);
    }

    #[test]
    fn license_shapes() {
        assert_eq!(
            normalize_license(&json!("mit"))[0].short_name.as_deref(),
            Some("mit")
        );
        let l = normalize_license(&json!([{"spdxId": "MIT", "free": true}, "gpl3"]));
        assert_eq!(l.len(), 2);
        assert_eq!(l[0].spdx_id.as_deref(), Some("MIT"));
        assert_eq!(l[0].free, Some(true));
    }
}
