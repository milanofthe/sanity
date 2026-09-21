//! Print a file's spans next to its text, so highlighting can be eyeballed.
//!
//!   cargo run -p sanity-core --example spans -- <file> [from] [count]

use sanity_core::wire::{span_col, span_kind, span_len, Kind};

fn kind_name(k: u8) -> &'static str {
    match k {
        x if x == Kind::Plain as u8 => "plain",
        x if x == Kind::Keyword as u8 => "keyword",
        x if x == Kind::Type as u8 => "type",
        x if x == Kind::Function as u8 => "func",
        x if x == Kind::String as u8 => "string",
        x if x == Kind::Number as u8 => "number",
        x if x == Kind::Comment as u8 => "comment",
        x if x == Kind::DocComment as u8 => "doc",
        x if x == Kind::Variable as u8 => "var",
        x if x == Kind::Punctuation as u8 => "punct",
        x if x == Kind::Constant as u8 => "const",
        x if x == Kind::Attribute as u8 => "attr",
        _ => "?",
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: spans <file> [from] [count]");
    let from: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(0);
    let count: usize = args.next().and_then(|v| v.parse().ok()).unwrap_or(20);

    let p = std::path::Path::new(&path);
    let (data, _) = sanity_core::scan::read_file(
        p.parent().unwrap_or(std::path::Path::new(".")),
        &p.file_name().unwrap().to_string_lossy(),
    )
    .expect("read");
    let text = std::fs::read_to_string(&path).expect("read text");

    for (i, line) in text.lines().enumerate().skip(from).take(count) {
        if i + 1 >= data.span_start.len() {
            break;
        }
        let a = data.span_start[i] as usize;
        let b = data.span_start[i + 1] as usize;
        let spans: Vec<String> = data.spans[a..b]
            .iter()
            .map(|&s| {
                let c = span_col(s) as usize;
                let l = span_len(s) as usize;
                // The text the span actually covers, so a span sitting one
                // column off the word is visible rather than plausible.
                let shown: String = line.chars().skip(c).take(l).collect();
                format!("{}:{:?}", kind_name(span_kind(s)), shown)
            })
            .collect();
        println!("{:>5} | {}", i + 1, spans.join(" "));
    }
}
