# "Module": declares an option via the fixture's hand-rolled mkOpt (see
# flake.nix) — no real module system, just enough shape to exercise the
# extractor's options walk. hostFile/hostDefs are threaded in from flake.nix
# since a relative path literal written here would resolve against this
# file's own directory, not the caller's.
{
  mkOpt,
  hostFile,
  hostDefs,
}:
{
  hostName = mkOpt {
    loc = [
      "networking"
      "hostName"
    ];
    type = "string";
    description = "The host name of this machine.";
    default = "unset";
    declarations = [ ./networking.nix ];
    definitionsWithLocations = [
      {
        file = hostFile;
        value = hostDefs.networking.hostName;
      }
    ];
  };
}
