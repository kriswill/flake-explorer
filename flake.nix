{
  description = "flake-explorer — interactive visualizer for Nix flakes (outputs/modules/options/files)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    # Rust builds: buildDepsOnly compiles the dep tree once per Cargo.lock
    # (only the crate itself rebuilds on source changes) and provides the
    # cargoClippy/cargoLlvmCov check drivers. Lib-only flake, no inputs of
    # its own; uses nixpkgs' stable rustc.
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ inputs.treefmt-nix.flakeModule ];

      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];

      perSystem =
        { pkgs, config, ... }:
        {
          packages = {
            flake-explorer = pkgs.callPackage ./package.nix {
              craneLib = inputs.crane.mkLib pkgs;
            };
            default = config.packages.flake-explorer;
          };

          checks = {
            # cargo test/clippy/llvm-cov over the shared crane dep layer.
            # Coverage is a check (not just a CI step) so `nix flake check`
            # exercises the instrumented build everywhere; CI additionally
            # runs the out-of-sandbox variant (real nix, integration tests
            # included) and reads its lcov for the octocov report.
            test = config.packages.flake-explorer.passthru.checks.test;
            clippy = config.packages.flake-explorer.passthru.checks.clippy;
            coverage = config.packages.flake-explorer.passthru.checks.coverage;
            # Offline `bun test` of the SPA against the vendored node_modules.
            app-test = config.packages.flake-explorer.passthru.checks.app-test;
          };

          # `nix fmt` + checks.treefmt come from the flakeModule; Biome keeps
          # owning TS/Svelte via its own biome.json, so treefmt covers Nix
          # and Rust.
          treefmt.programs.nixfmt.enable = true;
          treefmt.programs.rustfmt.enable = true;

          # nix itself is deliberately NOT in the shell or wrapper: the CLI
          # must use the host's nix so store paths and the flake registry
          # match the user's system (src/run_nix.rs checks for it at startup).
          devShells.default = pkgs.mkShell {
            # cargo-llvm-cov looks for rustup's llvm-tools-preview; point it
            # at the LLVM that built this rustc instead (same pinning as the
            # coverage check). CI's out-of-sandbox coverage run — the one
            # that includes the real-nix integration tests — relies on these.
            env = {
              LLVM_COV = "${pkgs.rustc.llvmPackages.llvm}/bin/llvm-cov";
              LLVM_PROFDATA = "${pkgs.rustc.llvmPackages.llvm}/bin/llvm-profdata";
            };
            packages =
              builtins.attrValues {
                inherit (pkgs)
                  bun
                  git
                  cargo
                  rustc
                  clippy
                  rustfmt
                  rust-analyzer
                  cargo-llvm-cov
                  ;
              }
              ++ [
                config.treefmt.build.wrapper
                # Live-source `flake-explorer`: builds and runs the enclosing
                # checkout's crate (a flake only sees a store copy of itself,
                # so the working tree must be resolved at call time).
                (pkgs.writeShellScriptBin "flake-explorer" ''
                  root=$(git rev-parse --show-toplevel 2>/dev/null)
                  if [ ! -f "$root/Cargo.toml" ]; then
                    echo "flake-explorer(dev shim): no Cargo.toml at the git toplevel ('$root') — run inside the flake-explorer checkout" >&2
                    exit 1
                  fi
                  FLAKE_EXPLORER_PROG=flake-explorer exec cargo run --quiet --manifest-path "$root/Cargo.toml" -- "$@"
                '')
              ];
          };
        };
    };
}
