// Content fingerprint of the extraction code — the "code" half of the cache
// key (see src/cache.rs). Hashes every Rust source of THIS crate plus the
// embedded extract.nix and highlight queries, so any change to code that
// shapes blob contents invalidates cached blobs with no manual version bump.
//
// The boundary is the crate, not a curated list of files. A list was always
// the obvious way to stop orchestration-only edits — serve.rs, page.rs,
// export.rs — from throwing away every user's cached extractions, and it was
// always the wrong way: a forgotten entry serves stale data with no error
// message, while the whole-tree hash it would have replaced only ever cost one
// spurious re-extraction. Hashing a crate keeps the safe direction of that
// trade and deletes the failure mode instead of accepting it. There is no list
// to forget an entry from, and a module outside this crate cannot end up in a
// blob because it cannot be reached from inside one.
//
// What the crate boundary does NOT cover: extraction PARAMETERS come from the
// binary crate and this hash cannot see them. Exactly one does — the timeout,
// threaded from main.rs's --timeout through drive.rs and serve.rs into
// extract_options. (concurrency and skip_invisible are ExtractOptionsOpts
// defaults, so they live in here. Which configurations get requested is not a
// blob-contents question: blobs are per-configuration, so an unrequested one
// stays pending rather than being written thin.) A timeout is an eval failure
// like any other, so too short a one walks options.rs's ladder — split, then
// values skipped, then descriptions skipped, then abandoned — and writes a
// genuinely thinner blob. Its sidecar records nothing about the timeout that
// produced it, so it is then fresh forever.
//
// That hazard is real, but it is not new and it is not something this hash was
// ever protecting. --timeout is a runtime input: the same binary at the same
// fingerprint already accepts a blob extracted under `--timeout 5` as fresh for
// a later `--timeout 600`. Hashing source cannot close that. All the whole-tree
// hash covered was the narrower case of someone editing the default in the
// binary crate, and that is the entire cost of moving to a crate boundary.
// Two properties bound it: degradation only ever subtracts — the ladder drops
// values and descriptions, it cannot invent a wrong one — and it is loud, since
// every rung taken and every chunk abandoned pushes a warning into the sidecar
// that reconcile re-emits as "[cached] …" on every later run. A degraded blob
// keeps announcing itself for as long as it is cached, which is the opposite of
// the silent-stale-data failure the curated list would have risked.
//
// If the parameter hole is ever worth closing, the fix is to record the
// degradation-relevant parameters in the sidecar, so a blob extracted under a
// tighter timeout is stale by construction. That closes the CLI-flag case as
// well, which no amount of source hashing reaches.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn main() {
    let root = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());

    let mut files: Vec<PathBuf> = Vec::new();
    collect(&root.join("src"), &mut files);
    files.push(root.join("build.rs"));
    files.push(root.join("src/extract.nix"));
    files.push(root.join("src/vendor/nix-highlights.scm"));
    files.push(root.join("src/vendor/bash-highlights.scm"));
    files.sort();
    files.dedup();

    let mut hasher = Sha256::new();
    for f in &files {
        let rel = f.strip_prefix(&root).unwrap_or(f);
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(f).unwrap_or_default());
        hasher.update([0]);
        println!("cargo:rerun-if-changed={}", f.display());
    }
    let digest = hex::encode(hasher.finalize());
    println!(
        "cargo:rustc-env=FLAKE_EXPLORER_FINGERPRINT=rs-{}",
        &digest[..14]
    );
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}
