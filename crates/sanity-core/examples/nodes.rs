//! Parse a file with a named grammar and report what the tree looks like.
//!
//!   cargo run -p sanity-core --example nodes -- <grammar> <file> [depth]
//!
//! Exists because a highlight query has to be written against the node names a
//! grammar actually produces, and a grammar that ships no query usually ships
//! no list of them either. Also reports the share of the file that landed
//! inside an ERROR or MISSING node, which is the only honest answer to whether
//! a grammar fits a dialect it was not written for.

use std::collections::BTreeMap;

use tree_sitter::{Language, Parser};

/// Any grammar in the registry, by its registry name or by an extension.
fn grammar(name: &str) -> Option<Language> {
    let g = sanity_core::lang::grammar_for_name(name)
        .or_else(|| sanity_core::lang::grammar_for_extension(name))?;
    Some(g.config.language.clone())
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(name), Some(path)) = (args.next(), args.next()) else {
        eprintln!("usage: nodes <grammar> <file> [depth]");
        std::process::exit(2);
    };
    let show_depth: usize = args.next().and_then(|d| d.parse().ok()).unwrap_or(0);

    let Some(language) = grammar(&name) else {
        eprintln!("unknown grammar: {name}");
        std::process::exit(2);
    };

    let text = std::fs::read_to_string(&path).expect("read");
    let mut parser = Parser::new();
    parser.set_language(&language).expect("set language");
    let started = std::time::Instant::now();
    let tree = parser.parse(&text, None).expect("parse");
    let ms = started.elapsed().as_millis();

    // Bytes covered by an error, counting each error region once: errors nest,
    // and summing every node would report more than the file is long.
    let mut error_bytes = 0usize;
    let mut errors = 0usize;
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();

    let mut cursor = tree.walk();
    let mut stack = vec![(tree.root_node(), 0usize)];
    let mut skip_until = 0usize;
    while let Some((node, depth)) = stack.pop() {
        *kinds.entry(node.kind()).or_default() += 1;
        if (node.is_error() || node.is_missing()) && node.start_byte() >= skip_until {
            errors += 1;
            error_bytes += node.end_byte() - node.start_byte();
            skip_until = node.end_byte();
        }
        if depth <= show_depth {
            println!(
                "{:indent$}{} [{}..{}]",
                "",
                node.kind(),
                node.start_position().row + 1,
                node.end_position().row + 1,
                indent = depth * 2
            );
        }
        for child in node.children(&mut cursor) {
            stack.push((child, depth + 1));
        }
    }

    println!();
    println!("{path}: {} bytes, {} lines, parsed in {ms} ms", text.len(), text.lines().count());
    println!(
        "{errors} error regions covering {error_bytes} bytes ({:.1}% of the file)",
        100.0 * error_bytes as f64 / text.len().max(1) as f64
    );
    println!("{} distinct node kinds, most common:", kinds.len());
    let mut by_count: Vec<_> = kinds.iter().collect();
    by_count.sort_by_key(|(_, c)| std::cmp::Reverse(**c));
    for (kind, count) in by_count.iter().take(200) {
        println!("  {count:>7}  {kind}");
    }
}
