# Devenv twin of flake.nix's devShells.default — the same environment, entered
# via devenv 2.1's native cd hook (trust once with `devenv allow`) instead of
# `nix develop`. Keep the two in sync when the toolchain changes.
{ pkgs, inputs, ... }:
let
  # The same treefmt wrapper `nix fmt` runs (flake.nix wires it through
  # treefmt-nix's flakeModule): Biome keeps owning TS/Svelte via biome.json,
  # so treefmt covers Nix and Rust.
  treefmt =
    (inputs.treefmt-nix.lib.evalModule pkgs {
      projectRootFile = "flake.nix";
      programs.nixfmt.enable = true;
      programs.rustfmt.enable = true;
    }).config.build.wrapper;

  # nixpkgs is still on bun 1.3.13 (bump PR NixOS/nixpkgs#519796 open as of
  # 2026-08-02), but @types/bun already tracks 1.3.14 — so repin nixpkgs'
  # binary-repack derivation onto the official 1.3.14 release zips. Drop this
  # whole block (and use plain pkgs.bun in packages) once the bump lands.
  bunVersion = "1.3.14";
  bunSources = {
    aarch64-darwin = {
      asset = "bun-darwin-aarch64";
      hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
    };
    aarch64-linux = {
      asset = "bun-linux-aarch64";
      hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
    };
    x86_64-linux = {
      asset = "bun-linux-x64";
      hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
    };
  };
  bunSource =
    bunSources.${pkgs.stdenv.hostPlatform.system}
      or (throw "bun ${bunVersion} override: unsupported system ${pkgs.stdenv.hostPlatform.system}");
  bun = pkgs.bun.overrideAttrs (_: {
    version = bunVersion;
    src = pkgs.fetchurl {
      url = "https://github.com/oven-sh/bun/releases/download/bun-v${bunVersion}/${bunSource.asset}.zip";
      inherit (bunSource) hash;
    };
  });
in
{
  # nixpkgs' stable rust toolchain — rustc, cargo, clippy, rustfmt,
  # rust-analyzer — the same channel package.nix's crane builds use.
  languages.rust.enable = true;

  packages = [
    bun
    pkgs.git
    pkgs.cargo-llvm-cov
    treefmt
  ];
  # nix itself is deliberately NOT brought in (same rule as the flake
  # devShell): the CLI must use the host's nix so store paths and the flake
  # registry match the user's system (src/run_nix.rs checks for it at
  # startup).

  # cargo-llvm-cov looks for rustup's llvm-tools-preview; point it at the
  # LLVM that built this rustc instead (same pinning as the flake's coverage
  # check).
  env = {
    LLVM_COV = "${pkgs.rustc.llvmPackages.llvm}/bin/llvm-cov";
    LLVM_PROFDATA = "${pkgs.rustc.llvmPackages.llvm}/bin/llvm-profdata";
  };

  # Live-source `flake-explorer`: builds and runs the enclosing checkout's
  # crate (a flake only sees a store copy of itself, so the working tree must
  # be resolved at call time). Mirrors the flake devShell's shim.
  scripts.flake-explorer.exec = ''
    root=$(git rev-parse --show-toplevel 2>/dev/null)
    if [ ! -f "$root/Cargo.toml" ]; then
      echo "flake-explorer(dev shim): no Cargo.toml at the git toplevel ('$root') — run inside the flake-explorer checkout" >&2
      exit 1
    fi
    FLAKE_EXPLORER_PROG=flake-explorer exec cargo run --quiet --manifest-path "$root/Cargo.toml" -- "$@"
  '';
}
