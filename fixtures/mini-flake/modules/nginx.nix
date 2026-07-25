# "Module": declares two options. `enable` gets customized by hosts/mini.nix
# (exercises the declares-vs-defines split); `package` is never customized,
# so it stays declared-only with just its default.
{
  mkOpt,
  hostFile,
  hostDefs,
}:
{
  enable = mkOpt {
    loc = [
      "services"
      "nginx"
      "enable"
    ];
    type = "boolean";
    description = "Whether to run the nginx web server.";
    default = false;
    declarations = [ ./nginx.nix ];
    definitionsWithLocations = [
      {
        file = hostFile;
        value = hostDefs.services.nginx.enable;
      }
    ];
  };
  package = mkOpt {
    loc = [
      "services"
      "nginx"
      "package"
    ];
    type = "string";
    description = "The nginx package to use.";
    default = "nginx";
    declarations = [ ./nginx.nix ];
  };
}
