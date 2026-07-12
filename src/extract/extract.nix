# Nix-side extraction for flake-explorer. Invoked by run-nix.ts as:
#   nix eval --impure --json --expr
#     'import <store>/extract.nix (builtins.fromJSON ''<args>'')'
# (--impure is required for builtins.getFlake on path/dirty refs.)
#
# Two modes:
#   manifest — cheap: self/input store paths, configuration names, .nix files.
#   options  — expensive: the full options tree of one configuration.
#
# Deliberately builtins-only (no nixpkgs lib): works on flakes with no
# nixpkgs input (e.g. the mini-flake fixture) and keeps the eval surface
# small. Value serialization is defensive — the module system happily holds
# derivations, functions, and unevaluatable thunks; scrub+deepSafe make sure
# one poisoned value degrades to a marker instead of killing the whole eval.
{
  flakeRef,
  mode,
  name ? null,
  kind ? null,
  # options mode: restrict the walk to the subtree at this option path (e.g.
  # ["services" "nginx"]), optionally to a subset of its children. The caller
  # extracts chunk-by-chunk and splits failing chunks recursively, because an
  # uncatchable eval error (missing attr / type error — tryEval only catches
  # throw/assert) poisons the entire eval it occurs in.
  path ? [ ],
  childNames ? null,
  skipInvisible ? true,
  # Degradation ladder for poisoned chunks: withValues=false skips forcing
  # any option/definition values; withDescriptions=false also skips
  # descriptions (which can interpolate config, e.g. "${cfg.package.description}").
  withValues ? true,
  withDescriptions ? true,
}:
let
  flake = builtins.getFlake flakeRef;

  hasSuffix =
    suf: s:
    let
      sl = builtins.stringLength suf;
      l = builtins.stringLength s;
    in
    l >= sl && builtins.substring (l - sl) sl s == suf;

  hasInfix = needle: s: builtins.match ".*${needle}.*" s != null;

  # Coerce to string and drop context — emitted strings must never make
  # `nix eval --json` think the result depends on a derivation.
  str = v: builtins.unsafeDiscardStringContext (toString v);

  # All .nix files under a directory (as path strings), skipping VCS dirs and
  # nested repositories/worktrees — a non-root directory carrying its own
  # `.git` (a file for worktrees, a dir for clones) is a different project.
  # Under lazy-trees (Determinate Nix) the flake's "source" is the working
  # directory itself, so without this an untracked `.claude/worktrees/*` or a
  # nested checkout leaks its .nix files into the file map. The root is
  # exempt: under lazy-trees it legitimately carries the repo's own `.git`.
  listNixFiles =
    let
      go =
        isRoot: dir:
        let
          entries = builtins.readDir dir;
        in
        if !isRoot && entries ? ".git" then
          [ ]
        else
          builtins.concatLists (
            map (
              n:
              let
                t = entries.${n};
              in
              if t == "directory" then
                (if n == ".git" || n == ".jj" then [ ] else go false "${dir}/${n}")
              else if (t == "regular" || t == "symlink") && hasSuffix ".nix" n then
                [ "${dir}/${n}" ]
              else
                [ ]
            ) (builtins.attrNames entries)
          );
    in
    go true;

  # ---------------------------------------------------------------- manifest
  tryString =
    v:
    let
      r = builtins.tryEval (toString v);
    in
    if r.success then r.value else null;

  configNames =
    attr: kindName:
    let
      r = builtins.tryEval (builtins.attrNames (flake.outputs.${attr} or { }));
    in
    if r.success then
      map (n: {
        kind = kindName;
        inherit n;
      }) r.value
    else
      [ ];

  # Inputs recursively (depth-capped): transitive inputs' store paths are
  # needed to attribute option files — module declarations routinely point
  # into inputs-of-inputs (e.g. a lib flake's own nixpkgs). NB the field is
  # "path", not "outPath": toJSON string-coerces any attrset with outPath.
  inputsTree =
    let
      go =
        depth: inps:
        builtins.mapAttrs (_: i: {
          path = tryString (i.outPath or null);
          inputs = if depth <= 0 then { } else go (depth - 1) (i.inputs or { });
        }) inps;
    in
    go 3 (flake.inputs or { });

  # Outputs that extend an input's same-named namespace (e.g. lib =
  # nixpkgs.lib.extend ...): record only the keys ADDED on top of the
  # input's attrset so the UI can show the graft instead of re-listing the
  # whole inherited namespace. Name-level comparison only — values are
  # never forced.
  attrNamesSafe =
    v:
    let
      r = builtins.tryEval (
        if builtins.isAttrs v && (v.type or null) != "derivation" then builtins.attrNames v else null
      );
    in
    if r.success then r.value else null;

  # Per-system output categories (packages.x86_64-linux…) would "overlap"
  # any input's same category purely by system names — never a graft.
  isSystemName = n: builtins.match ".*-(linux|darwin)" n != null;

  grafts = builtins.concatLists (
    map (
      outName:
      let
        oNames = attrNamesSafe (flake.outputs.${outName} or null);
        best = builtins.foldl' (
          acc: iName:
          let
            iNames = attrNamesSafe (flake.inputs.${iName}.${outName} or null);
            shared = builtins.filter (n: builtins.elem n iNames) oNames;
            sc = builtins.length shared;
          in
          if iNames == null || builtins.length iNames < 5 then
            acc
          # ≥90% of the input's names must reappear in the output to call it
          # a graft (an extend/overlay keeps the whole base namespace).
          else if sc * 10 < builtins.length iNames * 9 then
            acc
          else if acc != null && acc.inherited >= sc then
            acc
          else
            {
              output = outName;
              input = iName;
              inherited = sc;
              added = builtins.filter (n: !(builtins.elem n iNames)) oNames;
            }
        ) null (builtins.attrNames (flake.inputs or { }));
      in
      if oNames == null || oNames == [ ] || builtins.all isSystemName oNames || best == null then
        [ ]
      else
        [ best ]
    ) (builtins.attrNames (flake.outputs or { }))
  );

  # Top-level attr names per output (name-level only, values never forced):
  # lets the UI list e.g. a standalone `lib`'s keys where `nix flake show`
  # gives up with "unknown".
  outputNames =
    let
      pairs = map (
        n:
        let
          ns = attrNamesSafe (flake.outputs.${n} or null);
        in
        if ns == null then
          null
        else
          {
            name = n;
            value = ns;
          }
      ) (builtins.attrNames (flake.outputs or { }));
    in
    builtins.listToAttrs (builtins.filter (p: p != null) pairs);

  manifest = {
    self = toString flake.outPath;
    description = flake.description or null;
    inputs = inputsTree;
    configurations =
      configNames "nixosConfigurations" "nixos" ++ configNames "darwinConfigurations" "darwin";
    files = listNixFiles (toString flake.outPath);
    inherit grafts outputNames;
  };

  # ----------------------------------------------------------------- options
  cfg =
    flake.outputs.${if kind == "nixos" then "nixosConfigurations" else "darwinConfigurations"}.${name};

  # Bounded, total rendering of an arbitrary nix value. Depth/breadth caps
  # keep a stray `pkgs`-shaped value from exploding the output. Module-system
  # wrappers (raw definition values are PRE-merge) are unwrapped by hand:
  # forcing an mkIf's content when its condition is false is exactly what the
  # merge machinery avoids, and such content routinely type-errors — which
  # tryEval can NOT catch (it only catches throw/assert).
  scrub =
    d: v:
    if d > 6 then
      "«deep»"
    else if builtins.isAttrs v then
      (
        if (v.type or null) == "derivation" then
          "«drv:${v.name or "?"}»"
        else if (v._type or null) == "if" then
          (
            let
              c = builtins.tryEval v.condition;
            in
            if c.success && c.value == true then
              scrub d v.content
            else if c.success then
              "«mkIf false»"
            else
              "«mkIf ?»"
          )
        else if (v._type or null) == "override" then
          {
            mkOverride = v.priority or null;
            content = scrub (d + 1) (v.content or null);
          }
        else if (v._type or null) == "order" then
          scrub d (v.content or null)
        else if (v._type or null) == "merge" then
          map (scrub (d + 1)) (v.contents or [ ])
        else if v ? _type then
          "«${str v._type}»"
        else
          let
            ns = builtins.attrNames v;
          in
          if builtins.length ns > 64 then
            "«attrs:${toString (builtins.length ns)}»"
          else
            builtins.mapAttrs (_: scrub (d + 1)) v
      )
    else if builtins.isList v then
      (if builtins.length v > 64 then "«list:${toString (builtins.length v)}»" else map (scrub (d + 1)) v)
    else if builtins.isFunction v then
      "«function»"
    else if builtins.isPath v then
      toString v
    else
      v;

  # tryEval only catches at the forcing point; toJSON forces deeply, so wrap
  # the WHOLE serialization. unsafeDiscardStringContext on the serialized JSON
  # strips derivation references in one shot — without it `nix eval --json`
  # refuses any string that refers to an unbuilt output ("is not allowed to
  # refer to a store path"). Envelope: { ok = value } | { err = true }.
  deepSafe =
    v:
    let
      r = builtins.tryEval (
        builtins.fromJSON (builtins.unsafeDiscardStringContext (builtins.toJSON (scrub 0 v)))
      );
    in
    if r.success then { ok = r.value; } else { err = true; };

  # Never force values whose type screams "closure attached": packages pull
  # whole derivation graphs, raw/lazy attrs are unmerged thunks (_module.args
  # holds pkgs itself).
  unsafeType =
    o:
    let
      r = builtins.tryEval (o.type.description or "");
      t = if r.success then r.value else "";
    in
    hasInfix "package" t
    || hasInfix "derivation" t
    || hasInfix "raw value" t
    || hasInfix "lazy attribute set" t;

  optionInfo =
    o:
    let
      definedR = builtins.tryEval (o.isDefined or false);
      isDefined = definedR.success && definedR.value;
      prioR = builtins.tryEval (o.highestPrio or null);
      unsafe = !withValues || unsafeType o;
      typeR = builtins.tryEval (o.type.description or null);
      descR =
        if !withDescriptions then
          {
            success = true;
            value = null;
          }
        else
          builtins.tryEval (
            let
              d = o.description or null;
            in
            if builtins.isAttrs d then d.text or null else d
          );
      defsR = builtins.tryEval (
        map (d: {
          file = str d.file;
          value = if unsafe then { skipped = true; } else deepSafe d.value;
        }) (o.definitionsWithLocations or [ ])
      );
    in
    {
      loc = o.loc;
      type = if typeR.success then typeR.value else null;
      description = if descR.success then descR.value else null;
      readOnly = o.readOnly or false;
      inherit isDefined;
      highestPrio = if isDefined && prioR.success then prioR.value else null;
      defaultText =
        let
          r = builtins.tryEval (
            let
              dt = o.defaultText or null;
            in
            if builtins.isAttrs dt then dt.text or null else dt
          );
        in
        if r.success then r.value else null;
      default =
        if !(o ? default) then
          null
        else if !unsafe then
          deepSafe o.default
        else
          { skipped = true; };
      value =
        if isDefined && !unsafe then
          deepSafe o.value
        else
          (if isDefined then { skipped = true; } else null);
      declarations = map str (o.declarations or [ ]);
      definitions = if defsR.success then defsR.value else [ ];
    };

  isOption = v: builtins.isAttrs v && (v._type or null) == "option";

  keepOption = o: !skipInvisible || (!(o.internal or false) && (o.visible or true) != false);

  walk =
    v:
    if isOption v then
      (if keepOption v then [ (optionInfo v) ] else [ ])
    else if builtins.isAttrs v && !(v ? _type) then
      builtins.concatLists (map (n: walk v.${n}) (builtins.attrNames v))
    else
      [ ];
  descend =
    root: p:
    if p == [ ] then
      root
    else if builtins.isAttrs root && root ? ${builtins.head p} then
      descend root.${builtins.head p} (builtins.tail p)
    else
      { };

  subtree = descend cfg.options path;

  walkRoot =
    if childNames == null || isOption subtree || !builtins.isAttrs subtree then
      subtree
    else
      builtins.listToAttrs (
        map (n: {
          name = n;
          value = subtree.${n};
        }) (builtins.filter (n: subtree ? ${n}) childNames)
      );
in
if mode == "manifest" then
  manifest
else if mode == "optionNames" then
  (if isOption subtree || !builtins.isAttrs subtree then [ ] else builtins.attrNames subtree)
else
  { options = walk walkRoot; }
