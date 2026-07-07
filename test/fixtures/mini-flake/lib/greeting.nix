let
  helper = import ./helper.nix;
  extras = import ../extras;
in
{
  greet = name: "${helper.prefix} ${name}${extras.suffix}";
}
