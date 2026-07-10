// Scripted temp-repo test for src/extract/git.ts: the \x01-header stream
// parse in lastCommits (newest-first first-wins, tab-containing subjects,
// *.nix pathspec) and repoPrefix's root/subdir/non-git cases. Needs `git`
// on PATH; identity is configured locally so commits succeed regardless of
// global git config.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type GitFileInfo, lastCommits, repoPrefix } from "../src/extract/git"

let repo: string // scripted git repo with two commits
let plain: string // plain dir, not a git work tree
let first = "" // oldest commit hash
let second = "" // newest commit hash
let byPath: Map<string, GitFileInfo>

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`)
  return out.trim()
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "flake-explorer-git-"))
  plain = await mkdtemp(join(tmpdir(), "flake-explorer-nogit-"))
  await git(repo, "init", "-q")
  await git(repo, "config", "user.email", "test@example.invalid")
  await git(repo, "config", "user.name", "Test")
  await git(repo, "config", "commit.gpgsign", "false")

  await mkdir(join(repo, "sub"))
  await Bun.write(join(repo, "a.nix"), "{ }\n")
  await Bun.write(join(repo, "sub/c.nix"), "{ }\n")
  await Bun.write(join(repo, "notes.txt"), "not nix\n")
  await git(repo, "add", ".")
  await git(repo, "commit", "-q", "-m", "first: add everything")
  first = await git(repo, "rev-parse", "HEAD")

  await Bun.write(join(repo, "a.nix"), "{ x = 1; }\n")
  await git(repo, "add", ".")
  // Subject contains a tab — %s is tab-separated from %H/%aI in the parsed
  // format, so the parser must reassemble it via subject.join("\t").
  await git(repo, "commit", "-q", "-m", "second:\ttouch a.nix again")
  second = await git(repo, "rev-parse", "HEAD")

  byPath = await lastCommits(repo, [])
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
  await rm(plain, { recursive: true, force: true })
})

describe("lastCommits", () => {
  test("newest-first first-wins: a re-touched file maps to its latest commit", () => {
    expect(byPath.get("a.nix")?.commit).toBe(second)
    expect(byPath.get("sub/c.nix")?.commit).toBe(first)
  })

  test("subjects containing tabs are reassembled verbatim", () => {
    expect(byPath.get("a.nix")?.subject).toBe("second:\ttouch a.nix again")
    expect(byPath.get("sub/c.nix")?.subject).toBe("first: add everything")
  })

  test("dates are ISO-8601 (%aI)", () => {
    expect(byPath.get("a.nix")?.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test("only *.nix paths are tracked", () => {
    expect(byPath.has("notes.txt")).toBe(false)
    expect([...byPath.keys()].sort()).toEqual(["a.nix", "sub/c.nix"])
  })

  test("non-git dir yields an empty map and pushes a warning", async () => {
    const warnings: string[] = []
    const result = await lastCommits(plain, warnings)
    expect(result.size).toBe(0)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain(`git log failed in ${plain}:`)
  })
})

describe("repoPrefix", () => {
  test('returns "" when dir is the repo root', async () => {
    expect(await repoPrefix(repo)).toBe("")
  })

  test('returns "sub/" for a subdirectory of the repo', async () => {
    expect(await repoPrefix(join(repo, "sub"))).toBe("sub/")
  })

  test("returns null outside any git work tree", async () => {
    expect(await repoPrefix(plain)).toBeNull()
  })
})
