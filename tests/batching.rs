// Chunk batching, hermetic via a scripted `nix` shim on PATH.
//
// Every chunk the option walk evaluates re-pays the same fixed cost: ~580ms of
// flake + module-system fixpoint before a single option is read, of which 18ms
// is nix's own startup. Measured against a real configuration that is 202s of a
// 380s serial pass, and it is not recoverable from nix — an identical eval
// repeated three times costs the same every time, in the `--expr` shape this
// uses AND in the installable shape nix's eval cache is actually built for, on
// a clean flake. Nothing memoizes a fixpoint across processes, so the only
// place to amortize it is inside one.
//
// So chunks go to nix in batches. The risk that buys is blast radius: an
// uncatchable error poisons the eval it occurs in, and a batch is now a bigger
// eval. The discipline is the one the per-chunk ladder already uses, moved up a
// level — a failed batch SPLITS rather than degrading, and a batch of one falls
// through to exactly the per-chunk path that existed before. That is what makes
// a healthy chunk's detail independent of which siblings it was batched with,
// which is what these tests are here to hold.
//
// PATH mutation is process-global, so this file holds ONE test.

mod common;

use common::TempDir;
use flake_explorer::options::{ExtractOptionsOpts, extract_options};
use flake_explorer::schema::ConfigKind;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

/// Twelve namespaces, of which `gamma` is poison at full detail and fine
/// without values — the shape the rung ladder exists for. Twelve against two
/// workers puts the pass in the regime where batching applies at all: with
/// fewer chunks than the pool can run at once, batches of one are the correct
/// plan and there is nothing to test.
///
/// Every call is appended to $NIX_SHIM_DIR/calls so the test can count what was
/// actually asked of nix rather than infer it from timing.
///
/// `withValues\":true` is how a full-detail request is recognized; the ladder's
/// second rung sends false.
const SHIM: &str = r#"#!/bin/sh
printf '%s\n' "$*" >> "$NIX_SHIM_DIR/calls"
emit_opt() { printf '{"loc":["%s","x"],"readOnly":false,"isDefined":true,"highestPrio":100,"default":null,"value":%s,"declarations":[],"definitions":[]}' "$1" "$2"; }
case "$*" in
  *--version*) echo "nix (Nix) 2.34.7" ;;
  *'mode\":\"optionNames'*)
    case "$*" in
      *'path\":['*) echo '[]' ;;
      *) echo '["a01","a02","a03","a04","a05","a06","a07","a08","a09","a10","a11","gamma"]' ;;
    esac ;;
  *'mode\":\"optionsBatch'*)
    # A batch carrying the poisoned namespace at full detail dies whole.
    case "$*" in
      *'\"gamma\"'*)
        case "$*" in
          *'withValues\":true'*)
            echo "error: gamma exploded" >&2; exit 1 ;;
        esac ;;
    esac
    # Otherwise: one result per chunk, in the order asked. Chunk specs appear as
    # {"path":["<ns>"],...}; recover the namespaces in order with sed.
    ns=$(printf '%s' "$*" | sed 's/.*chunks\\":\[//' | tr ',' '\n' | sed -n 's/.*path\\":\[\\"\([a-z0-9]*\)\\".*/\1/p')
    printf '{"results":['
    first=1
    for n in $ns; do
      [ $first -eq 1 ] || printf ','
      first=0
      if [ "$n" = gamma ]; then v=null; else v='{"ok":1}'; fi
      printf '{"options":['; emit_opt "$n" "$v"; printf ']}'
    done
    printf ']}'
    ;;
  *'mode\":\"options'*)
    case "$*" in
      *'\"gamma\"'*)
        case "$*" in
          *'withValues\":true'*) echo "error: gamma exploded" >&2; exit 1 ;;
        esac
        printf '{"options":['; emit_opt gamma null; printf ']}' ;;
      *) n=$(printf '%s' "$*" | sed -n 's/.*path\\":\[\\"\([a-z0-9]*\)\\".*/\1/p')
         printf '{"options":['; emit_opt "$n" '{"ok":1}'; printf ']}' ;;
    esac ;;
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

    // 1. Batching happened at all: some call carried more than one chunk.
    let multi = log
        .lines()
        .filter(|l| l.contains(r#"mode\":\"optionsBatch"#))
        .filter(|l| l.matches(r#"path\":["#).count() > 1)
        .count();
    assert!(
        multi > 0,
        "no batched call carried more than one chunk — every chunk is still \
         paying its own fixpoint:\n{log}"
    );

    // 2. It actually cost fewer processes, which is the entire point. Without
    //    batching this pass is 15 calls: one listing, twelve chunks, and
    //    gamma's two-call ladder. Each of those pays the fixpoint in full, so
    //    the call count IS the cost model here — a version that batched and
    //    still made 15 calls would have bought nothing.
    let calls = log.lines().count();
    assert!(
        calls < 15,
        "{calls} nix calls — batching saved nothing against the 15 a \
         chunk-per-process pass would make:\n{log}"
    );

    // 3. Nothing was lost: every namespace came back.
    let mut locs: Vec<String> = r.data.options.iter().map(|o| o.loc.join(".")).collect();
    locs.sort();
    assert_eq!(
        locs.len(),
        12,
        "expected every namespace back, got {locs:?}"
    );
    assert_eq!(locs[0], "a01.x");
    assert_eq!(locs[11], "gamma.x");

    // 4. The poison cost only itself. gamma degrades to a values-skipped note;
    //    its batch-mates keep their values, which is the whole property — a
    //    healthy chunk's detail must not depend on who it was batched with.
    assert_eq!(
        r.warnings,
        ["nixos/host options.gamma: values skipped (eval error at full detail)"],
        "expected exactly gamma's ladder note, got {:?}",
        r.warnings
    );
    for o in &r.data.options {
        let expected = if o.loc[0] == "gamma" {
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
