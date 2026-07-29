// Extraction core: every module whose output can land in a cached blob or in
// the persisted manifest, and nothing else. build.rs fingerprints this crate's
// own sources, so crate membership — not a hand-maintained list — is what
// decides whether an edit invalidates a user's cached extractions.
//
// The test for whether something belongs here is "can its output be read back
// out of a blob or a sidecar later", not "does extraction call it". highlight
// is in because package.rs bakes tokenized phase scripts into PackageData;
// git is in because manifest.rs bakes per-file commits into the manifest.
// The orchestration that *drives* extraction (drive, serve) is deliberately
// out — see the residual-parameter note in build.rs for the one hazard that
// leaves behind.

pub mod cache;
pub mod git;
pub mod graph;
pub mod highlight;
pub mod manifest;
pub mod options;
pub mod package;
pub mod pathref;
pub mod run_nix;
pub mod scan;
pub mod schema;
