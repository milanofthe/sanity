//! Dump a real scan to disk so the browser can render it.
//!
//!   cargo run --release -p sanity-core --example dump -- <repo> <outdir> [head|branch]
//!
//! Exists to close a verification gap: the Tauri window cannot be captured
//! without screen recording permission, so without this there is no way to
//! check what real code looks like on the canvas. The output is exactly the
//! shape the Tauri commands return, so the frontend path being exercised is
//! the same one that ships.

use std::path::PathBuf;

use std::collections::HashMap;

use sanity_core::filter::{Filter, Verdict};
use sanity_core::git::{self, Baseline};
use sanity_core::lang::extension_of;
use sanity_core::scan;
use sanity_core::wire::{encode, FileData, FLAG_BINARY};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(repo), Some(outdir)) = (args.next(), args.next()) else {
        eprintln!("usage: dump <repo> <outdir>");
        std::process::exit(2);
    };
    let baseline = match args.next().as_deref() {
        Some("branch") => Baseline::MergeBase,
        _ => Baseline::Head,
    };
    let root = PathBuf::from(&repo);
    let out = PathBuf::from(&outdir);
    std::fs::create_dir_all(&out).expect("create outdir");

    let mut all = Filter::new();
    all.show_artefacts = true;
    let listed = scan::list_files(&root, &all).expect("list files");
    let mut filter = Filter::new();
    filter.load_gitattributes(&root, &listed);

    let mut files = Vec::new();
    let mut groups: Vec<(String, u32, u32, Option<String>)> = Vec::new();
    let mut texts: Vec<(String, String)> = Vec::new();
    // Payloads are held undecoded until the change state has been stamped in,
    // because the state is part of the payload and git answers for the whole
    // repository at once.
    let mut decoded: Vec<(String, FileData)> = Vec::new();
    let mut line_counts: HashMap<String, u32> = HashMap::new();

    for rel in &listed {
        let Some((data, info)) = scan::read_file(&root, rel) else { continue };
        if data.flags & FLAG_BINARY != 0 {
            continue;
        }
        let artefact = match filter.classify_sized(rel, info.line_count) {
            Verdict::Keep => None,
            Verdict::Artefact(r) => Some(r.as_str().to_string()),
        };

        let ext = extension_of(rel).unwrap_or("(none)").to_ascii_lowercase();
        match groups.iter_mut().find(|(e, _, _, _)| *e == ext) {
            Some(g) => {
                g.1 += 1;
                g.2 += info.line_count;
                if g.3.is_none() {
                    g.3 = artefact.clone();
                }
            }
            None => groups.push((ext, 1, info.line_count, artefact.clone())),
        }

        let cols = percentile(&data.line_cols, 0.9);
        files.push(format!(
            r#"{{"path":{},"lineCount":{},"maxCols":{},"clipCols":{}{}}}"#,
            json_string(rel),
            info.line_count,
            cols,
            info.max_cols,
            artefact
                .as_ref()
                .map(|a| format!(r#","artefact":{}"#, json_string(a)))
                .unwrap_or_default(),
        ));
        line_counts.insert(rel.clone(), info.line_count);
        decoded.push((rel.clone(), data));
        // Text for the readable zoom level. Only for files small enough to be
        // worth reading; the dump is a development artefact, not a cache.
        if info.line_count < 4000 {
            if let Ok(t) = std::fs::read(root.join(rel)) {
                texts.push((rel.clone(), String::from_utf8_lossy(&t).into_owned()));
            }
        }
    }

    // Stamp in the change state, exactly as scan_repo does, so the fixture
    // shows what the app shows rather than a repository with no history.
    let mut changed = 0u32;
    if git::is_repo(&root) {
        let changes = git::line_changes(&root, baseline, &line_counts);
        for (rel, data) in decoded.iter_mut() {
            let n = data.line_count();
            if let Some(c) = changes.get(rel) {
                if c.lines.iter().any(|&x| x != 0) {
                    data.line_state.clear();
                    data.line_state.extend_from_slice(&c.lines[..c.lines.len().min(n)]);
                    data.line_state.resize(n, 0);
                    changed += 1;
                }
            }
        }
    }
    let payloads: Vec<(String, Vec<u8>)> =
        decoded.iter().map(|(rel, d)| (rel.clone(), encode(d))).collect();

    groups.sort_by_key(|g| std::cmp::Reverse(g.2));
    let groups_json: Vec<String> = groups
        .iter()
        .map(|(id, f, l, a)| {
            format!(
                r#"{{"id":{},"files":{f},"lines":{l}{}}}"#,
                json_string(id),
                a.as_ref()
                    .map(|x| format!(r#","artefact":{}"#, json_string(x)))
                    .unwrap_or_default(),
            )
        })
        .collect();

    let scan_json = format!(
        r#"{{"root":{},"files":[{}],"groups":[{}],"binary":0,"changed":{changed},"baseline":{},"elapsedMs":0}}"#,
        json_string(&root.to_string_lossy()),
        files.join(","),
        groups_json.join(","),
        json_string(match baseline {
            Baseline::Head => "head",
            Baseline::MergeBase => "branch",
        }),
    );
    std::fs::write(out.join("scan.json"), scan_json).expect("write scan.json");
    std::fs::write(out.join("payloads.bin"), pack(&payloads)).expect("write payloads.bin");

    let texts_json: Vec<String> = texts
        .iter()
        .map(|(p, t)| format!("{}:{}", json_string(p), json_string(t)))
        .collect();
    std::fs::write(out.join("texts.json"), format!("{{{}}}", texts_json.join(",")))
        .expect("write texts.json");

    println!(
        "dumped {} files ({changed} changed), {} payload bytes, {} texts to {}",
        payloads.len(),
        payloads.iter().map(|(_, b)| b.len()).sum::<usize>(),
        texts.len(),
        out.display()
    );
}

/// Same layout as `pack_payloads` in src-tauri.
fn pack(payloads: &[(String, Vec<u8>)]) -> Vec<u8> {
    let index: Vec<String> = payloads
        .iter()
        .map(|(p, b)| format!("[{},{}]", json_string(p), b.len()))
        .collect();
    let header = format!("[{}]", index.join(",")).into_bytes();
    let mut out = Vec::new();
    out.extend_from_slice(&(header.len() as u32).to_le_bytes());
    out.extend_from_slice(&(payloads.len() as u32).to_le_bytes());
    out.extend_from_slice(&header);
    for (_, b) in payloads {
        out.extend_from_slice(b);
    }
    out
}

fn percentile(cols: &[u16], p: f64) -> u32 {
    let mut v: Vec<u16> = cols.iter().copied().filter(|&c| c > 0).collect();
    if v.is_empty() {
        return 1;
    }
    v.sort_unstable();
    v[(((v.len() - 1) as f64) * p).floor() as usize].max(1) as u32
}

/// Minimal JSON string escaping; serde_json is not a dependency of the core.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

