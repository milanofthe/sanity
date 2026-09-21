//! Scan real repositories and report what the filter did.
//!
//!   cargo run --release -p sanity-core --example scan -- <path>...
//!
//! Exists so the filter's effect on actual projects is measured rather than
//! assumed; the numbers it prints are what decided the rules in filter.rs.

use std::path::Path;
use std::time::Instant;

use sanity_core::filter::{Filter, Verdict};
use sanity_core::scan;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: scan <path>...");
        std::process::exit(2);
    }

    println!(
        "{:<16} {:>6} {:>10} {:>6} {:>10} {:>7} {:>8}",
        "REPO", "FILES", "LINES", "DROP", "DROPLINES", "SPANS", "MS"
    );

    for arg in &args {
        let root = Path::new(arg);
        let name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let t0 = Instant::now();

        // Everything git does not ignore, before the artefact filter.
        let mut all = Filter::new();
        all.show_artefacts = true;
        let listed = match scan::list_files(root, &all) {
            Ok(v) => v,
            Err(e) => {
                println!("{name:<16} error: {e}");
                continue;
            }
        };

        let mut filter = Filter::new();
        filter.load_gitattributes(root, &listed);

        let mut kept = 0u32;
        let mut kept_lines = 0u64;
        let mut dropped = 0u32;
        let mut dropped_lines = 0u64;
        let mut spans = 0u64;
        let mut reasons: Vec<(String, u64)> = Vec::new();
        // Kept lines per extension: this is the diagnostic that matters,
        // because an artefact the filter misses shows up here as an extension
        // nobody would call source.
        let mut by_ext: Vec<(String, u64)> = Vec::new();

        for rel in &listed {
            let Some((data, info)) = scan::read_file(root, rel) else { continue };
            if data.flags & sanity_core::wire::FLAG_BINARY != 0 {
                continue;
            }
            match filter.classify_sized(rel, info.line_count) {
                Verdict::Keep => {
                    kept += 1;
                    kept_lines += info.line_count as u64;
                    spans += data.spans.len() as u64;
                    let ext = rel.rsplit_once('.').map(|(_, e)| e).unwrap_or("(none)").to_string();
                    match by_ext.iter_mut().find(|(n, _)| *n == ext) {
                        Some((_, c)) => *c += info.line_count as u64,
                        None => by_ext.push((ext, info.line_count as u64)),
                    }
                }
                Verdict::Artefact(r) => {
                    dropped += 1;
                    dropped_lines += info.line_count as u64;
                    match reasons.iter_mut().find(|(n, _)| n == r.as_str()) {
                        Some((_, c)) => *c += info.line_count as u64,
                        None => reasons.push((r.as_str().to_string(), info.line_count as u64)),
                    }
                }
            }
        }

        println!(
            "{name:<16} {kept:>6} {kept_lines:>10} {dropped:>6} {dropped_lines:>10} {spans:>7} {:>8}",
            t0.elapsed().as_millis()
        );
        reasons.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        for (reason, lines) in reasons.iter().take(3) {
            println!("{:<16} {:>6} {lines:>10}  dropped: {reason}", "", "");
        }
        by_ext.sort_by_key(|(_, c)| std::cmp::Reverse(*c));
        let top: Vec<String> =
            by_ext.iter().take(5).map(|(e, c)| format!("{e} {c}")).collect();
        println!("{:<16} {:>6} {:>10}  kept: {}", "", "", "", top.join(", "));
    }
}
