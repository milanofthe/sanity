//! How close `scan::estimate` comes to reading a file, and how much faster
//! it is: the numbers behind laying a project out before it has been read.
//!
//!   cargo run --release -p sanity-core --example estimate -- <path>...
//!
//! Measured: sane, 990 text files, 762 exact and nine in ten within 5
//! percent, in 20 ms against 306 to read them; rapidmesh within 4 percent for
//! nine in ten; pathsim's notebooks off the most, since what is shown of a
//! notebook is its cells and not its JSON, which the reading corrects.

use sanity_core::scan;
use std::time::Instant;
fn main() {
    for r in std::env::args().skip(1) {
        let root = std::path::PathBuf::from(&r);
        let files = scan::list_files(&root).unwrap();
        let t0 = Instant::now();
        let est = scan::estimate_all(&root, &files);
        let te = t0.elapsed().as_secs_f64() * 1000.0;
        let t1 = Instant::now();
        let real = scan::read_all(&root, &files);
        let tr = t1.elapsed().as_secs_f64() * 1000.0;
        let (mut exact, mut n, mut binmis) = (0, 0, 0);
        let mut errs: Vec<f64> = Vec::new();
        for (e, r) in est.iter().zip(&real) {
            let (Some(e), Some((d, i))) = (e, r) else { continue };
            let rb = d.flags & 2 != 0 && i.media.is_none();
            if e.binary != rb { binmis += 1; }
            if e.binary || e.media.is_some() || rb { continue; }
            n += 1;
            if e.line_count == i.line_count { exact += 1; }
            errs.push(((e.line_count as f64) / (i.line_count.max(1) as f64)).ln().abs());
        }
        errs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let q = |p: f64| errs[((errs.len() - 1) as f64 * p) as usize].exp();
        println!("{r}: {} files, estimate {te:.0} ms, read {tr:.0} ms | text {n}: exact {exact}, off by factor p50 {:.2} p90 {:.2} max {:.2} | binary mismatches {binmis}", files.len(), q(0.5), q(0.9), q(1.0));
    }
}
