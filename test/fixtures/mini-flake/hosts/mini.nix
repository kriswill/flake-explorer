# "Host configuration": the customized values for this fixture's nixosConfigurations.mini.
{
  networking.hostName = "mini";
  services.nginx.enable = true;
}
