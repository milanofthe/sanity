//! Inventory of real repositories: how big, how much of it a grammar covers,
//! and how long it takes to read.
//!
//!   cargo run --release -p sanity-core --example scan -- <path>...
//!
//! This is where the numbers that drive decisions come from. It used to also
//! report what an artefact filter dropped; that filter is gone, because a
//! heuristic deciding for you is the wrong shape for the job and the file type
//! picker does it per extension where you can see it. What is left is the part
//! that still answers questions: which extensions carry the lines, and which
//! of them no grammar is looking at.

use std::path::Path;
use std::time::Instant;

use sanity_core::{lang, scan};

fn add(list: &mut Vec<(String, u64)>, key: &str, lines: u64) {
    match list.iter_mut().find(|(k, _)| k == key) {
        Some(e) => e.1 += lines,
        None => list.push((key.to_string(), lines)),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: scan <path>...");
        std::process::exit(2);
    }

    println!(
        "{:<16} {:>6} {:>10} {:>8} {:>9} {:>7} {:>6}",
        "REPO", "FILES", "LINES", "BINARY", "SPANS", "HILIT", "MS"
    );

    for arg in &args {
        let root = Path::new(arg);
        let name = root.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let t0 = Instant::now();

        let listed = match scan::list_files(root) {
            Ok(v) => v,
            Err(e) => {
                println!("{name:<16} error: {e}");
                continue;
            }
        };

        let mut files = 0u32;
        let mut lines = 0u64;
        let mut binary = 0u32;
        let mut spans = 0u64;
        let mut highlighted = 0u64;
        // Lines with no grammar, by extension: the list that decides which
        // one to add next.
        let mut missing: Vec<(String, u64)> = Vec::new();
        let mut by_ext: Vec<(String, u64)> = Vec::new();

        for rel in &listed {
            let Some((data, info)) = scan::read_file(root, rel) else { continue };
            if data.flags & sanity_core::wire::FLAG_BINARY != 0 {
                binary += 1;
                continue;
            }
            files += 1;
            lines += info.line_count as u64;
            spans += data.spans.len() as u64;

            let ext = lang::extension_of(rel)
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_else(|| "(none)".into());
            add(&mut by_ext, &ext, info.line_count as u64);
            if data.flags & sanity_core::wire::FLAG_NO_GRAMMAR != 0 {
                add(&mut missing, &ext, info.line_count as u64);
            } else {
                highlighted += info.line_count as u64;
            }
        }

        let ms = t0.elapsed().as_millis();
        println!(
            "{name:<16} {files:>6} {lines:>10} {binary:>8} {spans:>9} {:>6.0}% {ms:>6}",
            100.0 * highlighted as f64 / lines.max(1) as f64,
        );

        by_ext.sort_by_key(|(_, l)| std::cmp::Reverse(*l));
        let top: Vec<String> =
            by_ext.iter().take(6).map(|(e, l)| format!("{e} {l}")).collect();
        println!("    lines by extension: {}", top.join(", "));

        if !missing.is_empty() {
            missing.sort_by_key(|(_, l)| std::cmp::Reverse(*l));
            let top: Vec<String> =
                missing.iter().take(6).map(|(e, l)| format!("{e} {l}")).collect();
            println!("    no grammar:         {}", top.join(", "));
        }
    }
}
