// The CLI entry is exercised as a subprocess: help must go to stdout with
// exit 0 (scripts pipe it), errors to stderr with exit 1.

import { describe, expect, test } from "bun:test"

const ENTRY = new URL("../flake-explorer.ts", import.meta.url).pathname

async function run(...args: string[]) {
  const proc = Bun.spawn(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

describe("cli help", () => {
  test("--help prints usage on stdout and exits 0", async () => {
    const r = await run("--help")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("usage:")
    expect(r.stdout).toContain("extract <flakeref>")
    expect(r.stdout).toContain("export <flakeref>")
    expect(r.stdout).toContain("serve <flakeref>")
    expect(r.stderr).toBe("")
  })

  test("-h and bare invocation also show help with exit 0", async () => {
    for (const args of [["-h"], ["help"], []]) {
      const r = await run(...args)
      expect(r.exitCode).toBe(0)
      expect(r.stdout).toContain("usage:")
    }
  })

  test("command --help shows help without running the command", async () => {
    const r = await run("serve", "--help")
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("usage:")
  })

  test("unknown command prints usage to stderr and exits 1", async () => {
    const r = await run("bogus")
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain("unknown command: bogus")
    expect(r.stderr).toContain("usage:")
    expect(r.stdout).toBe("")
  })
})
