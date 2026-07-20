import { describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { inputInfos, localFlakeDir, packageRefs, safeName } from "../src/extract/manifest"
import type {
  FlakeMetadataJson,
  InputsTreeNode,
  LockNode,
  ManifestEval,
} from "../src/extract/run-nix"
import type { OutputNode } from "../src/schema"

// ------------------------------------------------------------- packageRefs

// Tiny OutputNode factories — every fixture below is built from these.
const leaf = (type = "derivation"): OutputNode => ({ kind: "leaf", type })
const attrs = (children: Record<string, OutputNode>): OutputNode => ({ kind: "attrset", children })

describe("packageRefs", () => {
  test("empty attrset tree yields no refs", () => {
    expect(packageRefs(attrs({}))).toEqual([])
  })

  test("a top-level tree that is itself a leaf yields no refs", () => {
    expect(packageRefs(leaf())).toEqual([])
  })

  test("packages/devShells/checks leaves at depth 3 each become a ref", () => {
    const tree = attrs({
      packages: attrs({ "x86_64-linux": attrs({ foo: leaf() }) }),
      devShells: attrs({ "x86_64-linux": attrs({ default: leaf() }) }),
      checks: attrs({ "aarch64-darwin": attrs({ lint: leaf() }) }),
    })
    expect(packageRefs(tree)).toEqual([
      {
        id: "packages/x86_64-linux/foo",
        path: ["packages", "x86_64-linux", "foo"],
        dataFile: "package/packages.x86_64-linux.foo.json",
        status: "pending",
      },
      {
        id: "devShells/x86_64-linux/default",
        path: ["devShells", "x86_64-linux", "default"],
        dataFile: "package/devShells.x86_64-linux.default.json",
        status: "pending",
      },
      {
        id: "checks/aarch64-darwin/lint",
        path: ["checks", "aarch64-darwin", "lint"],
        dataFile: "package/checks.aarch64-darwin.lint.json",
        status: "pending",
      },
    ])
  })

  test("formatter is depth 2: one ref per system, no name segment", () => {
    const tree = attrs({ formatter: attrs({ "x86_64-linux": leaf() }) })
    expect(packageRefs(tree)).toEqual([
      {
        id: "formatter/x86_64-linux",
        path: ["formatter", "x86_64-linux"],
        dataFile: "package/formatter.x86_64-linux.json",
        status: "pending",
      },
    ])
  })

  test("non-leaf, omitted, and unknown nodes where a leaf is expected are skipped", () => {
    const tree = attrs({
      packages: attrs({
        "x86_64-linux": attrs({
          ok: leaf(),
          nested: attrs({ deeper: leaf() }), // attrset where a leaf is expected
          gone: { kind: "omitted" },
          weird: { kind: "unknown" },
        }),
        // system node that is not an attrset (omitted other-system output)
        "aarch64-linux": { kind: "omitted" },
      }),
      formatter: attrs({ "x86_64-linux": { kind: "omitted" } }),
    })
    expect(packageRefs(tree).map((r) => r.id)).toEqual(["packages/x86_64-linux/ok"])
  })

  test("a non-attrset category node is skipped without throwing", () => {
    const tree = attrs({ packages: leaf(), checks: { kind: "unknown" }, formatter: leaf() })
    expect(packageRefs(tree)).toEqual([])
  })
})

// ----------------------------------------------------------------- safeName

// The serve route only accepts names matching this charset; safeName's whole
// job is to map anything into it.
const SAFE = /^[\w@+.-]+$/

describe("safeName", () => {
  test("names already in the safe charset pass through unchanged", () => {
    for (const name of ["hello", "x86_64-linux", "foo.bar", "a@b+c-d"]) {
      expect(safeName(name)).toBe(name)
    }
  })

  test("unsafe names become slug + collision hash, still in the safe charset", () => {
    for (const name of ["a/b", "my host", 'say "hi"', "ünïcode"]) {
      const out = safeName(name)
      expect(out).not.toBe(name)
      expect(out).toMatch(SAFE)
      // slug of the original with the offending chars replaced, then -hash
      expect(out).toMatch(/-[0-9a-z]{1,8}$/)
    }
  })

  test("is deterministic", () => {
    expect(safeName("a/b")).toBe(safeName("a/b"))
    expect(safeName("my host")).toBe(safeName("my host"))
  })

  test("different unsafe names with identical slugs differ via the hash", () => {
    // Both slugify to "a_b"; only the base36 hash suffix distinguishes them.
    const slash = safeName("a/b")
    const space = safeName("a b")
    expect(slash.startsWith("a_b-")).toBe(true)
    expect(space.startsWith("a_b-")).toBe(true)
    expect(slash).not.toBe(space)
  })
})

// ------------------------------------------------------------- localFlakeDir

describe("localFlakeDir", () => {
  // import.meta.dir is this repo's test/ directory — guaranteed to exist.
  const dir = import.meta.dir

  test("returns an existing absolute directory unchanged", () => {
    expect(localFlakeDir(dir)).toBe(dir)
  })

  test("strips path: prefix and ?query", () => {
    expect(localFlakeDir(`path:${dir}`)).toBe(dir)
    expect(localFlakeDir(`path:${dir}?ref=main&dir=sub`)).toBe(dir)
    expect(localFlakeDir(`${dir}?rev=abc`)).toBe(dir)
  })

  test('"." and relative "./<dir>" forms work', () => {
    expect(localFlakeDir(".")).toBe(".")
    // Relative path to the test dir from wherever bun test was launched
    // (normally the repo root, so this is "./test").
    const rel = `./${relative(process.cwd(), dir)}`
    expect(localFlakeDir(rel)).toBe(rel)
  })

  test("non-existent path returns null", () => {
    expect(localFlakeDir("/definitely/not/a/real/path-xyz")).toBeNull()
    expect(localFlakeDir("./definitely-not-here-xyz")).toBeNull()
  })

  test("an existing FILE (not directory) returns null", () => {
    expect(localFlakeDir(import.meta.path)).toBeNull()
  })

  test("non-path refs return null", () => {
    expect(localFlakeDir("github:foo/bar")).toBeNull()
    expect(localFlakeDir("flake:nixpkgs")).toBeNull()
  })
})

// --------------------------------------------------------------- inputInfos

/** FlakeMetadataJson with only the lock graph varying; a "root" node must be in nodes. */
function makeMeta(nodes: Record<string, LockNode>): FlakeMetadataJson {
  return {
    path: "/nix/store/self",
    resolvedUrl: "path:/self",
    url: "path:/self",
    locks: { version: 7, root: "root", nodes },
  }
}

/** ManifestEval with only the inputs store-path tree varying. */
function makeEv(inputs: Record<string, InputsTreeNode> = {}): ManifestEval {
  return {
    self: "/nix/store/self",
    description: null,
    inputs,
    configurations: [],
    files: [],
    grafts: [],
    outputNames: {},
  }
}

describe("inputInfos", () => {
  test("direct input: locked fields and eval store path copied through, no transitive flag", () => {
    const meta = makeMeta({
      root: { inputs: { nixpkgs: "nixpkgs_lock" } },
      nixpkgs_lock: {
        locked: {
          type: "git",
          url: "https://example.com/nixpkgs.git",
          ref: "release",
          rev: "abc123",
          narHash: "sha256-xyz",
          lastModified: 1700000000,
        },
      },
    })
    const ev = makeEv({ nixpkgs: { path: "/nix/store/np-source", inputs: {} } })
    const warnings: string[] = []
    const out = inputInfos(meta, ev, warnings)

    expect(warnings).toEqual([])
    expect(Object.keys(out)).toEqual(["nixpkgs"])
    expect(out.nixpkgs).toEqual({
      name: "nixpkgs",
      nodeKey: "nixpkgs_lock",
      type: "git",
      url: "https://example.com/nixpkgs.git",
      ref: "release",
      rev: "abc123",
      narHash: "sha256-xyz",
      lastModified: 1700000000,
      storePath: "/nix/store/np-source",
      follows: undefined,
    })
    expect(out.nixpkgs!.transitive).toBeUndefined()
  })

  test('transitive input two levels deep gets name "parent/child" and transitive: true', () => {
    const meta = makeMeta({
      root: { inputs: { hm: "hm_lock" } },
      hm_lock: {
        inputs: { nixpkgs: "np_lock" },
        locked: { type: "github", owner: "nix-community", repo: "home-manager" },
      },
      np_lock: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs" } },
    })
    const ev = makeEv({
      hm: { path: "/nix/store/hm", inputs: { nixpkgs: { path: "/nix/store/np", inputs: {} } } },
    })
    const out = inputInfos(meta, ev, [])

    expect(out["hm/nixpkgs"]).toMatchObject({
      name: "hm/nixpkgs",
      nodeKey: "np_lock",
      transitive: true,
      storePath: "/nix/store/np",
    })
    expect(out.hm!.transitive).toBeUndefined()
  })

  test("follows dedup: a followed node appears once under its direct name", () => {
    // B's child "n" follows the root input A: the lock node "a_lock" is
    // reachable both as A (direct) and as B/n (via follows).
    const meta = makeMeta({
      root: { inputs: { A: "a_lock", B: "b_lock" } },
      a_lock: { locked: { type: "github", owner: "o", repo: "a" } },
      b_lock: { inputs: { n: ["A"] }, locked: { type: "github", owner: "o", repo: "b" } },
    })
    const followEdges: { name: string; target: string }[] = []
    const out = inputInfos(meta, makeEv(), [], followEdges)

    expect(Object.keys(out).sort()).toEqual(["A", "B"])
    expect(out.A!.nodeKey).toBe("a_lock")
    // The transitive alias "B/n" must not reappear as an entry — but the
    // dropped edge is recorded for the input page's follows list.
    expect(out["B/n"]).toBeUndefined()
    expect(followEdges).toEqual([{ name: "B/n", target: "A" }])
  })

  test("diamond dedup records the losing parent's edge too", () => {
    const meta = makeMeta({
      root: { inputs: { P: "p_lock", Q: "q_lock" } },
      p_lock: { inputs: { shared: "s_lock" }, locked: { type: "github", owner: "o", repo: "p" } },
      q_lock: { inputs: { shared: "s_lock" }, locked: { type: "github", owner: "o", repo: "q" } },
      s_lock: { locked: { type: "github", owner: "o", repo: "s" } },
    })
    const followEdges: { name: string; target: string }[] = []
    inputInfos(meta, makeEv(), [], followEdges)
    expect(followEdges).toEqual([{ name: "Q/shared", target: "P/shared" }])
  })

  test("root-level alias of a real input: ONE entry, real name primary, alias recorded", () => {
    // `inputs.stable.follows = "nixpkgs"` next to a real `nixpkgs` input:
    // both root names resolve to the same lock node. The real input must
    // keep its name in BOTH lock-file iteration orders (no order lottery),
    // with the alias carried in `aliases`.
    const orderings: Record<string, string | string[]>[] = [
      { stable: ["nixpkgs"], nixpkgs: "np_lock" }, // alias first
      { nixpkgs: "np_lock", stable: ["nixpkgs"] }, // real input first
    ]
    for (const inputs of orderings) {
      const meta = makeMeta({
        root: { inputs },
        np_lock: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs" } },
      })
      const ev = makeEv({ nixpkgs: { path: "/nix/store/np", inputs: {} } })
      const out = inputInfos(meta, ev, [])

      expect(Object.keys(out)).toEqual(["nixpkgs"])
      expect(out.nixpkgs).toMatchObject({
        name: "nixpkgs",
        nodeKey: "np_lock",
        aliases: ["stable"],
        storePath: "/nix/store/np",
      })
      // The primary is the real input, so it carries no follows itself.
      expect(out.nixpkgs!.follows).toBeUndefined()
      expect(out.nixpkgs!.transitive).toBeUndefined()
      expect(out.stable).toBeUndefined()
    }
  })

  test("multiple root aliases merge into one sorted aliases list", () => {
    const meta = makeMeta({
      root: { inputs: { unstable: ["nixpkgs"], nixpkgs: "np_lock", pinned: ["nixpkgs"] } },
      np_lock: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs" } },
    })
    // Only an alias has an eval store path — the entry still picks it up.
    const ev = makeEv({ pinned: { path: "/nix/store/np", inputs: {} } })
    const out = inputInfos(meta, ev, [])

    expect(Object.keys(out)).toEqual(["nixpkgs"])
    expect(out.nixpkgs!.aliases).toEqual(["pinned", "unstable"])
    expect(out.nixpkgs!.storePath).toBe("/nix/store/np")
  })

  test('root follows of a TRANSITIVE input keeps its own name and follows: "A/nixpkgs"', () => {
    // x aliases a node that is not itself a direct input; x is the only
    // root name for that node, so it stays primary with follows set, and
    // the transitive "A/nixpkgs" traversal dedups against it.
    const meta = makeMeta({
      root: { inputs: { A: "a_lock", x: ["A", "nixpkgs"] } },
      a_lock: { inputs: { nixpkgs: "np_lock" }, locked: { type: "github", owner: "o", repo: "a" } },
      np_lock: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs" } },
    })
    const out = inputInfos(meta, makeEv(), [])

    expect(Object.keys(out).sort()).toEqual(["A", "x"])
    expect(out.x).toMatchObject({ name: "x", nodeKey: "np_lock", follows: "A/nixpkgs" })
    expect(out.x!.aliases).toBeUndefined()
    expect(out["A/nixpkgs"]).toBeUndefined()
  })

  test("diamond: two parents sharing a lock node yield one entry, BFS-first name", () => {
    const meta = makeMeta({
      root: { inputs: { P: "p_lock", Q: "q_lock" } },
      p_lock: { inputs: { shared: "s_lock" }, locked: { type: "github", owner: "o", repo: "p" } },
      q_lock: { inputs: { shared: "s_lock" }, locked: { type: "github", owner: "o", repo: "q" } },
      s_lock: { locked: { type: "github", owner: "o", repo: "s" } },
    })
    const out = inputInfos(meta, makeEv(), [])

    // P was enqueued first, so its child claims the shared node.
    expect(Object.keys(out).sort()).toEqual(["P", "P/shared", "Q"])
    expect(out["Q/shared"]).toBeUndefined()
  })

  test("unresolvable follows on a DIRECT input warns and skips without throwing", () => {
    const meta = makeMeta({
      root: { inputs: { bad: ["nonexistent"], good: "g_lock" } },
      g_lock: { locked: { type: "github", owner: "o", repo: "g" } },
    })
    const warnings: string[] = []
    const out = inputInfos(meta, makeEv(), warnings)

    expect(Object.keys(out)).toEqual(["good"])
    expect(warnings).toEqual(['flake.lock: could not resolve input "bad"'])
  })

  test("unresolvable follows on a TRANSITIVE input is silently skipped", () => {
    const meta = makeMeta({
      root: { inputs: { A: "a_lock" } },
      a_lock: { inputs: { bad: ["nope"] }, locked: { type: "github", owner: "o", repo: "a" } },
    })
    const warnings: string[] = []
    const out = inputInfos(meta, makeEv(), warnings)

    expect(Object.keys(out)).toEqual(["A"])
    expect(warnings).toEqual([])
  })

  test("github input without a url field gets a synthesized github.com url", () => {
    const meta = makeMeta({
      root: { inputs: { gh: "gh_lock" } },
      gh_lock: { locked: { type: "github", owner: "NixOS", repo: "nixpkgs", rev: "deadbeef" } },
    })
    const out = inputInfos(meta, makeEv(), [])
    expect(out.gh!.url).toBe("https://github.com/NixOS/nixpkgs")
  })

  test("path-type input gets its path as url", () => {
    const meta = makeMeta({
      root: { inputs: { local: "local_lock" } },
      local_lock: { locked: { type: "path", path: "/some/where" } },
    })
    const out = inputInfos(meta, makeEv(), [])
    expect(out.local!).toMatchObject({ type: "path", url: "/some/where" })
  })
})
