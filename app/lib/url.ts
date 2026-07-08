/**
 * Best-effort http(s) URL derivable from a locked input's `url` field, or
 * null when it isn't web-linkable (a local path, git+ssh, file://, …).
 * flake.lock urls are sometimes `git+https://…`/`git+ssh://…`; strip the
 * `git+` scheme prefix and require what's left to be http(s).
 */
export function webUrl(url: string | undefined): string | null {
  if (!url) return null;
  const stripped = url.startsWith("git+") ? url.slice(4) : url;
  return /^https?:\/\//.test(stripped) ? stripped : null;
}

/**
 * Per-host commit-permalink path builders, verified against live instances:
 * github.com/…/commit/<sha> (200), gitlab.com/…/-/commit/<sha> (200, the
 * bare /commit/<sha> 301-redirects to this — confirmed on gitlab.com AND a
 * self-hosted instance, gitlab.gnome.org, so the -/ path is GitLab-generic,
 * not gitlab.com-specific), codeberg.org/…/commit/<sha> (200, same Gitea/
 * Forgejo shape as GitHub).
 */
const COMMIT_PATH: Record<string, (repoPath: string, rev: string) => string> = {
  "github.com": (p, rev) => `${p}/commit/${rev}`,
  "gitlab.com": (p, rev) => `${p}/-/commit/${rev}`,
  "codeberg.org": (p, rev) => `${p}/commit/${rev}`,
};

/** Permalink to a specific commit on a known git host, or null (unknown host, no rev, or unparseable url). */
export function commitUrl(url: string | undefined, rev: string | undefined): string | null {
  if (!rev) return null;
  const base = webUrl(url);
  if (!base) return null;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return null;
  }
  const build = COMMIT_PATH[parsed.hostname];
  if (!build) return null;
  const repoPath = parsed.pathname.replace(/\.git$/, "").replace(/\/$/, "");
  return `${parsed.origin}${build(repoPath, rev)}`;
}
