// Relative-path reference matching — plain string ops only, matching the
// client's resolution logic (app/lib/pathref.ts) exactly.

use regex::Regex;
use std::collections::HashSet;
use std::sync::LazyLock;

/// Relative path tokens: ./x, ../x/y.nix, ./dir — quoted or bare.
pub static REL_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.{1,2}/[\w@.+-]+(?:/[\w@.+-]+)*").unwrap());

fn dirname(rel_path: &str) -> &str {
    match rel_path.rfind('/') {
        Some(i) => &rel_path[..i],
        None => "",
    }
}

/// Join a dir and a relative token (./x, ../x/y), collapsing . and ..
/// segments. None if it escapes the root.
pub fn resolve_rel_ref(dir: &str, token: &str) -> Option<String> {
    let parts = if dir.is_empty() {
        token.split('/').collect::<Vec<_>>()
    } else {
        dir.split('/').chain(token.split('/')).collect()
    };
    let mut out: Vec<&str> = Vec::new();
    for part in parts {
        match part {
            "" | "." => continue,
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
pub fn resolve_known_ref(from: &str, token: &str, known: &HashSet<String>) -> Option<String> {
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
