// Relative-path reference matching — plain string ops only, matching the
// client's resolution logic (web/lib/pathref.ts) exactly.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

/// Relative path tokens: ./x, ../x/y.nix, ./dir — quoted or bare.
pub static REL_PATH_RE: RelPathRe = RelPathRe(LazyLock::new(|| {
    Regex::new(r"\.{1,2}/[\w@.+-]+(?:/[\w@.+-]+)*").ok()
}));

/// Lazily compiled matcher exposing the two `Regex` methods the scanners use.
/// The pattern is a literal, so compilation cannot fail in practice; if it
/// ever did, the matcher degrades to finding nothing.
pub struct RelPathRe(LazyLock<Option<Regex>>);

impl RelPathRe {
    pub fn find_iter<'h>(&self, haystack: &'h str) -> impl Iterator<Item = regex::Match<'h>> {
        self.0
            .as_ref()
            .map(|re| re.find_iter(haystack))
            .into_iter()
            .flatten()
    }

    #[must_use]
    pub fn find<'h>(&self, haystack: &'h str) -> Option<regex::Match<'h>> {
        self.0.as_ref().and_then(|re| re.find(haystack))
    }
}

fn dirname(rel_path: &str) -> &str {
    rel_path.rsplit_once('/').map_or("", |(dir, _)| dir)
}

/// Join a dir and a relative token (./x, ../x/y), collapsing . and ..
/// segments. None if it escapes the root.
#[must_use]
pub fn resolve_rel_ref(dir: &str, token: &str) -> Option<String> {
    let parts = if dir.is_empty() {
        token.split('/').collect::<Vec<_>>()
    } else {
        dir.split('/').chain(token.split('/')).collect()
    };
    let mut out: Vec<&str> = Vec::new();
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                out.pop()?;
            }
            _ => out.push(part),
        }
    }
    Some(out.join("/"))
}

/// Resolve a relative reference found in `from`'s text against a set of known
/// relPaths. Falls back to `<target>/default.nix` the way Nix resolves
/// directory imports.
#[must_use]
pub fn resolve_known_ref<S: std::hash::BuildHasher>(
    from: &str,
    token: &str,
    known: &HashSet<String, S>,
) -> Option<String> {
    let target = resolve_rel_ref(dirname(from), token)?;
    if target == from {
        return None;
    }
    if known.contains(&target) {
        return Some(target);
    }
    let with_default = format!("{target}/default.nix");
    known.contains(&with_default).then_some(with_default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_dotdot() {
        assert_eq!(
            resolve_rel_ref("a/b", "../c.nix").as_deref(),
            Some("a/c.nix")
        );
        assert_eq!(resolve_rel_ref("", "./x/y.nix").as_deref(), Some("x/y.nix"));
        assert_eq!(resolve_rel_ref("a", "../../x.nix"), None);
    }

    #[test]
    fn falls_back_to_default_nix() {
        let known: HashSet<String> =
            ["mods/sops/default.nix".to_string(), "top.nix".to_string()].into();
        assert_eq!(
            resolve_known_ref("flake.nix", "./mods/sops", &known).as_deref(),
            Some("mods/sops/default.nix")
        );
        assert_eq!(resolve_known_ref("top.nix", "./top.nix", &known), None);
    }
}
