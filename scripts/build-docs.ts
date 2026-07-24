// Build the docs site: docs/*.md -> _site/docs/*.html, styled with the
// app's own theme (themeCss from src/build-app.ts, so light/dark palettes
// cannot drift). Optionally converts a typedoc-plugin-markdown output dir
// (--api) into <out>/api/ through the same template.
//
//   bun scripts/build-docs.ts [--out _site/docs] [--api .docs-api]
//
// GitHub renders docs/*.md natively (including mermaid fences); this script
// produces the equivalent standalone HTML for the Pages site. Mermaid is
// bundled locally (no CDN) and included only on pages that need it.

import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join, normalize } from "node:path"
import { Marked } from "marked"
import { themeCss } from "./build-app"
import { type DepLicense, packageDir, readDepLicense } from "./licenses"

const REPO_URL = "https://github.com/kriswill/flake-explorer"
const DOCS_DIR = join(import.meta.dir, "..", "docs")

// Ordered nav: curation over convention. README.md becomes index.html so
// GitHub's directory view and the site root render the same document.
const PAGES: { file: string; title: string }[] = [
  { file: "README.md", title: "Overview" },
  { file: "architecture.md", title: "Architecture" },
  { file: "data-schema.md", title: "Data schema" },
  { file: "extraction-pipeline.md", title: "Extraction pipeline" },
  { file: "frontend.md", title: "Frontend" },
  { file: "build-and-infra.md", title: "Build & infra" },
  { file: "cli.md", title: "CLI reference" },
  { file: "testing.md", title: "Testing" },
  { file: "glossary.md", title: "Glossary" },
]

function parseArgs(argv: string[]) {
  const opts = { out: "_site/docs", api: "" }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = argv[++i] ?? opts.out
    else if (argv[i] === "--api") opts.api = argv[++i] ?? ""
    else throw new Error(`unknown arg: ${argv[i]}`)
  }
  return opts
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Rewrite a markdown href for the HTML site: in-docs .md links become .html
 * (README.md -> index.html), relative links escaping docs/ point at the
 * GitHub blob view, everything else (absolute URLs, fragments, copied
 * assets like preview.png) passes through.
 */
function rewriteHref(href: string): string {
  if (/^(https?:)?\/\//.test(href) || href.startsWith("#") || href.startsWith("mailto:")) {
    return href
  }
  const [path, frag = ""] = href.split("#", 2) as [string, string?]
  const hash = frag ? `#${frag}` : ""
  const resolved = normalize(join("docs", path))
  if (!resolved.startsWith("docs/")) {
    // ../src/schema.ts and friends: browsable source on GitHub.
    return `${REPO_URL}/blob/main/${resolved}${hash}`
  }
  if (path.endsWith(".md")) {
    const base = resolved.slice("docs/".length)
    return (base === "README.md" ? "index.html" : base.replace(/\.md$/, ".html")) + hash
  }
  return href
}

function makeMarked(): Marked {
  return new Marked({
    renderer: {
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens)
        const id = slug(html)
        return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${html}</h${depth}>\n`
      },
      code({ text, lang }) {
        if (lang === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`
        const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
        return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens)
        const t = title ? ` title="${escapeHtml(title)}"` : ""
        const out = rewriteHref(href)
        const ext = /^https?:\/\//.test(out) ? ` target="_blank" rel="noopener"` : ""
        return `<a href="${out}"${t}${ext}>${text}</a>`
      },
    },
  })
}

const DOCS_CSS = `
*{box-sizing:border-box}
html{color-scheme:light dark}
body{margin:0;background:var(--page);color:var(--ink-1);font-family:system-ui,sans-serif;line-height:1.55}
header.site{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;max-width:52rem;margin:0 auto;padding:1.1rem 1.5rem 0}
header.site .brand{font-weight:700;color:var(--ink-1);text-decoration:none}
header.site .brand span{color:var(--link)}
header.site nav{display:flex;gap:0.9rem;font-size:0.85rem}
nav.pages{max-width:52rem;margin:0.6rem auto 0;padding:0 1.5rem;display:flex;flex-wrap:wrap;gap:0.25rem 0.7rem;font-size:0.85rem}
nav.pages a{color:var(--ink-2);text-decoration:none;padding:0.1rem 0.35rem;border-radius:4px}
nav.pages a:hover{color:var(--link)}
nav.pages a.current{background:var(--grid);color:var(--ink-1)}
main{max-width:52rem;margin:1rem auto 4rem;padding:1.5rem 2rem;background:var(--surface-1);border:1px solid var(--grid);border-radius:8px}
a{color:var(--link)}
h1,h2,h3,h4{line-height:1.25;scroll-margin-top:1rem}
h1{font-size:1.6rem}
a.anchor{float:left;margin-left:-1.1em;width:1.1em;color:var(--ink-muted);text-decoration:none;opacity:0;font-weight:400}
h1:hover a.anchor,h2:hover a.anchor,h3:hover a.anchor,h4:hover a.anchor{opacity:1}
code{background:color-mix(in srgb,var(--grid) 55%,transparent);padding:0.1em 0.3em;border-radius:4px;font-size:0.9em}
pre{background:color-mix(in srgb,var(--grid) 40%,transparent);border:1px solid var(--grid);border-radius:6px;padding:0.8rem 1rem;overflow-x:auto}
pre code{background:none;padding:0;font-size:0.85em}
pre.mermaid{display:flex;justify-content:center;background:none;border:none}
table{border-collapse:collapse;width:100%;font-size:0.9em;display:block;overflow-x:auto}
th,td{border:1px solid var(--grid);padding:0.35rem 0.6rem;text-align:left;vertical-align:top}
th{background:color-mix(in srgb,var(--grid) 45%,transparent)}
img{max-width:100%;border-radius:6px}
blockquote{margin:0;padding:0.1rem 1rem;border-left:3px solid var(--baseline);color:var(--ink-2)}
footer.site{max-width:52rem;margin:0 auto 2rem;padding:0 1.5rem;font-size:0.8rem;color:var(--ink-muted)}
`

/**
 * License records for the mermaid bundle's full runtime dependency closure.
 * assets/mermaid.js is minified (headers stripped), so the notices must ship
 * alongside it — same rule the app page follows via collectAbout. The closure
 * over-approximates what Bun actually inlined; over-inclusion is harmless,
 * under-inclusion is a license violation. @types/* packages contribute no
 * runtime code and are skipped.
 */
function mermaidLicenses(): DepLicense[] {
  const root = join(import.meta.dir, "..")
  const seen = new Set<string>()
  const out: DepLicense[] = []
  const visit = (name: string, from: string) => {
    if (seen.has(name) || name.startsWith("@types/")) return
    seen.add(name)
    out.push(readDepLicense(name, from))
    const dir = packageDir(name, from)
    const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    for (const dep of Object.keys(meta.dependencies ?? {})) visit(dep, dir)
  }
  visit("mermaid", root)
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function licensesHtml(deps: DepLicense[]): string {
  const items = deps
    .map(
      (d) => `<details>
<summary><code>${escapeHtml(d.name)}</code> ${escapeHtml(d.version)}${d.license ? ` · ${escapeHtml(d.license)}` : ""}</summary>
<pre>${escapeHtml(d.text)}</pre>
</details>`,
    )
    .join("\n")
  return `<h1>Bundled library licenses</h1>
<p>Diagram pages on this site load <code>assets/mermaid.js</code>, a minified
bundle of <a href="https://mermaid.js.org/" target="_blank" rel="noopener">mermaid</a>
and its dependencies. Minification strips the libraries' copyright headers, so
their license notices accompany the bundle here instead (${deps.length}
packages — the bundle's full dependency closure). DOMPurify is dual-licensed
(MPL-2.0 OR Apache-2.0) and is distributed here under Apache-2.0.</p>
${items}`
}

interface PageMeta {
  title: string
  /** Prefix from the page's directory back to the docs root ("" or "../"). */
  root: string
  current?: string
  commit: string
}

function pageShell(body: string, meta: PageMeta): string {
  const { root, commit } = meta
  const mermaid = body.includes('class="mermaid"')
    ? `\n<script type="module" src="${root}assets/mermaid.js"></script>`
    : ""
  const pageNav = PAGES.map(({ file, title }) => {
    const href = file === "README.md" ? "index.html" : file.replace(/\.md$/, ".html")
    const cls = file === meta.current ? ' class="current"' : ""
    return `<a${cls} href="${root}${href}">${title}</a>`
  })
  pageNav.push(
    `<a${meta.current === "api" ? ' class="current"' : ""} href="${root}api/index.html">API reference</a>`,
  )
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)} — flake-explorer docs</title>
<style>
${themeCss()}
${DOCS_CSS}
</style>
</head>
<body>
<header class="site">
<a class="brand" href="${root}index.html">flake-<span>explorer</span> docs</a>
<nav>
<a href="${root}../">Live demo</a>
<a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a>
</nav>
</header>
<nav class="pages">
${pageNav.join("\n")}
</nav>
<main>
${body}
</main>
<footer class="site">Generated from <a href="${REPO_URL}/tree/main/docs">docs/</a> at ${commit}.${
    mermaid
      ? ` Diagrams by mermaid — <a href="${root}licenses.html">bundled library licenses</a>.`
      : ""
  }</footer>${mermaid}
</body>
</html>
`
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const outDir = opts.out
  mkdirSync(join(outDir, "assets"), { recursive: true })

  const git = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"])
  const commit = git.success ? git.stdout.toString().trim() : "unknown"

  const marked = makeMarked()
  let usesMermaid = false

  for (const { file, title } of PAGES) {
    const md = await Bun.file(join(DOCS_DIR, file)).text()
    const body = await marked.parse(md)
    const html = pageShell(body, { title, root: "", current: file, commit })
    usesMermaid ||= html.includes('class="mermaid"')
    const name = file === "README.md" ? "index.html" : file.replace(/\.md$/, ".html")
    await Bun.write(join(outDir, name), html)
  }

  // Non-markdown assets referenced by the pages (screenshot etc.).
  for (const entry of readdirSync(DOCS_DIR)) {
    if (!entry.endsWith(".md")) copyFileSync(join(DOCS_DIR, entry), join(outDir, entry))
  }

  // API reference: typedoc-plugin-markdown output through the same shell.
  if (opts.api) {
    mkdirSync(join(outDir, "api"), { recursive: true })
    for (const entry of readdirSync(opts.api)) {
      if (!entry.endsWith(".md")) continue
      const md = await Bun.file(join(opts.api, entry)).text()
      const body = await marked.parse(md)
      const html = pageShell(body, { title: "API reference", root: "../", current: "api", commit })
      const name = entry === "README.md" ? "index.html" : entry.replace(/\.md$/, ".html")
      await Bun.write(join(outDir, "api", name), html)
    }
  }

  if (usesMermaid) {
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, "docs-mermaid-client.ts")],
      target: "browser",
      format: "esm",
      minify: true,
    })
    if (!build.success) {
      throw new Error(`mermaid bundle failed:\n${build.logs.map(String).join("\n")}`)
    }
    await Bun.write(join(outDir, "assets", "mermaid.js"), await build.outputs[0]!.text())
    // The bundle's license notices ship next to it (see mermaidLicenses).
    await Bun.write(
      join(outDir, "licenses.html"),
      pageShell(licensesHtml(mermaidLicenses()), {
        title: "Bundled library licenses",
        root: "",
        commit,
      }),
    )
  }

  console.log(`docs built at ${outDir} (${PAGES.length} pages${opts.api ? " + api" : ""})`)
}

await main()
