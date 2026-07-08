// flake-explorer CLI: extract flake structure/options to JSON, serve the SPA.
// A wrapper may set FLAKE_EXPLORER_PROG so usage shows the invoked name.

import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildManifest } from "./src/extract/manifest";
import { extractOptions } from "./src/extract/options";
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") f.out = argv[++i] ?? f.out;
    else if (a === "--configs") f.configs = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--all") f.configs = "all";
    else if (a === "--all-systems") f.allSystems = true;
    else if (a === "--timeout") f.timeout = Number(argv[++i] ?? f.timeout);
    else if (a === "--port") f.port = Number(argv[++i]);
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
  const bare = ref.replace(/^path:/, "");
  if ((bare.startsWith("/") || bare.startsWith(".")) && existsSync(bare) && statSync(bare).isDirectory()) {
    return realpathSync(bare);
  }
  return ref;
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

  const wanted =
    flags.configs === "all"
      ? manifest.configurations.map((c) => c.id)
      : (flags.configs ?? []).map((c) => (c.includes("/") ? c : die(`--configs takes kind/name ids, got: ${c}`)));

  for (const id of wanted) {
    const ref = manifest.configurations.find((c) => c.id === id) ?? die(`no such configuration: ${id}`);
    console.log(`extracting options of ${id} ...`);
    try {
      const r = await extractOptions(flakeRef, ref.kind, ref.name, {
        timeoutMs: flags.timeout * 1000,
        onProgress: (p) => process.stdout.write(`\r  ${p.done}/${p.total} ${p.current.padEnd(40).slice(0, 40)}`),
      });
      process.stdout.write("\n");
      await writeJson(join(flags.out, ref.dataFile), r.data);
      ref.status = "ok";
      ref.extractedAt = new Date().toISOString();
      ref.optionCount = r.data.options.length;
      ref.durationMs = r.durationMs;
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
