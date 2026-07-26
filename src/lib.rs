// Library surface of flake-explorer. The crate is a lib + thin bin so the
// integration tests under tests/ (mini-flake fixture, nix-shim serve and
// degradation suites) can link against the real modules — a binary-only
// crate's tests/ cannot import anything.
//
// The modules declared here are the orchestration/presentation half: they read
// blobs and render them, and none of them can shape blob contents. The half
// that can lives in flake-explorer-extract, whose sources are content-hashed
// into the extraction cache key (see crates/extract/build.rs).

pub mod drive;
pub mod export;
pub mod page;
pub mod reverse_deps;
pub mod serve;
pub mod timing;

// Re-exported so `flake_explorer::schema` (and `crate::schema` from the
// modules above) keeps naming the one shared definition rather than a second
// copy. tests/ and the SPA contract both address the extractor through these
// paths, and the split is not meant to be a rename.
pub use flake_explorer_extract::{
    cache, git, highlight, manifest, options, package, pathref, run_nix, scan, schema,
};
