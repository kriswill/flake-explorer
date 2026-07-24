// Content fingerprint of the extraction code — the "code" half of the cache
// key (see src/extract/fingerprint.ts for the original rationale). Hashes
// every Rust source plus the embedded extract.nix and highlight queries, so
// any change to code that shapes blob contents invalidates cached blobs with
// no manual version bump. Deliberately distinct from the bun extractor's
// fingerprint: the two tools' token output differs, so their caches must not
// be shared.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest_dir.parent().unwrap();

    let mut files: Vec<PathBuf> = Vec::new();
    collect(&manifest_dir.join("src"), &mut files);
    files.push(manifest_dir.join("build.rs"));
    files.push(repo.join("src/extract/extract.nix"));
    files.push(repo.join("src/extract/vendor/nix-highlights.scm"));
    files.push(repo.join("src/extract/vendor/bash-highlights.scm"));
    files.sort();

    let mut hasher = Sha256::new();
    for f in &files {
        let rel = f.strip_prefix(repo).unwrap_or(f);
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(std::fs::read(f).unwrap_or_default());
        hasher.update([0]);
        println!("cargo:rerun-if-changed={}", f.display());
    }
    let digest = hex::encode(hasher.finalize());
    println!("cargo:rustc-env=FLAKE_EXPLORER_FINGERPRINT=rs-{}", &digest[..14]);
}

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}
