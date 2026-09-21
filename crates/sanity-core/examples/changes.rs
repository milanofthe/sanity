//! Print git change state for a repository, one line per changed file.
//!
//! `cargo run -p sanity-core --example changes -- <path> [head|branch]`
//!
//! Exists to check the diff parsing against real repositories, where the
//! shapes that break a parser actually occur: renames, paths with spaces,
//! files without a trailing newline, hunks at line zero.

use std::collections::HashMap;
use std::path::PathBuf;

use sanity_core::filter::Filter;
use sanity_core::git::{self, Baseline};
use sanity_core::scan;
use sanity_core::wire::LineState;

fn main() {
    let mut args = std::env::args().skip(1);
    let root = PathBuf::from(args.next().unwrap_or_else(|| ".".into()));
    let baseline = match args.next().as_deref() {
        Some("branch") => Baseline::MergeBase,
        _ => Baseline::Head,
    };

    if !git::is_repo(&root) {
        println!("{} is not a git work tree", root.display());
        return;
    }

    let started = std::time::Instant::now();
    let filter = Filter::new();
    let listed = scan::list_files(&root, &filter).expect("list");
    let listed_ms = started.elapsed().as_millis();

    let mut counts: HashMap<String, u32> = HashMap::new();
    for rel in &listed {
        if let Some((_, info)) = scan::read_file(&root, rel) {
            counts.insert(rel.clone(), info.line_count);
        }
    }
    let read_ms = started.elapsed().as_millis();

    let changes = git::line_changes(&root, baseline, &counts);
    let git_ms = started.elapsed().as_millis();

    let mut rows: Vec<_> = changes.iter().collect();
    rows.sort_by_key(|(p, _)| p.as_str());

    let mut totals = [0usize; 4];
    let mut shown = 0;
    for (path, c) in &rows {
        let mut per = [0usize; 4];
        for &s in &c.lines {
            if (s as usize) < 4 {
                per[s as usize] += 1;
                totals[s as usize] += 1;
            }
        }
        let touched = per[1] + per[2] + per[3];
        if touched == 0 {
            continue;
        }
        shown += 1;
        if shown <= 40 {
            println!(
                "{:<56} {:>7?} +{:<5} ~{:<5} -{:<4} of {}",
                path,
                c.status,
                per[LineState::Added as usize],
                per[LineState::Modified as usize],
                per[LineState::DeletedBelow as usize],
                c.lines.len()
            );
        }
    }

    println!();
    println!("{} files listed, {shown} with changed lines", listed.len());
    println!(
        "lines: +{} ~{} -{} marked",
        totals[LineState::Added as usize],
        totals[LineState::Modified as usize],
        totals[LineState::DeletedBelow as usize]
    );
    println!("timing: list {listed_ms} ms, read {} ms, git {} ms", read_ms - listed_ms, git_ms - read_ms);

    // The invariant the renderer depends on: a per-line array is exactly as
    // long as the file, or a panel would read past its own data.
    for (path, c) in &rows {
        let want = counts.get(*path).copied().unwrap_or(0) as usize;
        if c.lines.len() != want && want > 0 {
            println!("MISMATCH {path}: {} states for {want} lines", c.lines.len());
        }
    }
}
