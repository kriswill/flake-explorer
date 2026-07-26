// Replaying a remembered split, hermetic via a scripted `nix` shim on PATH.
//
// Finding where a configuration's poisoned options are costs most of the evals:
// on one real configuration, 223 of 348 calls are split-discovery, each re-paying
// the module-system fixpoint to learn something the previous extraction already
// knew. Where the tree splits is a property of the FLAKE, so the last extraction
// can leave the answer behind.
//
// The hint is a shape and never a rung — the walk always asks for full detail
// again, so a poisoned option that has since been fixed comes back at full value
// instead of being degraded forever by a memory of last time.
//
// It is also never trusted. A flake that gained or lost an option since the hint
// was written would have that difference silently skipped, because the remembered
// division does not mention it. So every chunk's eval reports what is ACTUALLY at
// its path, and a namespace whose children no longer match is thrown away and
// walked from scratch.
//
// PATH mutation is process-global, so this file holds ONE test.

mod common;

use common::TempDir;
use flake_explorer::options::{ChunkHint, ExtractOptionsOpts, extract_options};
use flake_explorer::schema::ConfigKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// `alpha` holds a1/a2/a3 of which a2 is poison at full detail; `beta` is clean.
/// A cold walk therefore has to fail `alpha` whole, list its children, and split
/// until a2 is alone — which is exactly the discovery a hint removes.
const SHIM: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$NIX_SHIM_DIR/calls"
emit() { printf '{"loc":["%s","%s"],"readOnly":false,"isDefined":true,"highestPrio":100,"default":null,"value":%s,"declarations":[],"definitions":[]}' "$1" "$2" "$3"; }
# The options a (namespace, childNames) request should yield, comma-joined.
body() {
  ns=$1; kids=$2
  first=1
  for k in $kids; do
    [ $first -eq 1 ] || printf ','
    first=0
    if [ "$k" = a2 ]; then v=null; else v='{"ok":1}'; fi
    emit "$ns" "$k" "$v"
  done
}
kids_of() { case "$1" in alpha) echo "a1 a2 a3" ;; beta) echo "b1" ;; *) echo "" ;; esac; }
# Which children a request covers: those named, else all of the namespace's.
covered() {
  ns=$1
  named=$(printf '%s' "$ARGV" | sed 's/.*childNames\\":\[//' | sed 's/\].*//' | tr -d '\\"' | tr ',' ' ')
  case "$ARGV" in *childNames*) echo "$named" ;; *) kids_of "$ns" ;; esac
}
ARGV="$*"
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *'mode\":\"optionNames'*)
    case "$*" in
      *'path\":[\"alpha\"]'*) echo '["a1","a2","a3"]' ;;
      *'path\":['*) echo '[]' ;;
      *) echo '["alpha","beta"]' ;;
    esac ;;
  *'mode\":\"options'*)
    ns=$(printf '%s' "$*" | sed -n 's/.*\"path\\":\[\\"\([a-z]*\)\\".*/\1/p')
    [ -n "$ns" ] || ns=$(printf '%s' "$*" | sed -n 's/.*path\\":\[\\"\([a-z]*\)\\".*/\1/p')
    kids=$(covered "$ns")
    case "$*" in
      *'withValues\":true'*)
        for k in $kids; do
          if [ "$k" = a2 ]; then echo "error: a2 exploded" >&2; exit 1; fi
        done ;;
    esac
    printf '{"options":['; body "$ns" "$kids"; printf '],"children":['
    first=1
    for k in $(kids_of "$ns"); do
      [ $first -eq 1 ] || printf ','
      first=0
      printf '"%s"' "$k"
    done
    printf ']}' ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

async fn walk(hint: Option<Vec<ChunkHint>>) -> (Vec<String>, Vec<String>, Vec<ChunkHint>) {
    let r = extract_options(
        "github:example/hint-flake",
        ConfigKind::Nixos,
        "host",
        ExtractOptionsOpts {
            timeout: Duration::from_secs(20),
            hint,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut locs: Vec<String> = r.data.options.iter().map(|o| o.loc.join(".")).collect();
    locs.sort();
    (locs, r.warnings, r.partition)
}

fn calls(dir: &std::path::Path) -> usize {
    let n = std::fs::read_to_string(dir.join("calls"))
        .map(|s| s.lines().count())
        .unwrap_or(0);
    std::fs::write(dir.join("calls"), "").ok();
    n
}

#[tokio::test]
async fn a_remembered_split_is_replayed_but_never_trusted() {
    let shim = TempDir::new("hint-shim");
    let nix = shim.0.join("nix");
    std::fs::write(&nix, SHIM).unwrap();
    std::fs::set_permissions(&nix, std::fs::Permissions::from_mode(0o755)).unwrap();

    // SAFETY: single test in this binary, set before anything reads it.
    unsafe {
        std::env::set_var("NIX_SHIM_DIR", &shim.0);
        std::env::set_var("FLAKE_EXPLORER_NIX_JOBS", "1");
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                shim.0.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
    }

    // Cold: no hint. This is the run that pays for discovery.
    let (cold_locs, cold_warnings, plan) = walk(None).await;
    let cold_calls = calls(&shim.0);
    assert_eq!(cold_locs, ["alpha.a1", "alpha.a2", "alpha.a3", "beta.b1"]);
    assert_eq!(
        cold_warnings,
        ["nixos/host options.alpha.a2: values skipped (eval error at full detail)"]
    );

    // Warm: same flake, replaying the plan the cold run left behind. Cheaper,
    // and identical — a hint may change what the walk COSTS and nothing else.
    let (warm_locs, warm_warnings, warm_plan) = walk(Some(plan.clone())).await;
    let warm_calls = calls(&shim.0);
    assert_eq!(warm_locs, cold_locs, "a hint changed what was extracted");
    assert_eq!(warm_warnings, cold_warnings, "a hint changed the warnings");
    assert_eq!(
        warm_plan, plan,
        "replaying a plan produced a different plan"
    );
    assert!(
        warm_calls < cold_calls,
        "replay cost {warm_calls} calls against a cold {cold_calls} — the hint \
         bought nothing"
    );

    // Stale: the flake has gained `a3` since this plan was written, so the plan
    // covers only part of the namespace. Replaying it verbatim would silently
    // drop the option it does not mention, which is worse than being slow — so
    // the namespace is thrown away and walked from scratch.
    let stale = vec![ChunkHint {
        path: vec!["alpha".into()],
        children: Some(vec!["a1".into(), "a2".into()]),
    }];
    let (stale_locs, stale_warnings, _) = walk(Some(stale)).await;
    let stale_calls = calls(&shim.0);
    assert_eq!(
        stale_locs, cold_locs,
        "a plan that no longer describes the flake lost an option"
    );
    assert_eq!(stale_warnings, cold_warnings);
    // Recovering cost something, which is how we know the namespace was really
    // thrown away and re-walked rather than the stale plan having happened to
    // cover everything anyway.
    assert!(
        stale_calls > warm_calls,
        "a stale plan cost {stale_calls} calls against a good plan's \
         {warm_calls} — nothing was re-walked, so nothing was verified"
    );
    println!("calls: cold={cold_calls} warm={warm_calls} stale={stale_calls}");
}
