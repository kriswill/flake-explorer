# The Rust flake-explorer, built with crane. crane over rustPlatform for one
# decisive reason: buildDepsOnly compiles the (large: tokio/axum/tree-sitter)
# dependency tree as its OWN derivation keyed only by Cargo.lock, so CI
# rebuilds just this crate on source changes while the dep layer stays in the
# binary cache. It also provides the cargoClippy/cargoLlvmCov drivers the
# flake's checks reuse (same dep layer, no second compile of dependencies).
#
# The Svelte SPA is NOT compiled here — bun owns that. appDist runs the
# repo's own bundle script against the vendored node_modules and the result
# is installed to $out/share/flake-explorer/app-dist, one of the locations
# the binary probes at runtime (see rust/src/page.rs).
{
  lib,
  stdenvNoCC,
  bun,
  git,
  makeBinaryWrapper,
  rustc,
  craneLib,
  # The bun package's fixed-output node_modules derivation (package.nix
  # passthru) — reused so both packages vendor the same lockfile once.
  node_modules,
}:
let
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  # Everything the cargo build reads: the crate itself plus the repo files
  # build.rs hashes and the sources include_str! (extract.nix, highlight
  # queries). Rooted at the repo so ../src/... paths resolve in-tree.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./build.rs
      ./src
      ../src/extract/extract.nix
      ../src/extract/vendor/nix-highlights.scm
      ../src/extract/vendor/bash-highlights.scm
    ];
  };

  # crane's documented subdirectory pattern: unpack the whole repo tree, then
  # make rust/ the build root — ../src/extract stays reachable as a sibling.
  commonArgs = {
    pname = "flake-explorer-rs";
    inherit src version;
    cargoToml = ./Cargo.toml;
    cargoLock = ./Cargo.lock;
    postUnpack = ''
      cd $sourceRoot/rust
      sourceRoot="."
    '';
    strictDeps = true;
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

  # The prebuilt SPA bundle (app.js/app.css/meta.json) via the repo's own
  # bundle script. Only what the script's import graph reaches ships in.
  appDist = stdenvNoCC.mkDerivation {
    pname = "flake-explorer-app-dist";
    inherit version;
    src = lib.fileset.toSource {
      root = ../.;
      fileset = lib.fileset.difference (lib.fileset.unions [
        ../scripts/bundle-app.ts
        ../src
        ../app
        ../package.json
        ../tsconfig.json
        ../LICENSE
      ]) (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ../.);
    };
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      ln -s ${node_modules}/node_modules node_modules
      bun scripts/bundle-app.ts --out $out
      runHook postBuild
    '';
    dontInstall = true;
  };
in
craneLib.buildPackage (
  commonArgs
  // {
    inherit cargoArtifacts;
    nativeBuildInputs = [ makeBinaryWrapper ];
    # git backs per-file last-commit lookups; nix is deliberately resolved
    # from the caller's PATH (same stance as the bun wrapper) so store paths
    # and the flake registry match the host system.
    postInstall = ''
      mkdir -p $out/share/flake-explorer
      ln -s ${appDist} $out/share/flake-explorer/app-dist
      wrapProgram $out/bin/flake-explorer \
        --prefix PATH : ${lib.makeBinPath [ git ]}
    '';

    passthru = {
      inherit cargoArtifacts appDist;
      checks = {
        clippy = craneLib.cargoClippy (
          commonArgs
          // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- --deny warnings";
          }
        );
        test = craneLib.cargoTest (commonArgs // { inherit cargoArtifacts; });
        # lcov at $out (crane's default cargoLlvmCovExtraArgs) — CI rewrites
        # the SF paths to repo-relative and feeds octocov. cargo-llvm-cov
        # looks for rustup's llvm-tools-preview; point it at the LLVM that
        # built this rustc instead (profraw format must match).
        coverage = craneLib.cargoLlvmCov (
          commonArgs
          // {
            inherit cargoArtifacts;
            LLVM_COV = "${rustc.llvmPackages.llvm}/bin/llvm-cov";
            LLVM_PROFDATA = "${rustc.llvmPackages.llvm}/bin/llvm-profdata";
          }
        );
      };
    };

    meta = {
      description = "Interactive visualizer for Nix flakes (Rust extractor/server)";
      homepage = "https://github.com/kriswill/flake-explorer";
      license = lib.licenses.mit;
      mainProgram = "flake-explorer";
      platforms = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      maintainers = [ { github = "kriswill"; } ];
    };
  }
)
