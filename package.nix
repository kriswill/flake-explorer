{
  lib,
  stdenvNoCC,
  bun,
  git,
  makeBinaryWrapper,
}:
# flake-explorer runs from source under bun — `serve` bundles the Svelte SPA
# with Bun.build + bun-plugin-svelte at CLI runtime, so `bun build --compile`
# is out; the package ships the TypeScript tree plus vendored node_modules and
# a bun wrapper (same pattern as okflight). The nix binary is resolved from
# the caller's PATH, never vendored, so store paths and the flake registry
# match the host system.
let
  # Explicit include-list: nix plumbing stays out (nix-only edits don't rebuild
  # the package) and node_modules can never leak in however the source reaches
  # us. src/extract/extract.nix MUST ship — the CLI evals it at runtime.
  sources = lib.fileset.unions [
    ./LICENSE
    ./flake-explorer.ts
    ./src
    ./app
    ./tsconfig.json
    ./package.json
    ./bun.lock
    ./bunfig.toml
    ./test
  ];

  # Tests stay out of the shipped package: bun's test scanner follows the
  # `result` symlink `nix build` leaves in the flake root, so any *.test.ts
  # under $out would run as a stale second copy of the suite.
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.difference sources (
      lib.fileset.unions [
        ./test
        (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ./app)
        (lib.fileset.fileFilter (file: lib.hasSuffix ".test.ts" file.name) ./src)
      ]
    );
  };

  # Full tree including the tests — only checks.test builds from this.
  testSrc = lib.fileset.toSource {
    root = ./.;
    fileset = sources;
  };

  # The lock is pure JS — no os/cpu-conditional packages, no install scripts —
  # so one hash serves every platform; --cpu/--os="*" keeps that true if a
  # future dep adds conditionals. --omit=optional: the only optional dep is
  # the `bun` npm package (npx/bunx fallback runtime); the nix wrapper
  # provides the real bun. NOT --production: serve needs svelte +
  # bun-plugin-svelte at CLI runtime, the tests happy-dom.
  # Refresh the hash (bun.lock or nixpkgs bun changes): set lib.fakeHash, then
  # `nix build .#flake-explorer.node_modules` and copy the "got:" value.
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
    # Fixup would patch shebangs into store paths — forbidden in a fixed-output
    # derivation.
    dontFixup = true;
    outputHash = "sha256-fgyd8OfPHXwpYxnDg2CqRz1Wbyp3k3a8E3xgc2f1tvA=";
    outputHashAlgo = "sha256";
    outputHashMode = "recursive";
  };
in
stdenvNoCC.mkDerivation {
  pname = "flake-explorer";
  version = "0.1.0";
  inherit src;

  nativeBuildInputs = [ makeBinaryWrapper ];
  dontConfigure = true;
  dontBuild = true;

  # bun resolves imports by walking the entry file's parent directories, so the
  # node_modules symlink beside the sources is found and followed; --no-install
  # forbids any runtime fetch. git backs per-file last-commit lookups.
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/flake-explorer $out/bin
    cp -R . $out/lib/flake-explorer
    ln -s ${node_modules}/node_modules $out/lib/flake-explorer/node_modules
    makeBinaryWrapper ${lib.getExe bun} $out/bin/flake-explorer \
      --add-flags "run --prefer-offline --no-install" \
      --add-flags "$out/lib/flake-explorer/flake-explorer.ts" \
      --set-default FLAKE_EXPLORER_PROG flake-explorer \
      --prefix PATH : ${
        lib.makeBinPath [
          bun
          git
        ]
      }
    runHook postInstall
  '';

  passthru = {
    inherit node_modules;
    # `bun test` offline against the vendored deps; surfaced as checks.test.
    tests.unit = stdenvNoCC.mkDerivation {
      name = "flake-explorer-tests";
      src = testSrc;
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
