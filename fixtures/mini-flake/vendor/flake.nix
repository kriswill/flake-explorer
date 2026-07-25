{
  # flake-explorer test fixture: a tiny local input consumed by ../flake.nix,
  # giving the manifest a real second flake to list and browse in the Inputs
  # panel (see the parent flake.nix for why its files aren't option-attributed).
  description = "flake-explorer test fixture: vendor input";

  outputs =
    { self }:
    {
      lib.extra = import ./modules/extra.nix;
    };
}
