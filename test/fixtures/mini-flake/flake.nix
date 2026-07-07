{
  # Minimal non-import-tree, no-input flake: exercises the extractor's
  # fallback file enumeration (readDir recursion) and the static import scan
  # (relative file imports + a directory import resolving to default.nix).
  description = "flake-explorer test fixture";

  outputs =
    { self }:
    {
      lib = {
        greeting = import ./lib/greeting.nix;
        helper = import ./lib/helper.nix;
        extras = import ./extras;
      };
    };
}
