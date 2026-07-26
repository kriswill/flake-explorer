// Guards on one property: a cached blob is a function of the extraction crate's
// code and the flake, and of nothing else. The crate split made that property
// structural, but structure is where files sit — checked by nobody — so these
// two tests are the only thing in the repo that fails when it stops holding.
//
// Read the second test's comment before trusting it too far: it catches the
// mechanism by which root-crate code could start shaping blob bytes, not every
// conceivable route, and the difference is spelled out there.

mod common;

use common::{TempDir, fixture, nix_available};
use flake_explorer::drive::{DriveFlags, Selection, extract_to_dir};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

/// Extract the same fixture into fresh data dirs repeatedly and require the
/// blob bytes to match. Before options were sorted by loc this failed: the
/// chunk walk accumulates results in completion order on a pool sized from
/// available_parallelism(), and ten runs on a 10-core host produced five
/// distinct blob hashes.
///
/// Four runs rather than two on purpose. As a regression detector this is
/// probabilistic — if the sort were removed, two runs would still agree
/// whenever scheduling happened to land in order, which was about 40% of the
/// time on the measured host. Four runs cuts that to a few percent. The
/// sortedness assertion below is the deterministic half: it checks the
/// invariant the code actually guarantees rather than a consequence of it.
#[tokio::test]
async fn blob_bytes_are_identical_across_runs() {
    if !nix_available() {
        return;
    }
    let flake_ref = fixture().canonicalize().unwrap().display().to_string();
    let tmp = TempDir::new("fe-determinism");

    let mut blobs: Vec<String> = Vec::new();
    for i in 0..4 {
        let out = tmp.0.join(format!("run{i}"));
        std::fs::create_dir_all(&out).unwrap();
        extract_to_dir(
            &flake_ref,
            &DriveFlags {
                out: out.display().to_string(),
                configs: Selection::Ids(vec!["nixos/mini".to_string()]),
                packages: Selection::None,
                all_systems: false,
                timeout: Duration::from_secs(60),
            },
        )
        .await
        .unwrap();
        blobs.push(std::fs::read_to_string(out.join("config/nixos.mini.json")).unwrap());
    }

    for (i, b) in blobs.iter().enumerate().skip(1) {
        assert_eq!(
            &blobs[0], b,
            "blob bytes differ between run 0 and run {i} — extraction is no \
             longer deterministic, so the same flake now caches different data \
             depending on which machine extracted it (see the sort in \
             crates/extract/src/options.rs)"
        );
    }

    // The invariant itself, not a symptom of it.
    let data: serde_json::Value = serde_json::from_str(&blobs[0]).unwrap();
    let locs: Vec<Vec<String>> = data["options"]
        .as_array()
        .expect("options array")
        .iter()
        .map(|o| {
            o["loc"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| s.as_str().unwrap().to_string())
                .collect()
        })
        .collect();
    assert!(locs.len() >= 2, "fixture should yield several options");
    assert!(
        locs.windows(2).all(|w| w[0] <= w[1]),
        "options are not sorted by loc: {locs:?}"
    );
}

/// The boundary tripwire, and the limits of it.
///
/// The failure this exists for is not "someone edits serve.rs" — the fingerprint
/// already ignores that on purpose. It is someone adding code to the ROOT crate
/// that writes a persisted artifact. That compiles cleanly today: the root crate
/// depends on the extraction crate, so every schema type is in scope and a new
/// serve.rs helper could build a ConfigData and write it to the data dir, giving
/// blobs a content model the fingerprint does not describe and no error to
/// notice.
///
/// So the check is on write sites: the root crate is allowed exactly the two it
/// has, and both are artifacts the cache never serves — drive.rs writes
/// manifest.json, which is regenerated on every run and read back by nothing,
/// and export.rs writes the standalone HTML. Any third one fails here.
///
/// What it does NOT catch, stated plainly rather than implied:
///
/// - A root-crate value reaching a blob through an extraction-crate API. That
///   needs the extraction crate's signature to change, which moves the
///   fingerprint, so it is covered — except through parameters that already
///   exist (the timeout, the refs handed to extract_and_persist). Those are the
///   documented residual in crates/extract/build.rs, and no source-shape test
///   reaches them.
/// - Anything at all inside crates/extract, which is the fingerprint's job.
///
/// It is also a lexical check, so it is a prompt to think rather than a proof.
/// That is deliberately the safe direction: the allowlist below going stale
/// fails this test loudly, where the curated hash list this branch removed would
/// have gone quiet.
#[test]
fn root_crate_persists_nothing_but_the_manifest_and_the_export() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    let mut scanned = 0usize;

    let mut stack = vec![src.clone()];
    while let Some(dir) = stack.pop() {
        for e in std::fs::read_dir(&dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if p.extension().is_some_and(|x| x == "rs") {
                scanned += 1;
                let text = std::fs::read_to_string(&p).unwrap();
                let hits = text
                    .lines()
                    .filter(|l| !l.trim_start().starts_with("//"))
                    .filter(|l| {
                        l.contains("fs::write(")
                            || l.contains("File::create(")
                            || l.contains("OpenOptions")
                            || l.contains(".write_all(")
                    })
                    .count();
                if hits > 0 {
                    let name = p.file_name().unwrap().to_string_lossy().to_string();
                    *found.entry(name).or_default() += hits;
                }
            }
        }
    }

    assert!(
        scanned >= 5,
        "expected to scan the root crate, saw {scanned}"
    );
    let expected: BTreeMap<String, usize> =
        [("drive.rs".to_string(), 1), ("export.rs".to_string(), 1)]
            .into_iter()
            .collect();
    assert_eq!(
        found, expected,
        "the root crate's set of file-writing sites changed.\n\
         Allowed: drive.rs writes manifest.json (regenerated every run, read \
         back by nothing) and export.rs writes the standalone HTML.\n\
         A new write here can put bytes on disk that the extraction \
         fingerprint does not describe. If the new site persists anything the \
         cache serves, it belongs in crates/extract so the fingerprint covers \
         it. If it genuinely does not, add it above with a note saying why."
    );
}
