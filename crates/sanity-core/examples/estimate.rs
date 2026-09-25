//! How close `scan::estimate` comes to reading a file, and how much faster
//! it is: the numbers behind laying a project out before it has been read.
//!
//!   cargo run --release -p sanity-core --example estimate -- <path>...
//!
//! Measured over sane, rapidmesh, pathsim and fastsim: nine files in ten
//! within 3 percent, three in four exact, in 8 to 24 ms against 43 to 832 to
//! read them. The worst are files whose lines differ wildly in length, such
//! as a minified bundle whose first line is most of it; reading corrects
//! them.

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
