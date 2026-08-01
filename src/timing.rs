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
///
/// `0` and the empty string are off so that `FLAKE_EXPLORER_TIMINGS=0` in a
/// shell profile reads the way it looks, rather than being a subtle on.
#[must_use]
pub fn is_enabled(raw: Option<&OsStr>) -> bool {
    raw.is_some_and(|v| !v.is_empty() && v != OsStr::new("0"))
}

/// One phase of the run: `timing: options 1234ms`.
#[must_use]
pub fn phase_line(label: &str, d: Duration) -> String {
    format!("timing: {label} {}ms", d.as_millis())
}

/// One item within a phase, indented under it: a phase total says the options
/// pass was slow, an item line says which configuration made it slow.
#[must_use]
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
    #[must_use]
    pub fn from_env() -> Self {
        Self::new(is_enabled(std::env::var_os(VAR).as_deref()))
    }

    #[must_use]
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            started: Instant::now(),
        }
    }

    #[must_use]
    pub const fn enabled(&self) -> bool {
        self.enabled
    }

    /// Start of a span, for callers that measure around their own work.
    #[must_use]
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

    /// A span the caller measured both ends of. `phase` brackets work that owns
    /// the machine for its duration and can read the clock at the end; once a
    /// pass's units overlap there is no such moment, only a first start and a
    /// last finish, and those have to be handed in.
    pub fn window(&self, label: &str, start: Instant, end: Instant) {
        if self.enabled {
            eprintln!(
                "{}",
                phase_line(label, end.saturating_duration_since(start))
            );
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

    /// A window measures between two marks the caller kept, not from a mark to
    /// "now" — which is the whole reason it exists, since the last unit of an
    /// overlapping pass finishes well before the driver gets to report it.
    #[test]
    fn a_window_measures_the_span_it_is_handed() {
        let t = Timings::new(true);
        let start = t.mark();
        let end = start + Duration::from_millis(250);
        // Same line shape as a phase — a window IS a phase total, differing
        // only in how its end was decided, so bench's parser sees no new form.
        assert_eq!(
            phase_line("packages", end.saturating_duration_since(start)),
            "timing: packages 250ms"
        );
        // An empty span is silent-safe rather than a panic on the reversed
        // subtraction a completion-ordered pair could hand it.
        t.window("packages", end, start);
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
