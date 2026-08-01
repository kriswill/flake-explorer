// flake-explorer CLI: extract flake
// structure/options to JSON, serve the SPA, or export a standalone HTML
// file. A wrapper may set FLAKE_EXPLORER_PROG so usage shows the invoked
// name.

use flake_explorer::drive::{self, DriveFlags, Selection};
use flake_explorer::{export, manifest, serve};
use std::process::ExitCode;
use std::time::Duration;

#[expect(
    clippy::struct_excessive_bools,
    reason = "each bool mirrors an independent CLI switch; collapsing them into enums would obscure the flag surface"
)]
struct Flags {
    out: String,
    configs: Selection,
    packages: Selection,
    graphs: Selection,
    config_graphs: bool,
    graph_dry_run: bool,
    all_systems: bool,
    timeout: f64,
    html: String,
    sources_all: bool,
    port: Option<u16>,
    host: Option<String>,
    dev: bool,
    positional: Vec<String>,
}

fn prog() -> String {
    std::env::var("FLAKE_EXPLORER_PROG").unwrap_or_else(|_| "flake-explorer".to_string())
}

/// A missing value (end of argv, or the next flag consumed as the value)
/// must be an error, not a silent default.
fn arg(flag: &str, raw: Option<&String>) -> Result<String, String> {
    match raw {
        Some(v) if !v.starts_with("--") => Ok(v.clone()),
        _ => Err(format!("{flag} expects a value")),
    }
}

fn num(flag: &str, raw: Option<&String>) -> Result<f64, String> {
    let v = arg(flag, raw)?;
    match v.parse::<f64>() {
        Ok(n) if n.is_finite() && n > 0.0 => Ok(n),
        _ => Err(format!("{flag} expects a positive number, got: {v}")),
    }
}

fn ids(v: &str) -> Selection {
    Selection::Ids(
        v.split(',')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
    )
}

/// `--port` keeps the historical cast semantics: fractional values truncate
/// and out-of-range values saturate to the `u16` bounds.
#[expect(
    clippy::as_conversions,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    reason = "std has no lossless f64->u16 conversion; the saturating-truncating cast is the preexisting --port behavior"
)]
const fn port_from(n: f64) -> u16 {
    n as u16
}

fn parse_flags(argv: &[String]) -> Result<Flags, String> {
    let mut f = Flags {
        out: "./flake-explorer-data".to_string(),
        configs: Selection::None,
        packages: Selection::None,
        graphs: Selection::None,
        config_graphs: false,
        graph_dry_run: false,
        all_systems: false,
        timeout: 600.0,
        html: "./flake.html".to_string(),
        sources_all: false,
        port: None,
        host: None,
        dev: false,
        positional: Vec::new(),
    };
    let mut rest = argv.iter();
    while let Some(a) = rest.next() {
        let a = a.as_str();
        match a {
            "--out" => f.out = arg(a, rest.next())?,
            "--configs" => f.configs = ids(&arg(a, rest.next())?),
            "--packages" => f.packages = ids(&arg(a, rest.next())?),
            "--graphs" => f.graphs = ids(&arg(a, rest.next())?),
            "--config-graphs" => f.config_graphs = true,
            "--graph-dry-run" => f.graph_dry_run = true,
            // Deliberately does NOT include graphs: an 18k-node system graph
            // is a distinct cost the user asks for by name (--graphs).
            "--all" => {
                f.configs = Selection::All;
                f.packages = Selection::All;
            }
            "--all-systems" => f.all_systems = true,
            "--timeout" => f.timeout = num(a, rest.next())?,
            "--html" => f.html = arg(a, rest.next())?,
            "--sources" => match arg(a, rest.next())?.as_str() {
                "self" => f.sources_all = false,
                "all" => f.sources_all = true,
                v => return Err(format!("--sources expects self or all, got: {v}")),
            },
            "--port" => f.port = Some(port_from(num(a, rest.next())?)),
            "--host" => f.host = Some(arg(a, rest.next())?),
            "--dev" => f.dev = true,
            _ if a.starts_with("--") => return Err(format!("unknown flag: {a}")),
            _ => f.positional.push(a.to_string()),
        }
    }
    Ok(f)
}

/// Canonicalize path-like flakerefs: nix with lazy-trees disabled refuses a
/// flake root that is itself a symlink (/etc/nixos usually is one).
fn canonical_ref(r#ref: &str) -> String {
    let Some(dir) = manifest::local_flake_dir(r#ref) else {
        return r#ref.to_string();
    };
    // Keep any ?query (e.g. ?dir=sub) — it's flake selection, not filesystem.
    // find() returns a char-boundary index, so get() always succeeds here.
    let query = r#ref.find('?').and_then(|i| r#ref.get(i..)).unwrap_or("");
    std::fs::canonicalize(&dir).map_or_else(
        |_| r#ref.to_string(),
        |p| format!("{}{query}", p.to_string_lossy()),
    )
}

fn usage() -> String {
    format!(
        r#"usage: {prog} <command> [args]

commands:
  extract <flakeref> [--out DIR] [--configs kind/name,... | --all] [--packages path/segs,... | --all] [--graphs path/segs,...] [--all-systems] [--timeout SECS]
      Extract manifest (+ selected configurations/packages) to the data dir.
      --packages takes ids like "packages/x86_64-linux/rtk" (path.join("/") —
      also devShells/checks/formatter). --all means all configurations
      AND all packages. --graphs extracts the full derivation dependency
      graph of the named outputs (same id space as --packages; never
      implied by --all — a system-scale graph is a cost you opt into).
      --config-graphs additionally allows configuration ids in --graphs
      (e.g. nixos/myhost): each one instantiates the configuration's
      system.build.toplevel, ~10s of extra eval per configuration —
      never on by default. --graph-dry-run adds the exact build/fetch
      partition to each graph via `nix build --dry-run` (a second eval
      per graph; nothing is built).
  export <flakeref> [--html FILE] [--out DIR] [--configs kind/name,... | --all] [--packages path/segs,... | --all] [--graphs path/segs,...] [--all-systems] [--sources self|all] [--timeout SECS]
      Extract, then write ONE standalone HTML file (default ./flake.html)
      that works without a server — file://, any CDN, GitHub Pages.
      --sources all also embeds every file the exported configurations
      reference (can be large against nixpkgs). --graphs embeds the named
      dependency graphs (explicit only, never implied by --all).
  serve <flakeref> [--port N] [--host ADDR] [--out DIR] [--dev]
      Extract manifest, then serve the explorer UI with on-demand
      per-configuration extraction. --dev watches web/ and live-reloads
      the browser. Binds 127.0.0.1 by default — it serves file contents
      off local disk, so pass --host 0.0.0.0 only on a network you trust.

  --help, -h  Show this help.

docs: https://kris.net/flake-explorer/docs/ (or docs/ in the repo)"#,
        prog = prog()
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some((cmd, rest)) = args.split_first() else {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    };

    // Help is handled before parse_flags so `serve --help` works without
    // teaching the flag parser about it.
    if matches!(cmd.as_str(), "help" | "--help" | "-h")
        || rest.iter().any(|a| a == "--help" || a == "-h")
    {
        println!("{}", usage());
        return ExitCode::SUCCESS;
    }

    let flags = match parse_flags(rest) {
        Ok(flags) => flags,
        Err(msg) => {
            eprintln!("{}: {msg}", prog());
            return ExitCode::FAILURE;
        }
    };
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("{}: failed to start tokio runtime: {e}", prog());
            return ExitCode::FAILURE;
        }
    };
    match rt.block_on(run_command(cmd, flags)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}: {e}", prog());
            ExitCode::FAILURE
        }
    }
}

async fn run_command(cmd: &str, flags: Flags) -> anyhow::Result<()> {
    let timeout = Duration::from_secs_f64(flags.timeout);
    match cmd {
        "extract" => {
            let Some(first) = flags.positional.first() else {
                anyhow::bail!(
                    "usage: extract <flakeref> [--out DIR] [--configs a,b | --all] [--packages a,b | --all]"
                );
            };
            let flake_ref = canonical_ref(first);
            drive::extract_to_dir(
                &flake_ref,
                &DriveFlags {
                    out: flags.out.clone(),
                    configs: flags.configs.clone(),
                    packages: flags.packages.clone(),
                    graphs: flags.graphs.clone(),
                    config_graphs: flags.config_graphs,
                    graph_dry_run: flags.graph_dry_run,
                    all_systems: flags.all_systems,
                    timeout,
                },
            )
            .await?;
            Ok(())
        }
        "export" => {
            let Some(first) = flags.positional.first() else {
                anyhow::bail!(
                    "usage: export <flakeref> [--html FILE] [--configs a,b | --all] [--packages a,b | --all] [--sources self|all]"
                );
            };
            let flake_ref = canonical_ref(first);
            let r = drive::extract_to_dir(
                &flake_ref,
                &DriveFlags {
                    out: flags.out.clone(),
                    configs: flags.configs.clone(),
                    packages: flags.packages.clone(),
                    graphs: flags.graphs.clone(),
                    config_graphs: flags.config_graphs,
                    graph_dry_run: flags.graph_dry_run,
                    all_systems: flags.all_systems,
                    timeout,
                },
            )
            .await?;
            export::export_html(
                &flake_ref,
                &r.manifest,
                &export::ExportOptions {
                    out_dir: flags.out.clone(),
                    html_path: flags.html.clone(),
                    sources_all: flags.sources_all,
                    timeout,
                    wanted: r.wanted,
                    wanted_packages: r.wanted_packages,
                    wanted_graphs: r.wanted_graphs,
                },
            )
            .await
        }
        "serve" => {
            let Some(first) = flags.positional.first() else {
                anyhow::bail!("usage: serve <flakeref> [--port N] [--out DIR] [--dev]");
            };
            let flake_ref = canonical_ref(first);
            serve::serve(
                flake_ref,
                serve::ServeFlags {
                    out: flags.out.clone(),
                    config_graphs: flags.config_graphs,
                    graph_dry_run: flags.graph_dry_run,
                    all_systems: flags.all_systems,
                    timeout,
                    port: flags.port.unwrap_or(4321),
                    host: flags
                        .host
                        .clone()
                        .unwrap_or_else(|| "127.0.0.1".to_string()),
                    dev: flags.dev,
                },
            )
            .await
        }
        _ => anyhow::bail!("unknown command: {cmd}\n\n{}", usage()),
    }
}
