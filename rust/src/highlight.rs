// Server-side syntax highlighting (Nix + bash phase scripts) — port of
// src/extract/highlight.ts, but with NATIVE tree-sitter grammars instead of
// WASM. The vendored highlight queries are embedded; if one fails to compile
// against the crate's grammar version, the grammar crate's bundled query is
// the fallback.
//
// TokenRun offsets are UTF-16 CODE UNITS (the client slices JS strings with
// them) — tree-sitter reports bytes, so runs are converted at the end.

use crate::schema::TokenRun;
use std::sync::OnceLock;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Query, QueryCursor};

const NIX_HIGHLIGHTS: &str = include_str!("../../src/extract/vendor/nix-highlights.scm");
const BASH_HIGHLIGHTS: &str = include_str!("../../src/extract/vendor/bash-highlights.scm");

struct Grammar {
    language: Language,
    query: Query,
}

fn grammar(lang: &Language, vendored: &str, bundled: &str) -> Option<Grammar> {
    let query = Query::new(lang, vendored)
        .or_else(|_| Query::new(lang, bundled))
        .ok()?;
    Some(Grammar { language: lang.clone(), query })
}

fn nix_grammar() -> Option<&'static Grammar> {
    static G: OnceLock<Option<Grammar>> = OnceLock::new();
    G.get_or_init(|| {
        let lang: Language = tree_sitter_nix::LANGUAGE.into();
        grammar(&lang, NIX_HIGHLIGHTS, tree_sitter_nix::HIGHLIGHTS_QUERY)
    })
    .as_ref()
}

fn bash_grammar() -> Option<&'static Grammar> {
    static G: OnceLock<Option<Grammar>> = OnceLock::new();
    G.get_or_init(|| {
        let lang: Language = tree_sitter_bash::LANGUAGE.into();
        grammar(&lang, BASH_HIGHLIGHTS, tree_sitter_bash::HIGHLIGHT_QUERY)
    })
    .as_ref()
}

/// Parse `text` and resolve the highlight query's captures into flat,
/// non-overlapping runs: a narrower node wins over the broader one it nests
/// inside, and among captures on the exact same node the earliest-declared
/// query pattern wins — the highlights.scm convention.
fn tokenize(g: &Grammar, text: &str) -> Vec<TokenRun> {
    let mut parser = Parser::new();
    if parser.set_language(&g.language).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(text, None) else { return Vec::new() };

    struct Cap {
        start: usize,
        end: usize,
        pattern: usize,
        name_idx: u32,
    }
    let mut caps: Vec<Cap> = Vec::new();
    let mut cursor = QueryCursor::new();
    let mut it = cursor.captures(&g.query, tree.root_node(), text.as_bytes());
    while let Some((m, i)) = it.next() {
        let c = m.captures[*i];
        caps.push(Cap {
            start: c.node.start_byte(),
            end: c.node.end_byte(),
            pattern: m.pattern_index,
            name_idx: c.index,
        });
    }

    caps.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            // broader first — narrower paints over it below
            .then((b.end - b.start).cmp(&(a.end - a.start)))
            // same node: earlier-declared pattern paints last (wins)
            .then(b.pattern.cmp(&a.pattern))
    });

    // Paint per byte, then coalesce into runs and convert to UTF-16 offsets.
    let mut paint: Vec<Option<u32>> = vec![None; text.len()];
    for c in &caps {
        for p in paint.iter_mut().take(c.end).skip(c.start) {
            *p = Some(c.name_idx);
        }
    }

    // Byte offset -> UTF-16 code-unit offset, defined at char boundaries.
    let mut utf16_at = vec![0usize; text.len() + 1];
    let mut u16_pos = 0usize;
    for (byte_pos, ch) in text.char_indices() {
        utf16_at[byte_pos] = u16_pos;
        u16_pos += ch.len_utf16();
    }
    utf16_at[text.len()] = u16_pos;

    let names = g.query.capture_names();
    let mut runs: Vec<TokenRun> = Vec::new();
    let mut start = 0usize;
    for i in 1..=text.len() {
        if i == text.len() || paint[i] != paint[start] {
            if let Some(name_idx) = paint[start] {
                runs.push(TokenRun {
                    start: utf16_at[start],
                    end: utf16_at[i],
                    name: names[name_idx as usize].to_string(),
                });
            }
            start = i;
        }
    }
    runs
}

pub fn tokenize_nix(text: &str) -> Vec<TokenRun> {
    nix_grammar().map(|g| tokenize(g, text)).unwrap_or_default()
}

pub fn tokenize_bash(text: &str) -> Vec<TokenRun> {
    bash_grammar().map(|g| tokenize(g, text)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nix_tokens_cover_keyword_and_comment() {
        let runs = tokenize_nix("# a comment\nlet x = 1; in x");
        assert!(!runs.is_empty());
        let comment = runs.iter().find(|r| r.name == "comment").expect("comment run");
        assert_eq!(comment.start, 0);
        assert!(runs.iter().any(|r| r.name.starts_with("keyword")));
    }

    #[test]
    fn utf16_offsets_for_multibyte() {
        // "é" is 2 bytes UTF-8 but 1 UTF-16 unit; a token after it must use
        // UTF-16 units.
        let runs = tokenize_nix("# é\nlet x = 1; in x");
        let kw = runs.iter().find(|r| r.name.starts_with("keyword")).expect("keyword");
        // "# é\n" = 4 UTF-16 units (# space é \n), so `let` starts at 4.
        assert_eq!(kw.start, 4);
    }

    #[test]
    fn bash_tokens_present() {
        let runs = tokenize_bash("echo \"hello $FOO\"\nmake install");
        assert!(!runs.is_empty());
    }

    #[test]
    fn runs_non_overlapping_and_sorted() {
        let runs = tokenize_nix("{ pkgs, lib, ... }: { imports = [ ./a.nix ]; }");
        for w in runs.windows(2) {
            assert!(w[0].end <= w[1].start, "overlap: {:?} then {:?}", w[0], w[1]);
        }
    }
}
