// Chunk batching, hermetic via a scripted `nix` shim on PATH.
//
// Every chunk the option walk evaluates re-pays the same fixed cost: ~580ms of
// flake + module-system fixpoint before a single option is read, of which 18ms
// is nix's own startup. Measured against a real configuration that is 202s of a
// 380s serial pass, and it is not recoverable from nix — an identical eval
// repeated costs the same every time, in the `--expr` shape this uses AND in
// the installable shape nix's eval cache is actually built for, on a clean
// flake. Nothing memoizes a fixpoint across processes, so the only place to
// amortize it is inside one.
//
// So chunks go to nix in batches. The risk that buys is blast radius: an
// uncatchable error poisons the eval it occurs in, and a batch is now a bigger
// eval. The discipline is the one the per-chunk ladder already uses, moved up a
// level — a failed batch SPLITS rather than degrading, and a batch of one falls
// through to exactly the per-chunk path that existed before.
//
// The fixture is built so the poisoned namespaces sort FIRST, and that detail is
// the test. Batch size shrinks as the queue drains, so a poison sorting last is
// already alone in a batch of one by the time it is reached — it never fails a
// BATCH, and the split path this file exists to check never runs. An earlier
// version of this test had exactly that hole and passed anyway; the coverage
// counters are what caught it.
//
// PATH mutation is process-global, so this file holds ONE test.

mod common;

use common::TempDir;
use flake_explorer::options::{ExtractOptionsOpts, extract_options};
use flake_explorer::schema::ConfigKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// Four poisoned namespaces (`p01`-`p04`, fine once values are skipped) sorting
/// ahead of eight healthy ones. With one worker the first batch is four wide and
/// entirely poison, so it splits 4 -> 2 -> 1 under the cap before the ladder
/// takes over; and once those four are the only work left they batch together
/// again at the degraded rung, which is where one eval emits ladder notes for
/// several chunks at once.
///
/// Every call is appended to `$NIX_SHIM_DIR/calls` so the test can count what was
/// actually asked of nix rather than infer it from timing.
const SHIM: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$NIX_SHIM_DIR/calls"
emit_opt() { printf '{"loc":["%s","x"],"readOnly":false,"isDefined":true,"highestPrio":100,"default":null,"value":%s,"declarations":[],"definitions":[]}' "$1" "$2"; }
poisoned() { case "$1" in p0*) return 0 ;; *) return 1 ;; esac; }
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *'mode\":\"optionNames'*)
    case "$*" in
      *'path\":['*) echo '[]' ;;
      *) echo '["p01","p02","p03","p04","z01","z02","z03","z04","z05","z06","z07","z08"]' ;;
    esac ;;
  *'mode\":\"optionsBatch'*)
    ns=$(printf '%s' "$*" | sed 's/.*chunks\\":\[//' | tr ',' '\n' | sed -n 's/.*path\\":\[\\"\([a-z0-9]*\)\\".*/\1/p')
    # Any poisoned member at full detail takes the whole eval down with it.
    case "$*" in
      *'withValues\":true'*)
        for n in $ns; do
          if poisoned "$n"; then echo "error: $n exploded" >&2; exit 1; fi
        done ;;
    esac
    printf '{"results":['
    first=1
    for n in $ns; do
      [ $first -eq 1 ] || printf ','
      first=0
      if poisoned "$n"; then v=null; else v='{"ok":1}'; fi
      printf '{"options":['; emit_opt "$n" "$v"; printf ']}'
    done
    printf ']}'
    ;;
  *'mode\":\"options'*)
    n=$(printf '%s' "$*" | sed -n 's/.*path\\":\[\\"\([a-z0-9]*\)\\".*/\1/p')
    if poisoned "$n"; then
      case "$*" in
        *'withValues\":true'*) echo "error: $n exploded" >&2; exit 1 ;;
      esac
      printf '{"options":['; emit_opt "$n" null; printf ']}'
    else
      printf '{"options":['; emit_opt "$n" '{"ok":1}'; printf ']}'
    fi ;;
  *) echo "nix shim: unexpected argv: $*" >&2; exit 9 ;;
esac
"#;

#[tokio::test]
async fn chunks_batch_and_a_poisoned_batch_splits_without_costing_its_siblings() {
    let shim = TempDir::new("batching-shim");
    let nix = shim.0.join("nix");
    std::fs::write(&nix, SHIM).unwrap();
    std::fs::set_permissions(&nix, std::fs::Permissions::from_mode(0o755)).unwrap();
    let calls = shim.0.join("calls");

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

    let r = extract_options(
        "github:example/batch-flake",
        ConfigKind::Nixos,
        "host",
        ExtractOptionsOpts {
            timeout: Duration::from_secs(20),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let log = std::fs::read_to_string(&calls).unwrap_or_default();
    let batched: Vec<&str> = log
        .lines()
        .filter(|l| l.contains(r#"mode\":\"optionsBatch"#))
        .collect();
    let multi = |l: &&str| l.matches(r#"path\":["#).count() > 1;

    // 1. Batching happened, and a batch actually DIED. Without the second half
    //    the split path never runs and this file checks nothing — which is the
    //    hole the previous fixture had.
    assert!(
        batched.iter().any(multi),
        "no batched call carried more than one chunk:\n{log}"
    );
    assert!(
        batched.iter().any(|l| multi(l) && l.contains(r#"\"p01\""#)),
        "the poisoned namespaces were never batched with anyone, so nothing \
         exercised the split path:\n{log}"
    );

    // 2. It cost fewer processes than one-per-chunk, which is the whole point.
    //    Twelve chunks plus four two-call ladders is 21 without batching.
    let calls = log.lines().count();
    assert!(
        calls < 21,
        "{calls} nix calls — batching saved nothing against the 21 a \
         chunk-per-process pass would make:\n{log}"
    );

    // 3. Nothing was lost.
    let mut locs: Vec<String> = r.data.options.iter().map(|o| o.loc.join(".")).collect();
    locs.sort();
    assert_eq!(
        locs.len(),
        12,
        "expected every namespace back, got {locs:?}"
    );

    // 4. The poison cost only itself. Each poisoned namespace degrades to a
    //    values-skipped note; the healthy ones it shared an eval with keep their
    //    values, which is the property batching could plausibly have broken.
    assert_eq!(
        r.warnings,
        [
            "nixos/host options.p01: values skipped (eval error at full detail)",
            "nixos/host options.p02: values skipped (eval error at full detail)",
            "nixos/host options.p03: values skipped (eval error at full detail)",
            "nixos/host options.p04: values skipped (eval error at full detail)",
        ],
        "warnings were {:?}",
        r.warnings
    );
    for o in &r.data.options {
        let expected = if o.loc[0].starts_with('p') {
            None
        } else {
            Some(serde_json::json!(1))
        };
        assert_eq!(
            o.value,
            expected,
            "{} kept the wrong detail",
            o.loc.join(".")
        );
    }
}
