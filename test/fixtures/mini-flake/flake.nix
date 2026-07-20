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
          declarationPositions ? [ ],
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
          declarationPositions = map (p: p // { file = toString p.file; }) declarationPositions;
          inherit definitionsWithLocations;
        };

      hostFile = ./hosts/mini.nix;
      hostDefs = import hostFile;

      networking = import ./modules/networking.nix { inherit mkOpt hostFile hostDefs; };
      nginx = import ./modules/nginx.nix { inherit mkOpt hostFile hostDefs; };
      environment = import ./modules/packages.nix {
        inherit
          mkOpt
          hostFile
          depDrv
          packageDrv
          ;
      };

      # Package/devShell/check/formatter fixtures: raw `derivation` builtin
      # merged with pname/version/meta/nativeBuildInputs via `//` — the merge
      # keeps type/drvPath/outPath pointing at the real (never-built)
      # derivation while letting extract.nix's package mode see the extra
      # attrs, all without a nixpkgs import. `${depDrv}` inside `args`
      # (rather than only in the merged `nativeBuildInputs`) is what actually
      # makes depDrv a real .drv-level input, matching `nix derivation
      # show`'s `inputDrvs` — the merged attribute alone would not.
      depDrv = derivation {
        name = "mini-dep";
        system = "x86_64-linux";
        builder = "/bin/sh";
        args = [
          "-c"
          "echo dep > $out"
        ];
      };

      packageDrv =
        derivation {
          name = "mini-0.1.0";
          system = "x86_64-linux";
          builder = "/bin/sh";
          args = [
            "-c"
            "echo ${depDrv} ok > $out"
          ];
        }
        // {
          pname = "mini";
          version = "0.1.0";
          meta = {
            description = "Mini test package";
            homepage = "https://example.com/mini";
            mainProgram = "mini";
            platforms = [ "x86_64-linux" ];
            license = {
              shortName = "mit";
              fullName = "MIT License";
              spdxId = "MIT";
              free = true;
            };
            maintainers = [
              {
                name = "Test Maintainer";
                github = "testuser";
              }
            ];
          };
          nativeBuildInputs = [ depDrv ];
        };

      # A single throwing meta field (unfree/broken markers do this in real
      # nixpkgs, typically on `meta.license`/`meta.available`, never on
      # `meta.description` itself — `nix flake show` forces exactly that one
      # field for its shortDescription, so a description-throw would break
      # classification for the whole flake; this doesn't). Exercises
      # extractPackage's metaError path: meta absent, everything else
      # (pname/version/deps) still extracts normally.
      brokenMetaDrv =
        derivation {
          name = "mini-broken-meta-0.1.0";
          system = "x86_64-linux";
          builder = "/bin/sh";
          args = [
            "-c"
            "echo ok > $out"
          ];
        }
        // {
          pname = "mini-broken-meta";
          version = "0.1.0";
          meta = {
            description = "Mini package with an unfree marker";
            license = throw "unfree: this package is unfree";
          };
        };

      devShellDrv = derivation {
        name = "mini-devshell";
        system = "x86_64-linux";
        builder = "/bin/sh";
        args = [
          "-c"
          "echo shell > $out"
        ];
      };

      checkDrv =
        derivation {
          name = "mini-check";
          system = "x86_64-linux";
          builder = "/bin/sh";
          args = [
            "-c"
            "echo check > $out"
          ];
        }
        // {
          meta.description = "Mini test check";
        };

      formatterDrv =
        derivation {
          name = "mini-formatter";
          system = "x86_64-linux";
          builder = "/bin/sh";
          args = [
            "-c"
            "echo fmt > $out"
          ];
        }
        // {
          meta.mainProgram = "mini-formatter";
        };
    in
    {
      lib = {
        greeting = import ./lib/greeting.nix;
        helper = import ./lib/helper.nix;
        extras = import ./extras;
      };

      # Exercises the manifest's overlay-definition scan (overlay-refs.ts):
      # the defining file (this flake.nix) lands in Manifest.overlayDefs.
      overlays.demo = final: prev: { };

      packages.x86_64-linux.mini = packageDrv;
      packages.x86_64-linux.mini-broken-meta = brokenMetaDrv;
      devShells.x86_64-linux.default = devShellDrv;
      checks.x86_64-linux.mini-check = checkDrv;
      formatter.x86_64-linux = formatterDrv;

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
          inherit networking environment;
          services.nginx = nginx;
        };
      };
    };
}
