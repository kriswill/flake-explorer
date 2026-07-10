// Per-file last-commit info from a single streamed `git log --name-only`
// walk: the first time a path appears (newest-first order) is its last
// commit. One O(history) subprocess instead of O(files) `git log -1` calls.

export interface GitFileInfo {
  commit: string
  date: string
  subject: string
}

/**
 * Path of `dir` relative to its git repo root ("" when dir IS the root).
 * git log --name-only emits repo-root-relative paths; flake files are
 * flake-root-relative — this bridges the two when the flake lives in a
 * subdirectory. Returns null when dir is not inside a git work tree.
 */
export async function repoPrefix(dir: string): Promise<string | null> {
  const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-prefix"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  return code === 0 ? out.trim() : null
}

/**
 * Map of repo-relative path -> last commit touching it. Returns an empty map
 * (with a warning pushed) when `checkout` is not a git work tree.
 */
export async function lastCommits(
  checkout: string,
  warnings: string[],
): Promise<Map<string, GitFileInfo>> {
  const result = new Map<string, GitFileInfo>()
  const proc = Bun.spawn(
    // \x01 marks a commit header so file lines can't be confused with it.
    ["git", "-C", checkout, "log", "--format=%x01%H%x09%aI%x09%s", "--name-only", "--", "*.nix"],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) {
    warnings.push(`git log failed in ${checkout}: ${err.trim().split("\n")[0] ?? "unknown error"}`)
    return result
  }
  let current: GitFileInfo | null = null
  for (const line of out.split("\n")) {
    if (line.startsWith("\x01")) {
      const [commit, date, ...subject] = line.slice(1).split("\t")
      current = { commit: commit ?? "", date: date ?? "", subject: subject.join("\t") }
    } else if (line.trim() && current && !result.has(line.trim())) {
      result.set(line.trim(), current)
    }
  }
  return result
}
