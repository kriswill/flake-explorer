{
  # Fixture whose single configuration fails evaluation: the attr NAME is
  # enumerable (manifest lists it) but forcing the value throws — exercises
  # the per-config error path in extract/drive.ts without poisoning the
  # healthy mini-flake fixture.
  description = "flake-explorer broken-config fixture";

  outputs = _: {
    nixosConfigurations.broken = throw "kaboom: this configuration never evaluates";
  };
}
