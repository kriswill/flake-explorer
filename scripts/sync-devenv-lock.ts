// Keep devenv.lock derived from flake.lock. Every input the flake devShell
// and the devenv environment share (nixpkgs, treefmt-nix, …) is pinned in
// devenv.yaml to the exact rev flake.lock has locked, then `devenv update`
// regenerates devenv.lock from those pins. flake.lock is the single source
// of truth; devenv.lock's `devenv` node (cachix/devenv's own module tree)
// has no flake counterpart and advances freely.
//
//   bun scripts/sync-devenv-lock.ts          # pin + `devenv update` + verify
//   bun scripts/sync-devenv-lock.ts --check  # verify only (CI's parity gate)

import { join } from "node:path"

type Locked = { type: string; owner?: string; repo?: string; rev?: string }
type Lock = {
  nodes: Record<string, { locked?: Locked; inputs?: Record<string, string | string[]> }>
  root: string
}

const repoRoot = join(import.meta.dir, "..")
const checkOnly = process.argv.includes("--check")

function fail(message: string): never {
  console.error(`sync-devenv-lock: ${message}`)
  process.exit(1)
}

async function readLock(name: string): Promise<Lock> {
  return JSON.parse(await Bun.file(join(repoRoot, name)).text()) as Lock
}

// The lock's root inputs, name -> locked source. A follows-path (array)
// value never names a root-level lockable input, so those are skipped.
function rootInputs(lock: Lock): Map<string, Locked> {
  const inputs = new Map<string, Locked>()
  for (const [name, node] of Object.entries(lock.nodes[lock.root]?.inputs ?? {})) {
    if (typeof node !== "string") continue
    const locked = lock.nodes[node]?.locked
    if (locked) inputs.set(name, locked)
  }
  return inputs
}

function pinnedUrl(name: string, locked: Locked): string {
  if (locked.type !== "github" || !locked.owner || !locked.repo || !locked.rev)
    fail(`input '${name}' is not a plain github input — teach this script its source type`)
  return `github:${locked.owner}/${locked.repo}/${locked.rev}`
}

const flake = rootInputs(await readLock("flake.lock"))

if (!checkOnly) {
  // Rewrite each shared input's `url:` line in devenv.yaml to the pinned
  // rev, touching nothing else (comments and follows blocks stay put).
  const yamlPath = join(repoRoot, "devenv.yaml")
  const lines = (await Bun.file(yamlPath).text()).split("\n")
  let input: string | null = null
  let pinned = 0
  const rewritten = lines.map((line) => {
    input = line.match(/^ {2}(\S+):\s*$/)?.[1] ?? input
    if (!/^ {4}url: /.test(line) || !input || !flake.has(input)) return line
    pinned += 1
    return `    url: ${pinnedUrl(input, flake.get(input) ?? fail("unreachable"))}`
  })
  if (pinned === 0) fail("devenv.yaml shares no inputs with flake.lock — nothing to pin?")
  await Bun.write(yamlPath, rewritten.join("\n"))

  const update = Bun.spawnSync(["devenv", "update"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  if (update.exitCode !== 0) fail(`devenv update exited ${update.exitCode}`)
}

// Parity: every input devenv.lock shares with flake.lock must sit on the
// same rev. This also backstops hand-run `devenv update`s that would let
// the two locks drift.
const devenv = rootInputs(await readLock("devenv.lock"))
const shared = [...flake].filter(([name]) => devenv.has(name))
if (!shared.some(([name]) => name === "nixpkgs"))
  fail("nixpkgs is not shared between the locks — the sync scheme is broken")

const drift = shared.filter(([name, locked]) => devenv.get(name)?.rev !== locked.rev)
for (const [name, locked] of drift)
  console.error(
    `sync-devenv-lock: '${name}' drifted — flake.lock has ${locked.rev}, ` +
      `devenv.lock has ${devenv.get(name)?.rev}`,
  )
if (drift.length > 0)
  fail("locks disagree; run `bun scripts/sync-devenv-lock.ts` after `nix flake update`")

for (const [name, locked] of shared) console.log(`in sync: ${name} = ${locked.rev}`)
