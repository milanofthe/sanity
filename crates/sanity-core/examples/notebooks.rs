//! What reading a notebook as its cells does to the numbers.
//!
//! Run with: cargo run --release -p sanity-core --example notebooks -- <repo>

use sanity_core::{notebook, scan};

fn main() {
    let root = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let root = std::path::PathBuf::from(root);
    let files = scan::list_files(&root).expect("list files");

    let mut n = 0;
    let mut raw_lines = 0usize;
    let mut cell_lines = 0usize;
    let mut worst = (0usize, String::new());
    for rel in files.iter().filter(|f| notebook::is_notebook(f)) {
        let Ok(bytes) = std::fs::read(root.join(rel)) else { continue };
        let raw = String::from_utf8_lossy(&bytes);
        let Some(nb) = notebook::parse(&raw) else { continue };
        n += 1;
        let before = raw.lines().count();
        let after = nb.source.lines().count();
        raw_lines += before;
        cell_lines += after;
        let longest = raw.lines().map(str::len).max().unwrap_or(0);
        if longest > worst.0 {
            worst = (longest, rel.clone());
        }
        let outputs = nb.kinds.iter().filter(|k| **k == notebook::LineKind::Output).count();
        println!(
            "{rel}: {before} lines of json -> {after} lines of notebook ({outputs} output), \
             longest json line {longest}"
        );
    }
    println!(
        "\n{n} notebooks: {raw_lines} lines as json, {cell_lines} as cells; \
         longest single line was {} in {}",
        worst.0, worst.1
    );
}
