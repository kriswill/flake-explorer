// Content fingerprint of the extraction code — the "code" half of the cache
// key (see src/cache.rs). Hashes every Rust source plus the embedded
// extract.nix and highlight queries, so any change to code that shapes blob
// contents invalidates cached blobs with no manual version bump.
// Deliberately the whole tree rather than a curated list: orchestration-only
// edits cost one spurious re-extraction, while a forgotten list entry would
// silently serve stale data.

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
