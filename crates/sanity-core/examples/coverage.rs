//! How much of a file's text actually gets a colour.
//!
//!   cargo run -p sanity-core --example coverage -- <path>...
//!
//! A highlight query that captures nothing compiles, parses and renders: the
//! file simply comes out as plain text, and nothing says so. That is how
//! TypeScript would silently lose every keyword if JavaScript's query were not
//! put in front of its own, and it is what a hand-written query gets wrong
//! first. So the share of non-blank characters that land inside a span is
//! measured per language, over whatever files are given.

use std::collections::BTreeMap;
use std::path::Path;

use sanity_core::filter::Filter;
use sanity_core::lang;
use sanity_core::scan;
use sanity_core::wire::{span_col, span_len, Kind, KIND_COUNT};

/// Minimum share of characters a language is expected to colour.
///
/// Anything not listed has to reach 50 percent. Measured on the 150k lines of
/// `sane`: every code language came out between 75 and 88 percent, so 50 is a
/// floor rather than a target.
const FLOOR: &[(&str, f64)] = &[
    // A web page and a paper are mostly prose, and prose is supposed to stay
    // plain. Measured at 15.2 and 19.2 percent.
    ("html", 0.10),
    ("latex", 0.15),
    // Prose again, though less of it is plain than in a paper: headings,
    // links, code spans and emphasis add up. Measured at 30.2 percent, and at
    // 0.7 percent before the inline grammar was actually reached.
    ("markdown", 0.20),
];

#[derive(Default)]
struct Tally {
    files: usize,
    lines: usize,
    /// Characters on non-blank lines, ignoring leading indentation: indentation
    /// is never captured by anyone and counting it would flatter every result.
    chars: usize,
    covered: usize,
    /// Characters in a span of any kind other than Plain. This is the number
    /// that matters: the builder emits a Plain span wherever no capture
    /// applies, so a query that matches nothing still "covers" every
    /// non-blank character and scores the same as one that works.
    coloured: usize,
    kinds: [usize; KIND_COUNT],
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: coverage <path>...");
        std::process::exit(2);
    }

    let mut by_lang: BTreeMap<&'static str, Tally> = BTreeMap::new();
    let mut skipped = 0usize;

    for arg in &args {
        let root = Path::new(arg);
        let files: Vec<(std::path::PathBuf, String)> = if root.is_dir() {
            let mut filter = Filter::new();
            filter.show_artefacts = false;
            match scan::list_files(root, &filter) {
                Ok(rels) => rels.into_iter().map(|r| (root.to_path_buf(), r)).collect(),
                Err(e) => {
                    eprintln!("{arg}: {e}");
                    continue;
                }
            }
        } else {
            let parent = root.parent().unwrap_or(Path::new(".")).to_path_buf();
            let name = root.file_name().unwrap().to_string_lossy().into_owned();
            vec![(parent, name)]
        };

        for (base, rel) in files {
            let Some(grammar) = lang::extension_of(&rel).and_then(lang::grammar_for_extension) else {
                skipped += 1;
                continue;
            };
            let Ok(bytes) = std::fs::read(base.join(&rel)) else { continue };
            if scan::looks_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            let data = sanity_core::tokenize::tokenize(&text, grammar);

            let t = by_lang.entry(grammar.name).or_default();
            t.files += 1;
            for (i, line) in text.lines().enumerate() {
                if i >= data.line_count() {
                    break;
                }
                let trimmed = line.trim_start();
                if trimmed.is_empty() {
                    continue;
                }
                t.lines += 1;
                t.chars += trimmed.chars().count();
                let from = data.span_start[i] as usize;
                let to = data.span_start[i + 1] as usize;
                for &s in &data.spans[from..to] {
                    // Spans are in display columns and cannot overlap, so their
                    // lengths add up without double counting.
                    let _ = span_col(s);
                    let len = span_len(s) as usize;
                    t.covered += len;
                    let k = sanity_core::wire::span_kind(s) as usize;
                    if k < KIND_COUNT {
                        t.kinds[k] += len;
                        if k != Kind::Plain as usize {
                            t.coloured += len;
                        }
                    }
                }
            }
        }
    }

    println!(
        "{:<12} {:>6} {:>9} {:>9} {:>9}  kinds",
        "language", "files", "lines", "in spans", "coloured"
    );
    let mut worst: Vec<(&str, f64)> = Vec::new();
    for (name, t) in &by_lang {
        let covered = t.covered as f64 / t.chars.max(1) as f64;
        let coloured = t.coloured as f64 / t.chars.max(1) as f64;
        let kinds = t.kinds.iter().filter(|&&c| c > 0).count();
        println!(
            "{:<12} {:>6} {:>9} {:>8.1}% {:>8.1}%  {kinds}/{KIND_COUNT}",
            name, t.files, t.lines, 100.0 * covered, 100.0 * coloured
        );
        worst.push((name, coloured));
    }
    if skipped > 0 {
        println!("\n{skipped} files had no grammar");
    }

    // A language that colours almost nothing is a broken query, not a quiet
    // one. Reported as a failure so this can be run as a check.
    // A language that colours almost nothing has a broken query, and the
    // builder's Plain fallback hides that from the "in spans" column.
    //
    // The floor is per language because prose markup legitimately colours
    // little: a paper or a web page is mostly words, and words are supposed to
    // stay plain. Code languages all measure between 75 and 88 percent.
    println!();
    let mut failed = false;
    for (name, share) in &worst {
        let floor = FLOOR.iter().find(|(n, _)| n == name).map(|(_, f)| *f).unwrap_or(0.5);
        if *share < floor {
            println!(
                "FAIL {name} colours {:.1}% of its characters, under the {:.0}% expected",
                100.0 * share,
                100.0 * floor
            );
            failed = true;
        }
    }
    if failed {
        std::process::exit(1);
    }
    println!("every language colours at least what is expected of it");
}
