//! Time a content search over a real repository.
//!
//!   cargo run --release -p sanity-core --example find -- <repo> <query>
//!
//! The question this answers: whether a search can read and scan the whole
//! tree on a debounced keystroke, or whether the text has to be held in
//! memory. Reading is the honest option if it is fast enough, since the files
//! change under the tool while it runs.

use std::path::PathBuf;
use std::time::Instant;

use sanity_core::{find, scan};

fn main() {
    let mut args = std::env::args().skip(1);
    let repo = args.next().unwrap_or_else(|| ".".into());
    let root = PathBuf::from(&repo);
    let queries: Vec<String> = args.collect();
    let queries = if queries.is_empty() {
        vec!["fn ".into(), "TODO".into(), "renderer".into(), "self".into()]
    } else {
        queries
    };

    let t0 = Instant::now();
    let paths = scan::list_files(&root).expect("list files");
    println!("{} paths listed in {} ms", paths.len(), t0.elapsed().as_millis());

    let mut bytes = 0u64;
    for rel in &paths {
        bytes += std::fs::metadata(root.join(rel)).map(|m| m.len()).unwrap_or(0);
    }
    println!("{:.1} MB of files", bytes as f64 / 1e6);

    for q in &queries {
        // Twice: the first pass pays for whatever the page cache does not have,
        // and a search while the tool is open is always the second kind.
        for pass in 0..2 {
            let t = Instant::now();
            let hits = find::find_in_files(&root, &paths, q, 64);
            let total: usize = hits.iter().map(|f| f.hits.len()).sum();
            let ms = t.elapsed().as_secs_f64() * 1e3;
            if pass == 1 {
                println!(
                    "{:>10}  {:>6} hits in {:>4} files  {:>6.1} ms",
                    format!("\"{q}\""),
                    total,
                    hits.len(),
                    ms
                );
            }
        }
    }
}
