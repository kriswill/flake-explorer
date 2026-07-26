// Opt-in phase timer for the extraction driver. `FLAKE_EXPLORER_TIMINGS=1`
// makes each pass report its wall clock; unset, nothing is emitted and the run
// prints exactly what it printed before this module existed. That silence is
// the contract tests/timings.rs pins down — timing output is a benchmarking
// aid, and a benchmarking aid that changes the artifact under measurement is
// worse than none.
//
// WHY THE ROOT CRATE. The interesting subphases — `nix flake metadata`, `nix
// flake show`, the manifest eval, the git walk, the source scans — all live
// inside build_manifest in flake-explorer-extract, and instrumenting them
// there would feed crates/extract/build.rs's content hash and so invalidate
// every user's cached blobs for a change that cannot affect a blob's bytes
// (see that file's header). drive.rs wraps the same work one level out, where
// the hash cannot see it, and a phase's wall clock measured from out here is
// the same number measured from in there. What it cannot do is split the
// manifest pass; bench/BASELINES.md records that gap rather than paying a
// cache invalidation to close it.
//
// Everything goes to stderr. stdout is progress text a caller may pipe, and
// stderr already carries the warnings, so the split also makes "stdout is
// unchanged" a property a test can assert byte for byte.

use std::ffi::OsStr;
use std::time::{Duration, Instant};

/// The env var that turns timing on. Any value except unset, empty and `0`.
pub const VAR: &str = "FLAKE_EXPLORER_TIMINGS";

/// True when `raw` (the var's value, `None` when unset) asks for timings.
/// `0` and the empty string are off so that `FLAKE_EXPLORER_TIMINGS=0` in a
/// shell profile reads the way it looks, rather than being a subtle on.
pub fn is_enabled(raw: Option<&OsStr>) -> bool {
    match raw {
        None => false,
        Some(v) => !v.is_empty() && v != OsStr::new("0"),
    }
}

/// One phase of the run: `timing: options 1234ms`.
pub fn phase_line(label: &str, d: Duration) -> String {
    format!("timing: {label} {}ms", d.as_millis())
}

/// One item within a phase, indented under it: a phase total says the options
/// pass was slow, an item line says which configuration made it slow.
pub fn item_line(phase: &str, id: &str, d: Duration) -> String {
    format!("timing:   {phase} {id} {}ms", d.as_millis())
}

/// A run's timer. Cheap to construct and to call when disabled, so the driver
/// does not need to guard its call sites.
pub struct Timings {
    enabled: bool,
    started: Instant,
}

impl Timings {
    pub fn from_env() -> Timings {
        Timings::new(is_enabled(std::env::var_os(VAR).as_deref()))
    }

    pub fn new(enabled: bool) -> Timings {
        Timings {
            enabled,
            started: Instant::now(),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Start of a span, for callers that measure around their own work.
    pub fn mark(&self) -> Instant {
        Instant::now()
    }

    pub fn phase(&self, label: &str, since: Instant) {
        if self.enabled {
            eprintln!("{}", phase_line(label, since.elapsed()));
        }
    }

    pub fn item(&self, phase: &str, id: &str, since: Instant) {
        if self.enabled {
            eprintln!("{}", item_line(phase, id, since.elapsed()));
        }
    }

    /// The whole run, measured from construction.
    pub fn total(&self) {
        if self.enabled {
            eprintln!("{}", phase_line("total", self.started.elapsed()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_meaningful_value_enables_timings() {
        assert!(!is_enabled(None));
        assert!(!is_enabled(Some(OsStr::new(""))));
        assert!(!is_enabled(Some(OsStr::new("0"))));
        assert!(is_enabled(Some(OsStr::new("1"))));
        assert!(is_enabled(Some(OsStr::new("yes"))));
    }

    #[test]
    fn lines_carry_the_phase_the_id_and_whole_milliseconds() {
        assert_eq!(
            phase_line("manifest", Duration::from_millis(1234)),
            "timing: manifest 1234ms"
        );
        assert_eq!(
            item_line("options", "nixos/mini", Duration::from_micros(1500)),
            "timing:   options nixos/mini 1ms"
        );
    }

    #[test]
    fn a_disabled_timer_stays_disabled() {
        let t = Timings::new(false);
        assert!(!t.enabled());
        // No output to assert on, but the calls must be safe to make anyway —
        // the driver does not branch on enabled() at its call sites.
        t.phase("manifest", t.mark());
        t.item("options", "nixos/mini", t.mark());
        t.total();
    }
}
