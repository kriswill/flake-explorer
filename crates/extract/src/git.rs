// Per-file last-commit info from a single streamed `git log --name-only`
// walk. One O(history) subprocess instead of
// O(files) `git log -1` calls.

use crate::schema::GitFileInfo;
use std::collections::HashMap;
use tokio::process::Command;

/// Path of `dir` relative to its git repo root ("" when dir IS the root);
/// None when dir is not inside a git work tree.
pub async fn repo_prefix(dir: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["-C", dir, "rev-parse", "--show-prefix"])
        .output()
        .await
        .ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Map of repo-relative path -> last commit touching it. Empty map (with a
/// warning pushed) when git log fails.
pub async fn last_commits(
    checkout: &str,
    warnings: &mut Vec<String>,
) -> HashMap<String, GitFileInfo> {
    let mut result = HashMap::new();
    let out = Command::new("git")
        // \x01 marks a commit header so file lines can't be confused with it.
        .args([
            "-C",
            checkout,
            "log",
            "--format=%x01%H%x09%aI%x09%s",
            "--name-only",
            "--",
            "*.nix",
        ])
        .output()
        .await;
    let out = match out {
        Ok(o) => o,
        Err(e) => {
            warnings.push(format!("git log failed in {checkout}: {e}"));
            return result;
        }
    };
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let first = err.trim().lines().next().unwrap_or("unknown error");
        warnings.push(format!("git log failed in {checkout}: {first}"));
        return result;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut current: Option<GitFileInfo> = None;
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix('\x01') {
            let mut parts = rest.split('\t');
            let commit = parts.next().unwrap_or("").to_string();
            let date = parts.next().unwrap_or("").to_string();
            let subject = parts.collect::<Vec<_>>().join("\t");
            current = Some(GitFileInfo {
                commit,
                date,
                subject,
            });
        } else if !line.trim().is_empty()
            && let Some(cur) = &current
        {
            result
                .entry(line.trim().to_string())
                .or_insert_with(|| cur.clone());
        }
    }
    result
}
