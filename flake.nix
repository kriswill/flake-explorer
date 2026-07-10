{
  description = "flake-explorer — interactive visualizer for Nix flakes (outputs/modules/options/files)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
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
            flake-explorer = pkgs.callPackage ./package.nix { };
            default = config.packages.flake-explorer;
          };

          # Offline `bun test` against the vendored node_modules (happy-dom +
          # svelte-loader preloads from bunfig.toml; no network).
          checks.test = config.packages.flake-explorer.passthru.tests.unit;

          # `nix fmt` + checks.treefmt come from the flakeModule; Biome keeps
          # owning TS/Svelte via its own biome.json, so treefmt is Nix-only.
          treefmt.programs.nixfmt.enable = true;

          # nix itself is deliberately NOT in the shell or wrapper: the CLI
          # must use the host's nix so store paths and the flake registry
          # match the user's system (run-nix.ts checks for it at startup).
          devShells.default = pkgs.mkShell {
            packages = builtins.attrValues { inherit (pkgs) bun git; } ++ [
              config.treefmt.build.wrapper
            ];
          };
        };
    };
}
