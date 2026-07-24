// Library surface of the Rust flake-explorer. The crate is a lib + thin bin
// so the integration tests under tests/ (mini-flake fixture, nix-shim serve
// and degradation suites) can link against the real modules — a binary-only
// crate's tests/ cannot import anything.

pub mod cache;
pub mod drive;
pub mod export;
pub mod git;
pub mod highlight;
pub mod manifest;
pub mod options;
pub mod package;
pub mod page;
pub mod pathref;
pub mod reverse_deps;
pub mod run_nix;
pub mod scan;
pub mod schema;
pub mod serve;
