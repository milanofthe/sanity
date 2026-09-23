//! Dump a real scan to disk so the browser can render it.
//!
//!   cargo run --release -p sanity-core --example dump -- <repo> <outdir>
//!
//! Exists to close a verification gap: the Tauri window cannot be captured
//! without screen recording permission, so without this there is no way to
//! check what real code looks like on the canvas. The output is exactly the
//! shape the Tauri commands return, so the frontend path being exercised is
//! the same one that ships.

use std::path::PathBuf;

/// Largest picture the dump carries. The demo is served over the network and
/// a single 30 megabyte render is not worth the wait; the panel falls back to
/// its placeholder.
const MAX_MEDIA_BYTES: u64 = 8 * 1024 * 1024;

/// A document's pages as the demo carries them: the first as large as its
/// panel is ever drawn at the overview, the rest smaller, since an expanded
/// document shows many of them at once, and no more than forty of them, so a
/// long report does not become most of the demo's download.
const FIRST_PAGE_WIDTH: u32 = 1000;
const PAGE_WIDTH: u32 = 700;
const MAX_PAGES: usize = 40;

use std::collections::HashMap;

use sanity_core::lang::extension_of;
use sanity_core::scan;
use sanity_core::wire::{encode, FileData, FLAG_BINARY};

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(repo), Some(outdir)) = (args.next(), args.next()) else {
        eprintln!("usage: dump <repo> <outdir>");
        std::process::exit(2);
    };
    let root = PathBuf::from(&repo);
    let out = PathBuf::from(&outdir);
    std::fs::create_dir_all(&out).expect("create outdir");

    let listed = scan::list_files(&root).expect("list files");

    let mut files = Vec::new();
    // Extension, files, lines, and the language its files are read under.
    let mut groups: Vec<(String, u32, u32, u32)> = Vec::new();
    let mut texts: Vec<(String, String)> = Vec::new();
    // Payloads are held undecoded until the change state has been stamped in,
    // because the state is part of the payload and git answers for the whole
    // repository at once.
    let mut decoded: Vec<(String, FileData)> = Vec::new();
    let mut line_counts: HashMap<String, u32> = HashMap::new();
    let mut media_files = 0u32;
    let mut media_bytes = 0u64;
    let mut page_files = 0u32;
    let mut page_bytes = 0u64;
    let mut thumb_files = 0u32;
    let mut thumb_bytes = 0u64;
    // Every thumbnail, to be written as one file. The app gets these from the
    // `thumbs` command in batches; the demo has no backend to ask, and a
    // hundred and sixteen separate requests is most of the time it takes to
    // fill a canvas of pictures. One file, one request, same bytes.
    let mut thumbs: Vec<(String, Vec<u8>)> = Vec::new();

    for rel in &listed {
        let Some((data, info)) = scan::read_file(&root, rel) else { continue };
        // A picture is listed with what its header says; anything else binary
        // is left out, the same rule the app's own scan uses.
        if data.flags & FLAG_BINARY != 0 && info.media.is_none() {
            continue;
        }
        let ext = extension_of(rel).unwrap_or("(none)").to_ascii_lowercase();
        match groups.iter_mut().find(|(e, _, _, _)| *e == ext) {
            Some(g) => {
                g.1 += 1;
                g.2 += info.line_count;
                if g.3 == 0 {
                    g.3 = data.lang_id;
                }
            }
            None => groups.push((ext, 1, info.line_count, data.lang_id)),
        }

        let cols = percentile(&data.line_cols, 0.9);
        let media = match info.media {
            Some(sanity_core::media::Media::Image { w, h }) => {
                format!(r#","media":{{"kind":"image","w":{w},"h":{h},"pages":0}}"#)
            }
            Some(sanity_core::media::Media::Document { pages, w, h }) => {
                format!(r#","media":{{"kind":"document","w":{w},"h":{h},"pages":{pages}}}"#)
            }
            None => String::new(),
        };
        files.push(format!(
            r#"{{"path":{},"lineCount":{},"maxCols":{},"clipCols":{}{}}}"#,
            json_string(rel),
            info.line_count,
            cols,
            info.max_cols,
            media,
        ));
        line_counts.insert(rel.clone(), info.line_count);
        decoded.push((rel.clone(), data));
        // Text for the readable zoom level. Only for files small enough to be
        // worth reading; the dump is a development artefact, not a cache.
        if info.line_count < 4000 && info.media.is_none() {
            if let Ok(t) = std::fs::read(root.join(rel)) {
                texts.push((rel.clone(), scan::display_text(rel, &t)));
            }
        }
        // A picture is copied in as it is, under media/, so the browser can
        // fetch it and decode it at whatever resolution the zoom needs, and a
        // thumbnail goes next to it under thumbs/. The app makes those on the
        // fly through the `thumbs` command; the web demo has no backend to ask,
        // so its thumbnails are baked here and the frontend path is the same.
        if info.media.is_some() && info.byte_len <= MAX_MEDIA_BYTES {
            let dst = out.join("media").join(rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            // A document as its pages, rendered by the same code the app
            // renders them with, next to its own name: `.png` for the first,
            // `.p<n>.png` for the rest. The browser has no PDF renderer, and
            // the file itself is never fetched, so it is not copied.
            if let Some(sanity_core::media::Media::Document { .. }) = info.media {
                if let Ok(bytes) = std::fs::read(root.join(rel)) {
                    let pages = sanity_core::pdf::page_count(&bytes).unwrap_or(0).min(MAX_PAGES);
                    for page in 0..pages {
                        let width = if page == 0 { FIRST_PAGE_WIDTH } else { PAGE_WIDTH };
                        let Ok((rgba, w, h)) = sanity_core::pdf::render_rgba(&bytes, page, width) else { continue };
                        let Some(png) = sanity_core::thumb::encode_png_small(&rgba, w, h) else { continue };
                        let name = if page == 0 { format!("{rel}.png") } else { format!("{rel}.p{page}.png") };
                        if std::fs::write(out.join("media").join(name), &png).is_ok() {
                            page_files += 1;
                            page_bytes += png.len() as u64;
                        }
                    }
                }
            } else if std::fs::copy(root.join(rel), &dst).is_ok() {
                media_files += 1;
                media_bytes += info.byte_len;
            }
            if matches!(info.media, Some(sanity_core::media::Media::Image { .. })) {
                if let Ok(bytes) = std::fs::read(root.join(rel)) {
                    if let Some(small) =
                        sanity_core::thumb::thumbnail(&bytes, sanity_core::thumb::THUMB_MAX)
                    {
                        thumb_files += 1;
                        thumb_bytes += small.len() as u64;
                        thumbs.push((rel.to_string(), small));
                    }
                }
            }
        }
    }

    let payloads: Vec<(String, Vec<u8>)> =
        decoded.iter().map(|(rel, d)| (rel.clone(), encode(d))).collect();

    groups.sort_by_key(|g| std::cmp::Reverse(g.2));
    let groups_json: Vec<String> = groups
        .iter()
        // The language goes with the group, so the demo's picker colours a
        // file type the way the app's does.
        .map(|(id, f, l, lang)| {
            format!(r#"{{"id":{},"files":{f},"lines":{l},"lang":{lang}}}"#, json_string(id))
        })
        .collect();

    let scan_json = format!(
        r#"{{"root":{},"files":[{}],"groups":[{}],"binary":0,"elapsedMs":0}}"#,
        json_string(&root.to_string_lossy()),
        files.join(","),
        groups_json.join(","),
    );
    std::fs::write(out.join("scan.json"), scan_json).expect("write scan.json");
    std::fs::write(out.join("payloads.bin"), pack(&payloads)).expect("write payloads.bin");
    // The same container as the payloads, so the frontend has one parser for
    // both. Empty when a repository has no pictures, which is a valid file.
    std::fs::write(out.join("thumbs.bin"), pack(&thumbs)).expect("write thumbs.bin");

    let texts_json: Vec<String> = texts
        .iter()
        .map(|(p, t)| format!("{}:{}", json_string(p), json_string(t)))
        .collect();
    std::fs::write(out.join("texts.json"), format!("{{{}}}", texts_json.join(",")))
        .expect("write texts.json");

    println!(
        "dumped {} files, {} payload bytes, {} texts, {media_files} pictures ({} KB), \
         {page_files} document pages ({} KB), {thumb_files} thumbnails ({} KB) to {}",
        payloads.len(),
        payloads.iter().map(|(_, b)| b.len()).sum::<usize>(),
        texts.len(),
        media_bytes / 1024,
        page_bytes / 1024,
        thumb_bytes / 1024,
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

