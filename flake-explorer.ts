// flake-explorer CLI: extract flake structure/options to JSON, serve the SPA.
// A wrapper may set FLAKE_EXPLORER_PROG so usage shows the invoked name.

import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { applyExtracted, extractAndPersist, reconcile } from "./src/extract/cache";
import { buildManifest, localFlakeDir } from "./src/extract/manifest";
import { checkNix } from "./src/extract/run-nix";
import type { Manifest } from "./src/schema";

const prog = process.env.FLAKE_EXPLORER_PROG ?? "bun flake-explorer.ts";

interface Flags {
  out: string;
  configs: string[] | "all" | null;
  allSystems: boolean;
  timeout: number;
  port?: number;
  dev: boolean;
  positional: string[];
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { out: "./flake-explorer-data", configs: null, allSystems: false, timeout: 600, dev: false, positional: [] };
  // A missing value (end of argv, or the next flag consumed as the value)
  // must be an error, not a silent default/NaN — a NaN timeout kills every
  // nix call instantly ("timed out after NaNs"), far from the actual typo.
  const arg = (flag: string, raw: string | undefined): string => {
    if (raw === undefined || raw.startsWith("--")) die(`${flag} expects a value`);
    return raw;
  };
  const num = (flag: string, raw: string | undefined): number => {
    const v = arg(flag, raw);
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) die(`${flag} expects a positive number, got: ${v}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") f.out = arg(a, argv[++i]);
    else if (a === "--configs") f.configs = arg(a, argv[++i]).split(",").filter(Boolean);
    else if (a === "--all") f.configs = "all";
    else if (a === "--all-systems") f.allSystems = true;
    else if (a === "--timeout") f.timeout = num(a, argv[++i]);
    else if (a === "--port") f.port = num(a, argv[++i]);
    else if (a === "--dev") f.dev = true;
    else if (a.startsWith("--")) die(`unknown flag: ${a}`);
    else f.positional.push(a);
  }
  return f;
}

function die(msg: string): never {
  console.error(`${prog}: ${msg}`);
  process.exit(1);
}

/**
 * Canonicalize path-like flakerefs: nix with lazy-trees disabled refuses a
 * flake root that is itself a symlink (/etc/nixos usually is one).
 */
function canonicalRef(ref: string): string {
  const dir = localFlakeDir(ref);
  if (!dir) return ref;
  // Keep any ?query (e.g. ?dir=sub) — it's flake selection, not filesystem.
  return realpathSync(dir) + (ref.match(/\?.*$/)?.[0] ?? "");
}

async function writeJson(path: string, value: unknown) {
  await Bun.write(path, JSON.stringify(value));
}

async function cmdExtract(flags: Flags) {
  const flakeRef = canonicalRef(
    flags.positional[0] ?? die("usage: extract <flakeref> [--out DIR] [--configs a,b | --all]"),
  );
  await checkNix();
  mkdirSync(join(flags.out, "config"), { recursive: true });

  console.log(`extracting manifest of ${flakeRef} ...`);
  const manifest = await buildManifest(flakeRef, { allSystems: flags.allSystems, timeoutMs: flags.timeout * 1000 });
  console.log(
    `  ${manifest.files.length} files, ${Object.keys(manifest.inputs).length} inputs, ` +
      `${manifest.configurations.length} configurations`,
  );
  for (const w of manifest.warnings) console.warn(`  warn: ${w}`);
  await reconcile(flags.out, manifest);

  const wanted =
    flags.configs === "all"
      ? manifest.configurations.map((c) => c.id)
      : (flags.configs ?? []).map((c) => (c.includes("/") ? c : die(`--configs takes kind/name ids, got: ${c}`)));

  for (const id of wanted) {
    const ref = manifest.configurations.find((c) => c.id === id) ?? die(`no such configuration: ${id}`);
    if (ref.status === "ok") {
      console.log(`options of ${id} cached (narHash + extractor match), skipping`);
      continue;
    }
    console.log(`extracting options of ${id} ...`);
    try {
      const r = await extractAndPersist(flags.out, flakeRef, manifest.flake.narHash, ref, {
        timeoutMs: flags.timeout * 1000,
        onProgress: (p) => process.stdout.write(`\r  ${p.done}/${p.total} ${p.current.padEnd(40).slice(0, 40)}`),
      });
      process.stdout.write("\n");
      applyExtracted(ref, r);
      manifest.warnings.push(...r.warnings);
      const customized = r.data.options.filter((o) => o.customized).length;
      console.log(`  ${r.data.options.length} options (${customized} customized) in ${(r.durationMs / 1000).toFixed(1)}s`);
      for (const w of r.warnings) console.warn(`  warn: ${w}`);
    } catch (e) {
      process.stdout.write("\n");
      ref.status = "error";
      ref.error = String(e).split("\n")[0];
      console.error(`  error: ${ref.error}`);
    }
  }

  await writeJson(join(flags.out, "manifest.json"), manifest satisfies Manifest);
  console.log(`wrote ${join(flags.out, "manifest.json")}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);

switch (cmd) {
  case "extract":
    await cmdExtract(flags);
    break;
  case "serve": {
    const { serve } = await import("./src/serve");
    await serve(canonicalRef(flags.positional[0] ?? die("usage: serve <flakeref> [--port N] [--out DIR] [--dev]")), flags);
    break;
  }
  default:
    console.log(`usage: ${prog} <command> [args]

commands:
  extract <flakeref> [--out DIR] [--configs kind/name,... | --all] [--all-systems] [--timeout SECS]
      Extract manifest (+ selected configurations) to the data dir.
  serve <flakeref> [--port N] [--out DIR] [--dev]
      Extract manifest, then serve the explorer UI with on-demand
      per-configuration extraction. --dev watches app/ and live-reloads
      the browser (run under \`bun --watch\` to cover server files too).`);
    process.exit(cmd ? 1 : 0);
}
