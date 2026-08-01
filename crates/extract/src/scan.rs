// Source-text scans over the flake's own .nix files: the import graph,
// inputs.<name> references, and overlays.<name> definitions. All regex
// scans, not parsers — false positives are harmless in a visualization,
// and tree-sitter-nix is the named upgrade path.

use crate::pathref::{REL_PATH_RE, resolve_known_ref};
use crate::schema::{ImportEdge, InputRef, OverlayAttr, OverlayAttrKind, OverlayDef};
use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

/// Read a self file's text by relPath; None when unreadable.
pub type ReadFn<'a> = dyn Fn(&str) -> Option<String> + 'a;
/// relPath -> FileEntry.id.
pub type IdFn<'a> = dyn Fn(&str) -> String + 'a;

// ------------------------------------------------------------- import graph

pub fn import_graph(rel_paths: &[String], read: &ReadFn, id_of: &IdFn) -> Vec<ImportEdge> {
    let known: HashSet<String> = rel_paths.iter().cloned().collect();
    let mut edges = Vec::new();
    let mut seen = HashSet::new();

    for from in rel_paths {
        let Some(text) = read(from) else { continue };
        for m in REL_PATH_RE.find_iter(&text) {
            let Some(to) = resolve_known_ref(from, m.as_str(), &known) else {
                continue;
            };
            if !seen.insert(format!("{from}\x00{to}")) {
                continue;
            }
            edges.push(ImportEdge {
                from: id_of(from),
                to: id_of(&to),
            });
        }
    }
    edges
}

// --------------------------------------------------------------- input refs

// All patterns below are tested literals; a broken one compiles to None and
// its scan degrades to "finds nothing" rather than aborting extraction.

/// `inputs.<name>` / `inputs'.<name>` — first attr segment only.
static INPUT_REF_RE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\binputs'?\.([A-Za-z_][A-Za-z0-9_'-]*)").ok());

pub fn scan_input_refs<S: std::hash::BuildHasher>(
    rel_paths: &[String],
    canonical: &HashMap<String, String, S>,
    read: &ReadFn,
    id_of: &IdFn,
) -> Vec<InputRef> {
    let Some(input_ref_re) = INPUT_REF_RE.as_ref() else {
        return Vec::new();
    };
    let mut refs = Vec::new();
    let mut seen = HashSet::new();

    for from in rel_paths {
        let Some(text) = read(from) else { continue };
        for c in input_ref_re.captures_iter(&text) {
            let Some(input) = canonical.get(&c[1]) else {
                continue;
            };
            if !seen.insert(format!("{from}\x00{input}")) {
                continue;
            }
            refs.push(InputRef {
                file: id_of(from),
                input: input.clone(),
            });
        }
    }
    refs
}

/// Name/alias → canonical name map, from Manifest.inputs.
#[must_use]
pub fn canonical_input_names(
    inputs: &indexmap::IndexMap<String, crate::schema::InputInfo>,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for info in inputs.values() {
        if info.transitive == Some(true) {
            continue; // "parent/child" names can't appear as attr segments
        }
        map.insert(info.name.clone(), info.name.clone());
        for a in info.aliases.iter().flatten() {
            map.insert(a.clone(), info.name.clone());
        }
    }
    map
}

// ------------------------------------------------------------- overlay defs

// `(?<![\w'.-])` keeps `nixpkgs.overlays`/`inputs.x.overlays` (usages) from
// matching while still allowing the explicit `flake.` prefix; the `[^=]`
// tail keeps `==` comparisons out.
static ATTR_FORM_RE: LazyLock<Option<FancyRegex>> = LazyLock::new(|| {
    FancyRegex::new(r"(?<![\w'.-])(?:flake\.)?overlays\.([A-Za-z_][A-Za-z0-9_'-]*)\s*=[^=]").ok()
});
static BLOCK_FORM_RE: LazyLock<Option<FancyRegex>> =
    LazyLock::new(|| FancyRegex::new(r"(?<![\w'.-])(?:flake\.)?overlays\s*=\s*(?:rec\s+)?\{").ok());
static ENTRY_RE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"(?:^|[;{])\s*([A-Za-z_][A-Za-z0-9_'-]*)\s*=([^;]*)").ok());

// The overlay body lambda: `final: prev: {`, `self: super: {`, underscore- or
// `@`-pattern variants. Group 2 is the "prev"/"super" binding name.
static OVERLAY_LAMBDA_RE: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(
        r"^(_?[A-Za-z][\w'-]*)(?:\s*@\s*\{[^{}]*\})?\s*:\s*(_?[A-Za-z][\w'-]*)(?:\s*@\s*\{[^{}]*\})?\s*:\s*(?:rec\s+)?\{",
    )
    .ok()
});
static IMPORT_RHS_RE: LazyLock<Option<Regex>> =
    LazyLock::new(|| Regex::new(r"\bimport\s+(\S+)").ok());

pub fn scan_overlay_defs(rel_paths: &[String], read: &ReadFn, id_of: &IdFn) -> Vec<OverlayDef> {
    let (Some(attr_form_re), Some(block_form_re), Some(entry_re)) = (
        ATTR_FORM_RE.as_ref(),
        BLOCK_FORM_RE.as_ref(),
        ENTRY_RE.as_ref(),
    ) else {
        return Vec::new();
    };
    let known: HashSet<String> = rel_paths.iter().cloned().collect();
    let mut defs: Vec<OverlayDef> = Vec::new();
    let mut seen = HashSet::new();

    // An imported overlay body may be attached from several files; read each once.
    let mut text_cache: HashMap<String, Option<String>> = HashMap::new();

    // Definition-site relPath: the import target when <rhs> is a resolvable
    // relative import, else `from`.
    let site_rel_of = |from: &str, rhs: &str| -> String {
        let Some(m) = IMPORT_RHS_RE.as_ref().and_then(|re| re.captures(rhs)) else {
            return from.to_string();
        };
        let token = REL_PATH_RE.find(&m[1]).map(|t| t.as_str().to_string());
        token
            .and_then(|t| resolve_known_ref(from, &t, &known))
            .unwrap_or_else(|| from.to_string())
    };

    for from in rel_paths {
        let Some(text) = read(from) else { continue };

        // Collect (name, rhs, rhs_start) sites from both definition shapes,
        // then record each; a closure would need simultaneous &mut borrows.
        let mut sites: Vec<(String, String, usize)> = Vec::new();

        for caps in attr_form_re.captures_iter(&text).flatten() {
            let (Some(whole), Some(name)) = (caps.get(0), caps.get(1)) else {
                continue;
            };
            // The match ends with `=` + one lookahead char, so the rhs begins
            // at its end - 1.
            let Some(rhs_start) = whole.end().checked_sub(1) else {
                continue;
            };
            sites.push((
                name.as_str().to_string(),
                rest_of_statement(&text, rhs_start),
                rhs_start,
            ));
        }

        for m in block_form_re.find_iter(&text).flatten() {
            let block_start = m.end();
            let block = top_level_text(&text, block_start);
            for e in entry_re.captures_iter(&block) {
                let Some(whole) = e.get(0) else { continue };
                let Some(eq) = whole.as_str().find('=') else {
                    continue;
                };
                let rhs_start = block_start
                    .saturating_add(whole.start())
                    .saturating_add(eq)
                    .saturating_add(1);
                sites.push((e[1].to_string(), e[2].to_string(), rhs_start));
            }
        }

        for (name, rhs, rhs_start) in sites {
            let site_rel = site_rel_of(from, &rhs);
            let file = id_of(&site_rel);
            if !seen.insert(format!("{name}\x00{file}")) {
                continue;
            }
            let (body, body_start): (Option<String>, usize) = if site_rel == *from {
                (Some(text.clone()), rhs_start)
            } else {
                let body = text_cache
                    .entry(site_rel.clone())
                    .or_insert_with(|| read(&site_rel))
                    .clone();
                (body, 0)
            };
            let attrs = body
                .map(|b| enumerate_overlay_attrs(&b, body_start))
                .unwrap_or_default();
            defs.push(OverlayDef {
                name,
                file,
                attrs: (!attrs.is_empty()).then_some(attrs),
            });
        }
    }
    defs
}

/// Enumerate the top-level attrs of the overlay lambda whose body begins
/// (after leading whitespace/comments) at `from` in `text`.
fn enumerate_overlay_attrs(text: &str, from: usize) -> Vec<OverlayAttr> {
    let (Some(lambda_re), Some(entry_re)) = (OVERLAY_LAMBDA_RE.as_ref(), ENTRY_RE.as_ref()) else {
        return Vec::new();
    };
    let start = skip_trivia(text, from);
    let Some(header) = text.get(start..).and_then(|tail| lambda_re.captures(tail)) else {
        return Vec::new();
    };
    let (Some(whole), Some(prev)) = (header.get(0), header.get(2)) else {
        return Vec::new();
    };
    let prev_name = prev.as_str(); // "prev"/"super"
    let brace_at = start.saturating_add(whole.end()); // just past the body-opening `{`
    let body = top_level_text(text, brace_at);

    let mut attrs = Vec::new();
    let mut seen = HashSet::new();
    for e in entry_re.captures_iter(&body) {
        let name = e[1].to_string();
        if !seen.insert(name.clone()) {
            continue;
        }
        let rhs = e.get(2).map_or("", |m| m.as_str());
        // Override = the attr redefines the SAME-named package from prev/super.
        let override_ = prev_name != "_"
            && FancyRegex::new(&format!(
                r"(?<![\w'-]){}\.{}(?![\w'-])",
                fancy_regex::escape(prev_name),
                fancy_regex::escape(&name)
            ))
            .is_ok_and(|re| re.is_match(rhs).unwrap_or(false));
        attrs.push(OverlayAttr {
            name,
            kind: if override_ {
                OverlayAttrKind::Override
            } else {
                OverlayAttrKind::Add
            },
        });
    }
    attrs
}

// Advance past whitespace, `#` line comments, and `/* … */` block comments.
// Byte-indexed; comment/whitespace delimiters are all ASCII so multi-byte
// UTF-8 content passes through untouched.
fn skip_trivia(text: &str, mut i: usize) -> usize {
    let b = text.as_bytes();
    loop {
        while b.get(i).is_some_and(|&c| char::from(c).is_whitespace()) {
            i = i.saturating_add(1);
        }
        if b.get(i) == Some(&b'#') {
            while b.get(i).is_some_and(|&c| c != b'\n') {
                i = i.saturating_add(1);
            }
            continue;
        }
        if b.get(i) == Some(&b'/') && b.get(i.saturating_add(1)) == Some(&b'*') {
            i = i.saturating_add(2);
            while b.get(i.saturating_add(1)).is_some()
                && !(b.get(i) == Some(&b'*') && b.get(i.saturating_add(1)) == Some(&b'/'))
            {
                i = i.saturating_add(1);
            }
            i = i.saturating_add(2).min(b.len());
            continue;
        }
        return i;
    }
}

/// Text from `at` to the next `;` or newline — the attr form's <rhs>.
fn rest_of_statement(text: &str, at: usize) -> String {
    let tail = text.get(at..).unwrap_or_default();
    let end = tail.find([';', '\n']).unwrap_or(tail.len());
    tail.get(..end).unwrap_or_default().to_string()
}

/// The depth-1 text of a brace block starting right AFTER its `{`, with any
/// nested `{…}` bodies and `#` line comments blanked out. Output length
/// matches the consumed span, so caller offsets stay aligned. Non-ASCII bytes
/// inside nested spans are blanked one space per byte, preserving offsets.
fn top_level_text(text: &str, start: usize) -> String {
    let b = text.as_bytes();
    let mut depth: i32 = 1;
    let mut out = String::new();
    let mut i = start;
    while depth > 0 {
        let Some(&c) = b.get(i) else { break };
        if c == b'#' {
            while b.get(i).is_some_and(|&c| c != b'\n') {
                out.push(' ');
                i = i.saturating_add(1);
            }
            out.push('\n');
            i = i.saturating_add(1);
            continue;
        }
        if c == b'{' {
            depth = depth.saturating_add(1);
        } else if c == b'}' {
            depth = depth.saturating_sub(1);
        }
        if depth == 1 && c.is_ascii() {
            out.push(char::from(c));
        } else {
            out.push(' ');
        }
        i = i.saturating_add(1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(rel: &str) -> String {
        format!("self:{rel}")
    }

    #[test]
    fn import_graph_basic() {
        let files = vec!["flake.nix".to_string(), "mods/a.nix".to_string()];
        let read = |rel: &str| -> Option<String> {
            match rel {
                "flake.nix" => Some("{ imports = [ ./mods/a.nix ]; }".into()),
                "mods/a.nix" => Some("{ }".into()),
                _ => None,
            }
        };
        let edges = import_graph(&files, &read, &ids);
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].from, "self:flake.nix");
        assert_eq!(edges[0].to, "self:mods/a.nix");
    }

    #[test]
    fn input_refs_canonicalized() {
        let files = vec!["a.nix".to_string()];
        let read = |_: &str| Some("{ pkgs = inputs.nixpkgs; x = inputs'.stable; }".to_string());
        let canonical: HashMap<String, String> = [
            ("nixpkgs".to_string(), "nixpkgs".to_string()),
            ("stable".to_string(), "nixpkgs".to_string()),
        ]
        .into();
        let refs = scan_input_refs(&files, &canonical, &read, &ids);
        assert_eq!(refs.len(), 1); // both dedupe to nixpkgs
        assert_eq!(refs[0].input, "nixpkgs");
    }

    #[test]
    fn overlay_attr_form_with_body() {
        let files = vec!["o.nix".to_string()];
        let read = |_: &str| {
            Some(
                "{ overlays.default = final: prev: { rtk = prev.rtk.overrideAttrs (o: {}); extra = final.hello; }; }"
                    .to_string(),
            )
        };
        let defs = scan_overlay_defs(&files, &read, &ids);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "default");
        let attrs = defs[0].attrs.as_ref().unwrap();
        assert_eq!(attrs[0].name, "rtk");
        assert_eq!(attrs[0].kind, OverlayAttrKind::Override);
        assert_eq!(attrs[1].name, "extra");
        assert_eq!(attrs[1].kind, OverlayAttrKind::Add);
    }

    #[test]
    fn overlay_usage_not_matched() {
        let files = vec!["u.nix".to_string()];
        let read = |_: &str| Some("{ nixpkgs.overlays = [ x ]; a.overlays.foo = 1; }".to_string());
        let defs = scan_overlay_defs(&files, &read, &ids);
        assert!(defs.is_empty());
    }
}
