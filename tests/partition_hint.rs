// Replaying a remembered split, hermetic via a scripted `nix` shim on PATH.
//
// Finding where a configuration's poisoned options are costs most of the evals:
// on one real configuration 223 of 348 calls exist only to discover that, each
// re-paying the module-system fixpoint to learn what the previous extraction
// already knew. Where the tree splits is a property of the FLAKE, so the last
// extraction can leave the answer behind.
//
// THE SHAPE THAT MATTERS. A namespace's children are not all accounted for the
// same way: most are walked in place and recorded as `{path: [ns], children:
// [...]}`, but a child that had to be descended into is recorded one level down
// as `{path: [ns, child], ...}` and appears in NO entry at [ns]. A plan
// therefore legitimately holds entries at a path AND entries beneath it, with
// no overlap between them.
//
// The first version of this fixture had only the first kind, and that is the
// whole reason a duplication bug reached validation: with no descended child,
// "children named at [ns]" and "children the plan accounts for" are the same
// set, and the code confusing them looked correct.
//
// PATH mutation is process-global, so this file holds ONE test.

mod common;

use common::TempDir;
use flake_explorer::options::{ChunkHint, ExtractOptionsOpts, extract_options};
use flake_explorer::schema::ConfigKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// `alpha` holds a1/a2/a3; a2 is poison at full detail AND has children of its
/// own, so the cold walk isolates it and then descends into it. `beta` is clean
/// and never splits. The resulting plan has all three entry kinds: subsets at
/// [alpha], a deeper entry at [alpha, a2], and a whole-namespace entry at
/// [beta].
const SHIM: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$NIX_SHIM_DIR/calls"
ARGV="$*"
# The chunk's path, as space-separated words ("alpha", or "alpha a2").
path_of() { printf '%s' "$ARGV" | sed 's/.*"path\\":\[//' | sed 's/\].*//' | tr -d '\\"' | tr ',' ' '; }
kids_of() {
  case "$1" in
    alpha) echo "a1 a2 a3" ;;
    "alpha a2") echo "p q" ;;
    beta) echo "b1" ;;
    *) echo "" ;;
  esac
}
covered() {
  case "$ARGV" in
    *childNames*) printf '%s' "$ARGV" | sed 's/.*childNames\\":\[//' | sed 's/\].*//' | tr -d '\\"' | tr ',' ' ' ;;
    *) kids_of "$1" ;;
  esac
}
# loc = the chunk's path plus the child, as a JSON array.
emit() {
  printf '{"loc":['
  first=1
  for seg in $1 $2; do
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s"' "$seg"
  done
  printf '],"readOnly":false,"isDefined":true,"highestPrio":100,"default":null,"value":%s,"declarations":[],"definitions":[]}' "$3"
}
json_list() {
  printf '['
  first=1
  for x in $1; do
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s"' "$x"
  done
  printf ']'
}
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *'mode\":\"optionNames'*)
    case "$*" in
      *'path\":['*) json_list "$(kids_of "$(path_of)")" ;;
      *) echo '["alpha","beta"]' ;;
    esac ;;
  *'mode\":\"options'*)
    p=$(path_of); kids=$(covered "$p")
    # a2 poisons any full-detail walk of alpha that covers it.
    case "$*" in
      *'withValues\":true'*)
        if [ "$p" = alpha ]; then
          for k in $kids; do
            [ "$k" = a2 ] && { echo "error: a2 exploded" >&2; exit 1; }
          done
        fi ;;
    esac
    printf '{"options":['
    first=1
    for k in $kids; do
      [ $first -eq 1 ] || printf ','
      first=0
      if [ "$k" = a2 ]; then v=null; else v='{"ok":1}'; fi
      emit "$p" "$k" "$v"
    done
    printf '],"children":'; json_list "$(kids_of "$p")"; printf '}' ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

struct Walk {
    locs: Vec<String>,
    warnings: Vec<String>,
    plan: Vec<ChunkHint>,
}

// clippy.toml's unwrap-in-tests exemption reaches `#[test]` fns but not the
// helpers around them.
#[expect(
    clippy::unwrap_used,
    reason = "test code: panics are the failure mechanism"
)]
async fn walk(hint: Option<Vec<ChunkHint>>) -> Walk {
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
    Walk {
        locs,
        warnings: r.warnings,
        plan: r.partition,
    }
}

fn calls(dir: &std::path::Path) -> usize {
    let n = std::fs::read_to_string(dir.join("calls")).map_or(0, |s| s.lines().count());
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
        std::env::set_var("FLAKE_EXPLORER_NIX_JOBS", "2");
        std::env::set_var(
            "PATH",
            format!(
                "{}:{}",
                shim.0.display(),
                std::env::var("PATH").unwrap_or_default()
            ),
        );
    }

    let cold = walk(None).await;
    let cold_calls = calls(&shim.0);
    assert_eq!(
        cold.locs,
        [
            "alpha.a1",
            "alpha.a2.p",
            "alpha.a2.q",
            "alpha.a3",
            "beta.b1"
        ]
    );

    // The plan really does have the shape this test exists for: a child of
    // `alpha` accounted for one level down and named by no entry at [alpha].
    let named_at_alpha: Vec<&String> = cold
        .plan
        .iter()
        .filter(|h| h.path == ["alpha"])
        .flat_map(|h| h.children.iter().flatten())
        .collect();
    assert!(
        cold.plan.iter().any(|h| h.path == ["alpha", "a2"]),
        "fixture did not descend, so it cannot catch the bug it exists for: {:?}",
        cold.plan
    );
    assert!(
        !named_at_alpha.iter().any(|c| *c == "a2"),
        "a descended child must not also be named at its parent: {:?}",
        cold.plan
    );

    // Replay. The plan is good, so nothing may be discarded and nothing walked
    // twice — an option emitted by both a parent chunk and a deeper one lands in
    // the blob twice, and the count the UI shows is wrong.
    let warm = walk(Some(cold.plan.clone())).await;
    let warm_calls = calls(&shim.0);
    let mut distinct = warm.locs.clone();
    distinct.dedup();
    assert_eq!(
        warm.locs, distinct,
        "replay emitted duplicate options — a chunk and its descendant both \
         walked the same ground"
    );
    assert_eq!(warm.locs, cold.locs, "a hint changed what was extracted");
    assert_eq!(warm.warnings, cold.warnings, "a hint changed the warnings");
    assert_eq!(warm.plan, cold.plan, "replay produced a different plan");
    assert!(
        warm_calls < cold_calls,
        "replay cost {warm_calls} calls against a cold {cold_calls} — the hint \
         bought nothing"
    );

    // A plan that no longer describes the flake: `alpha` has gained a3 since it
    // was written. Replaying it verbatim would silently drop that option, so the
    // namespace is thrown away and walked from scratch — still without
    // duplicating anything, which is what the epoch is for.
    let stale = vec![
        ChunkHint {
            path: vec!["alpha".into()],
            children: Some(vec!["a1".into()]),
        },
        ChunkHint {
            path: vec!["alpha".into(), "a2".into()],
            children: Some(vec!["p".into(), "q".into()]),
        },
    ];
    let recovered = walk(Some(stale)).await;
    let stale_calls = calls(&shim.0);
    let mut distinct = recovered.locs.clone();
    distinct.dedup();
    assert_eq!(
        recovered.locs, distinct,
        "recovering from a stale plan duplicated options — a chunk already in \
         flight when the namespace was discarded still appended its results"
    );
    assert_eq!(
        recovered.locs, cold.locs,
        "a plan that no longer describes the flake lost an option"
    );
    assert_eq!(recovered.warnings, cold.warnings);
    assert!(
        stale_calls > warm_calls,
        "a stale plan cost {stale_calls} against a good plan's {warm_calls} — \
         nothing was re-walked, so nothing was verified"
    );
}
