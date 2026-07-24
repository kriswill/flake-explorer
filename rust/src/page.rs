// Page composition — port of src/build-app.ts's pageHtml, minus the in-
// process Svelte build: the bundle is prebuilt by `bun scripts/bundle-app.ts`
// into app-dist/ (app.js, app.css, meta.json) and located at runtime.

use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct AppBundle {
    pub js: String,
    pub css: String,
    pub theme_css: String,
    pub base_font_rem: f64,
    pub about: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleMeta {
    theme_css: String,
    base_font_rem: f64,
    about: Value,
}

/// Locate app-dist: $FLAKE_EXPLORER_APP_DIST, next to the executable
/// (../share/flake-explorer/app-dist for installs), or the repo checkout
/// (compile-time path, for `cargo run`). When only the repo is found and the
/// bundle is missing, `bun scripts/bundle-app.ts` is invoked to produce it.
pub fn find_app_dist() -> anyhow::Result<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(p) = std::env::var_os("FLAKE_EXPLORER_APP_DIST") {
        candidates.push(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        candidates.push(dir.join("app-dist"));
        candidates.push(dir.join("../share/flake-explorer/app-dist"));
    }
    let repo_dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("app-dist");
    candidates.push(repo_dist.clone());

    for c in &candidates {
        if c.join("app.js").exists() && c.join("meta.json").exists() {
            return Ok(c.clone());
        }
    }

    // Dev convenience: build the bundle via bun when running from the repo.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    if repo.join("scripts/bundle-app.ts").exists() {
        eprintln!("app bundle missing — running `bun scripts/bundle-app.ts` ...");
        let status = std::process::Command::new("bun")
            .arg("scripts/bundle-app.ts")
            .arg("--out")
            .arg(&repo_dist)
            .current_dir(&repo)
            .status();
        if matches!(status, Ok(s) if s.success()) && repo_dist.join("app.js").exists() {
            return Ok(repo_dist);
        }
    }
    anyhow::bail!(
        "cannot find the app bundle (app-dist/). Build it with `bun scripts/bundle-app.ts` \
         or set FLAKE_EXPLORER_APP_DIST."
    )
}

pub fn load_bundle(dist: &Path) -> anyhow::Result<AppBundle> {
    let js = std::fs::read_to_string(dist.join("app.js"))?;
    let css = std::fs::read_to_string(dist.join("app.css"))?;
    let meta: BundleMeta = serde_json::from_str(&std::fs::read_to_string(dist.join("meta.json"))?)?;
    Ok(AppBundle {
        js,
        css,
        theme_css: meta.theme_css,
        base_font_rem: meta.base_font_rem,
        about: meta.about,
    })
}

/// An embedded-data tag loadJson resolves before fetching. Every "<" is
/// JSON-unicode-escaped, so "</script" can never occur in the body.
pub fn json_tag(name: &str, value: &Value) -> String {
    let json = serde_json::to_string(value)
        .unwrap()
        .replace('<', "\\u003c");
    format!(r#"<script type="application/json" id="data:{name}">{json}</script>"#)
}

fn escape_html_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

pub struct PageOpts<'a> {
    pub dev: bool,
    /// (name, value) pairs beyond the always-present about.json.
    pub embeds: &'a [(String, Value)],
}

pub fn page_html(bundle: &AppBundle, title: &str, opts: &PageOpts) -> String {
    let esc = |s: &str| {
        // Case-insensitive "</script" defusal, like the TS /<\/script/gi.
        let re = regex::Regex::new(r"(?i)</script").unwrap();
        re.replace_all(s, "<\\/script").into_owned()
    };
    let style_esc = |s: &str| {
        let re = regex::Regex::new(r"(?i)</style").unwrap();
        re.replace_all(s, "<\\/style").into_owned()
    };
    let mut data_tags = vec![json_tag("about.json", &bundle.about)];
    for (name, value) in opts.embeds {
        data_tags.push(json_tag(name, value));
    }
    let data_tags = data_tags.join("\n");
    // Dev auto-reload client: an SSE "reload" means the UI bundle was
    // rebuilt; a dropped-then-reestablished connection means the server
    // itself restarted — reload in both cases.
    let dev_script = if opts.dev {
        r#"<script>(() => {
  let wasConnected = false;
  function connect() {
    const es = new EventSource("/dev/events");
    es.onopen = () => { if (wasConnected) location.reload(); wasConnected = true; };
    es.onmessage = (e) => { if (e.data === "reload") location.reload(); };
    es.onerror = () => { es.close(); setTimeout(connect, 400); };
  }
  connect();
})();</script>"#
    } else {
        ""
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
*{{box-sizing:border-box}}
html,body{{margin:0;height:100%}}
html{{font-size:{base_font}rem}}
body{{font-family:system-ui,sans-serif;font-size:var(--text-sm);background:var(--page);color:var(--ink-1)}}
{theme_css}
{css}
</style>
</head>
<body>
<div id="app"></div>
{data_tags}
<script type="module">{js}</script>
{dev_script}
</body>
</html>"#,
        title = escape_html_text(title),
        base_font = bundle.base_font_rem,
        theme_css = bundle.theme_css,
        css = style_esc(&bundle.css),
        data_tags = data_tags,
        js = esc(&bundle.js),
        dev_script = dev_script,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_tag_escapes_script_close() {
        let tag = json_tag("file/x", &json!({"text": "</script><b>"}));
        assert!(!tag[tag.find('>').unwrap()..].contains("</script><b>"));
        assert!(tag.contains("\\u003c/script"));
    }
}
