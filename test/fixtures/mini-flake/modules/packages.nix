# "Module": declares a package-typed option. Package values are never
# serialized by the extractor (closure risk) — this exercises the names-only
# path (drvNames/namesOf in extract.nix): the merged value and each
# definition emit { names } instead of { skipped }. The first definition's
# file string carries the module system's ", via option <path>" provenance
# suffix (dendritic flake.modules.* imports stamp this) to exercise splitVia
# lifting it into DefinitionRef.via; the second wraps its value in a fake
# mkIf envelope to exercise wrapper traversal inside drvNames.
{
  mkOpt,
  hostFile,
  depDrv,
  packageDrv,
}:
{
  systemPackages = mkOpt {
    loc = [
      "environment"
      "systemPackages"
    ];
    type = "list of package";
    description = "Packages installed system-wide.";
    default = [ ];
    declarations = [ "${toString ./packages.nix}, via option flake.modules.nixos.demo" ];
    definitionsWithLocations = [
      {
        file = "${toString hostFile}, via option flake.modules.nixos.demo";
        value = [
          depDrv
          packageDrv
        ];
      }
      {
        file = toString ./packages.nix;
        value = {
          _type = "if";
          condition = true;
          content = [ depDrv ];
        };
      }
    ];
  };
}
