{
  # Minimal non-import-tree flake: exercises the extractor's fallback file
  # enumeration (readDir recursion), the static import scan (relative file
  # imports + a directory import resolving to default.nix), a real input
  # (browsable in the Inputs panel), and a hand-rolled nixosConfigurations.*
  # options tree spanning multiple files — all builtins-only, no nixpkgs, so
  # the fixture stays cheap to evaluate.
  #
  # `vendor` is nested (./vendor) rather than a sibling: `path:../x` sibling
  # inputs crash `builtins.getFlake` on this Nix (relative ".." resolution
  # bug, reproduces outside this repo/outside git — see nixpkgs/nix issues
  # around local path-input relative resolution). A nested input works for
  # browsing but shares its parent's store copy, so its files also surface as
  # "self" files — harmless here since no option declares out of `vendor`;
  # it exists purely to exercise the Inputs list + input file view.
  description = "flake-explorer test fixture";

  inputs.vendor.url = "path:./vendor";

  outputs =
    { self, ... }:
    let
      # Fake `lib.mkOption` result: just enough of the real module-system
      # option shape (_type = "option", declarations/definitionsWithLocations)
      # for extract.nix's structural walk — see src/extract/extract.nix.
      mkOpt =
        {
          loc,
          type,
          description ? null,
          default ? null,
          declarations,
          definitionsWithLocations ? [ ],
        }:
        let
          isDefined = definitionsWithLocations != [ ];
        in
        {
          _type = "option";
          inherit loc description;
          type = {
            description = type;
          };
          internal = false;
          visible = true;
          readOnly = false;
          inherit isDefined;
          highestPrio = if isDefined then 100 else null;
          defaultText = null;
          inherit default;
          value = if isDefined then (builtins.elemAt definitionsWithLocations 0).value else default;
          declarations = map toString declarations;
          declarationPositions = [ ];
          inherit definitionsWithLocations;
        };

      hostFile = ./hosts/mini.nix;
      hostDefs = import hostFile;

      networking = import ./modules/networking.nix { inherit mkOpt hostFile hostDefs; };
      nginx = import ./modules/nginx.nix { inherit mkOpt hostFile hostDefs; };
    in
    {
      lib = {
        greeting = import ./lib/greeting.nix;
        helper = import ./lib/helper.nix;
        extras = import ./extras;
      };

      nixosConfigurations.mini = {
        # `nix flake show`'s builtin nixosConfigurations schema forces
        # .pkgs.stdenv.system (forSystems grouping) and a real derivation at
        # .config.system.build.toplevel before it'll show the entry at all —
        # stub just enough to satisfy that with the `derivation` builtin
        # (never built, just needs to look like one), no real pkgs/nixpkgs.
        pkgs.stdenv.system = "x86_64-linux";
        config.system.build.toplevel = derivation {
          name = "mini-toplevel";
          system = "x86_64-linux";
          builder = "/bin/sh";
          args = [
            "-c"
            "echo ok > $out"
          ];
        };
        options = {
          inherit networking;
          services.nginx = nginx;
        };
      };
    };
}
