# flake-explorer: a native binary (crane-built Rust) plus the bun-built
# Svelte SPA bundle it serves. crane's buildDepsOnly compiles the dependency
# tree as its own derivation keyed only by Cargo.lock, so CI rebuilds just
# this crate on source changes while the dep layer stays in the binary cache.
#
# The SPA is compiled by bun (scripts/bundle-app.ts) against a fixed-output
# node_modules derivation, and installed to $out/share/flake-explorer/app-dist
# — one of the locations the binary probes at runtime (src/page.rs). The nix
# binary is resolved from the caller's PATH, never vendored, so store paths
# and the flake registry match the host system.
{
  lib,
  stdenvNoCC,
  bun,
  git,
  makeBinaryWrapper,
  rustc,
  craneLib,
}:
let
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

  # Everything the cargo build reads: the crate plus the files build.rs
  # hashes and the sources include_str! (extract.nix, highlight queries).
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./build.rs
      ./src
    ];
  };

  commonArgs = {
    pname = "flake-explorer";
    inherit src version;
    strictDeps = true;
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

  # The lock is pure JS — no os/cpu-conditional packages, no install scripts —
  # so one hash serves every platform. --omit=optional: the only optional dep
  # is the `bun` npm package (npx/bunx fallback runtime). Refresh the hash
  # (bun.lock or nixpkgs bun changes): set lib.fakeHash, then build
  # .#flake-explorer.passthru.node_modules and copy the "got:" value.
  node_modules = stdenvNoCC.mkDerivation {
    pname = "flake-explorer-node_modules";
    version = "0";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.unions [
        ./package.json
        ./bun.lock
      ];
    };
    nativeBuildInputs = [ bun ];
    dontConfigure = true;
    impureEnvVars = lib.fetchers.proxyImpureEnvVars ++ [
      "GIT_PROXY_COMMAND"
      "SOCKS_SERVER"
    ];
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
      bun install \
        --frozen-lockfile \
        --ignore-scripts \
        --no-progress \
        --omit=optional \
        --cpu="*" \
        --os="*"
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      mkdir $out
      cp -R node_modules $out/node_modules
      runHook postInstall
    '';
    # Fixup would patch shebangs into store paths — forbidden in a
    # fixed-output derivation.
    dontFixup = true;
    outputHash = "sha256-rgKwkT7j25TumcfMCf0weJ65Dq82ueL0cnNPWPEmUQo=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  # Everything the SPA bundle script's import graph reaches.
  appSrc = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference (lib.fileset.unions [
      ./scripts/bundle-app.ts
      ./scripts/build-app.ts
      ./scripts/licenses.ts
      ./app
      ./package.json
      ./tsconfig.json
      ./LICENSE
    ]) (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ./.);
  };

  # The prebuilt SPA bundle (app.js/app.css/meta.json).
  appDist = stdenvNoCC.mkDerivation {
    pname = "flake-explorer-app-dist";
    inherit version;
    src = appSrc;
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
    # from the caller's PATH so store paths and the flake registry match the
    # host system.
    postInstall = ''
      mkdir -p $out/share/flake-explorer
      ln -s ${appDist} $out/share/flake-explorer/app-dist
      wrapProgram $out/bin/flake-explorer \
        --prefix PATH : ${lib.makeBinPath [ git ]}
    '';

    passthru = {
      inherit cargoArtifacts appDist node_modules;
      checks = {
        clippy = craneLib.cargoClippy (
          commonArgs
          // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--all-targets -- --deny warnings";
          }
        );
        test = craneLib.cargoTest (commonArgs // { inherit cargoArtifacts; });
        # lcov at $out (crane's default cargoLlvmCovExtraArgs) — CI runs the
        # richer out-of-sandbox variant and feeds octocov. cargo-llvm-cov
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
        # Offline `bun test` for the SPA against the vendored node_modules
        # (happy-dom + svelte-loader preloads from bunfig.toml; no network).
        app-test = stdenvNoCC.mkDerivation {
          name = "flake-explorer-app-tests";
          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./LICENSE
              ./app
              ./scripts
              ./test
              ./tsconfig.json
              ./package.json
              ./bun.lock
              ./bunfig.toml
            ];
          };
          nativeBuildInputs = [
            bun
            git
          ];
          dontConfigure = true;
          buildPhase = ''
            runHook preBuild
            export HOME=$TMPDIR
            export BUN_INSTALL_CACHE_DIR=$TMPDIR/bun-cache
            ln -s ${node_modules}/node_modules node_modules
            bun test
            runHook postBuild
          '';
          installPhase = "touch $out";
        };
      };
    };

    meta = {
      description = "Interactive visualizer for Nix flakes: outputs/module tree, option provenance, file map";
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
