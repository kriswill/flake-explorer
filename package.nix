# flake-explorer: a native binary (crane-built Rust) plus the bun-built
# Svelte SPA bundle it serves. crane's buildDepsOnly compiles the dependency
# tree as its own derivation keyed only by Cargo.lock, so CI rebuilds just
# this workspace's own crates on source changes while the dep layer stays in
# the binary cache.
#
# Two members since the extraction/presentation split: the root crate (CLI,
# serve, export) and flake-explorer-extract. Both are in default-members, so
# every crane driver below — buildPackage, cargoTest, cargoClippy, cargoLlvmCov
# — selects both without needing --workspace anywhere. The split also buys a
# smaller unit of recompilation: a serve.rs edit no longer recompiles the
# extractor, only the crate that depends on it.
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
  cargo-llvm-cov,
  git,
  makeBinaryWrapper,
  rustc,
  craneLib,
}:
let
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;

  # Everything the cargo build reads, for both workspace members: the root
  # crate (./src) and the extraction crate (./crates, which carries its own
  # Cargo.toml, the build.rs that fingerprints it, and the sources include_str!
  # — extract.nix and the highlight queries). ./crates has to be here whole
  # rather than as ./crates/extract/src: crane reads every member manifest to
  # generate the dummy sources for the dependency layers, and a missing member
  # manifest fails the workspace resolve before any of them compiles.
  # ./tests is here so the sandboxed checks (cargoTest, cargoClippy
  # --all-targets) actually compile the integration suites — without it they
  # silently build nothing but the lib/bin unit tests. The nix fixtures the
  # suites read at runtime live in ./fixtures and are deliberately NOT in this
  # fileset: nothing needs them to compile, mini_flake.rs skips in-sandbox
  # (no `nix` on PATH), and including them would make every fixture edit
  # invalidate the crane dependency layer.
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./Cargo.toml
      ./Cargo.lock
      ./crates
      ./src
      ./tests
    ];
  };

  commonArgs = {
    pname = "flake-explorer";
    inherit src version;
    strictDeps = true;
  };

  # cargo-llvm-cov hunts for rustup's llvm-tools-preview and refuses to start
  # without it; point it at the LLVM that built this rustc instead (the profraw
  # format has to match). Resolved at startup even when it is only compiling,
  # so the coverage dep layer below needs it as much as the check itself does.
  llvmToolEnv = {
    LLVM_COV = "${rustc.llvmPackages.llvm}/bin/llvm-cov";
    LLVM_PROFDATA = "${rustc.llvmPackages.llvm}/bin/llvm-profdata";
  };

  # crane defaults every derivation to the release profile
  # (configureCargoCommonVarsHook sets CARGO_PROFILE=release, cargoWithProfile
  # turns that into --release), so the checks were optimising and LTO-linking
  # the whole crate graph to run a suite that executes in about two seconds.
  # Nothing they do needs optimised code. Dev also turns on debug_assertions
  # and integer overflow checks, so the suite runs stricter here than the
  # shipped binary does — and it matches the profile CI's out-of-sandbox
  # `cargo llvm-cov test` has always used, so the two coverage numbers finally
  # come from the same compilation.
  devArgs = commonArgs // {
    CARGO_PROFILE = "dev";
    CARGO_PROFILE_DEV_DEBUG = "line-tables-only";
  };

  cargoArtifacts = craneLib.buildDepsOnly commonArgs;

  # Dev-profile deps for clippy and test. A profile is a fingerprint input, so
  # the release layer above is worthless to them and vice versa; the layers
  # cannot be merged, only chosen between.
  devArtifacts = craneLib.buildDepsOnly devArgs;

  # A third dep layer, for the coverage check only. cargo-llvm-cov compiles
  # through its own RUSTC_WRAPPER, and cargo folds the wrapper into the
  # compiler fingerprint of *every* unit — so `cargoArtifacts` above is a total
  # miss and the coverage run rebuilds the entire dependency tree (~100 crates)
  # rather than just this crate. Building this layer by running cargo-llvm-cov
  # over crane's dummy sources makes the wrapper, and the environment it keys
  # off, match the check by construction; hand-copying the flags would drift
  # silently the first time either side changed.
  coverageArtifacts = craneLib.buildDepsOnly (
    devArgs
    // llvmToolEnv
    // {
      nativeBuildInputs = [ cargo-llvm-cov ];
      # crane's cargoLlvmCov invocation minus the report, which has nothing to
      # report on: the dummy sources carry no tests.
      buildPhaseCargoCommand = "cargoWithProfile llvm-cov test --locked --no-report";
      # That command already compiles the dev-dependency test binaries the
      # check phase exists to cache; letting it run would only add a second,
      # uninstrumented copy of them.
      doCheck = false;
    }
  );

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
    outputHash = "sha256-j+31pXJybIbK1bT9LQD0Suv/hUvhzsAhs8+pSAw7z90=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };

  # Everything the SPA bundle script's import graph reaches. Tests live beside
  # the modules they cover, so the *.test.ts filter and ./web/testing (their
  # preloads/helpers/fixtures) both come back out — nothing in the bundle graph
  # imports them, and leaving them in would rebuild the bundle on test edits.
  appSrc = lib.fileset.toSource {
    root = ./.;
    fileset =
      lib.fileset.difference
        (lib.fileset.unions [
          ./scripts/bundle-app.ts
          ./scripts/build-app.ts
          ./scripts/licenses.ts
          ./web
          ./package.json
          ./tsconfig.json
          ./LICENSE
        ])
        (
          lib.fileset.unions [
            (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ./.)
            ./web/testing
          ]
        );
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
    # crane runs `cargo test` in buildPackage's check phase by default, which
    # here means building all six test binaries a second time — in release,
    # LTO and all — to run the suite `checks.test` has already run from the
    # same fileset, under debug_assertions and overflow checks it does not
    # have. The only thing the second run adds is optimised code, and the
    # crate contains no `unsafe` outside three env::set_var calls in the test
    # harnesses. Not worth 37-51s of every build.
    doCheck = false;
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
      inherit
        cargoArtifacts
        devArtifacts
        coverageArtifacts
        appDist
        node_modules
        ;
      checks = {
        clippy = craneLib.cargoClippy (
          devArgs
          // {
            cargoArtifacts = devArtifacts;
            cargoClippyExtraArgs = "--all-targets -- --deny warnings";
          }
        );
        test = craneLib.cargoTest (devArgs // { cargoArtifacts = devArtifacts; });
        # lcov at $out (crane's default cargoLlvmCovExtraArgs) — CI runs the
        # richer out-of-sandbox variant and feeds octocov. Note this rides on
        # `coverageArtifacts`, not the layer clippy and test share.
        coverage = craneLib.cargoLlvmCov (
          devArgs
          // llvmToolEnv
          // {
            cargoArtifacts = coverageArtifacts;
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
              ./web
              ./scripts
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
