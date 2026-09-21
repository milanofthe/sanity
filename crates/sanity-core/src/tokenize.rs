//! Turning source text into the per-line span format.
//!
//! The output is deliberately coarse: one span per run of non-whitespace
//! characters sharing a highlight, clipped per line. That is what the overview
//! textures and the token level of detail draw, and it is a fraction of the
//! size of a real token stream: around 30 bytes per line, so a 200 thousand
//! line repository is a few megabytes and can be held whole.
//!
//! Whitespace never becomes a span. That matters more than it sounds: the
//! overview texture's alpha channel is ink coverage, so indentation and the
//! ragged right edge of code are what give a zoomed-out file its shape. Spans
//! covering the gaps would fill it in and every file would look the same.

use tree_sitter_highlight::{HighlightEvent, Highlighter};

use crate::lang::{kind_for_highlight, Grammar};
use crate::scan::TAB_WIDTH;
use crate::wire::{pack_span, FileData, Kind, LineState, FLAG_TRUNCATED, MAX_COLS, MAX_SPAN_LEN};

/// Accumulates spans and line metrics while walking the source.
struct Builder {
    f: FileData,
    /// Visual column of the next character.
    col: u32,
    /// Column of the first non-whitespace character on this line.
    indent: Option<u32>,
    /// Open run: start column and kind.
    run: Option<(u32, Kind)>,
    truncated: bool,
    /// Whether anything at all has been seen since the last newline; drives
    /// the same line counting as `str::lines`.
    line_open: bool,
}

impl Builder {
    fn new(capacity_hint: usize) -> Self {
        let mut f = FileData::default();
        let lines = capacity_hint / 32 + 1;
        f.span_start.reserve(lines);
        f.line_cols.reserve(lines);
        f.line_indent.reserve(lines);
        f.line_state.reserve(lines);
        f.spans.reserve(lines * 4);
        Self { f, col: 0, indent: None, run: None, truncated: false, line_open: false }
    }

    fn begin_line(&mut self) {
        self.f.span_start.push(self.f.spans.len() as u32);
        self.line_open = true;
    }

    fn close_run(&mut self) {
        let Some((start, kind)) = self.run.take() else { return };
        let end = self.col.min(MAX_COLS);
        if end <= start {
            return;
        }
        // A run longer than a span can encode is split rather than clipped, so
        // the total coverage stays honest.
        let mut at = start;
        while at < end {
            let len = (end - at).min(MAX_SPAN_LEN);
            self.f.spans.push(pack_span(at, len, kind));
            at += len;
        }
    }

    fn end_line(&mut self) {
        self.close_run();
        let cols = self.col.min(MAX_COLS);
        if self.col > MAX_COLS {
            self.truncated = true;
        }
        self.f.line_cols.push(cols as u16);
        self.f.line_indent.push(self.indent.unwrap_or(0).min(u8::MAX as u32) as u8);
        self.f.line_state.push(LineState::Unchanged as u8);
        self.col = 0;
        self.indent = None;
        self.line_open = false;
    }

    fn push_char(&mut self, ch: char, kind: Kind) {
        if !self.line_open {
            self.begin_line();
        }
        match ch {
            '\n' => self.end_line(),
            '\r' => {}
            '\t' => {
                self.close_run();
                self.col += TAB_WIDTH - (self.col % TAB_WIDTH);
            }
            ' ' => {
                self.close_run();
                self.col += 1;
            }
            _ => {
                if self.indent.is_none() {
                    self.indent = Some(self.col);
                }
                match self.run {
                    Some((_, k)) if k == kind => {}
                    _ => {
                        self.close_run();
                        self.run = Some((self.col, kind));
                    }
                }
                self.col += 1;
            }
        }
    }

    fn finish(mut self, lang_id: u32, flags: u32) -> FileData {
        // A file not ending in a newline still has that last line, matching
        // how `str::lines` counts.
        if self.line_open {
            self.end_line();
        }
        self.f.span_start.push(self.f.spans.len() as u32);
        self.f.lang_id = lang_id;
        self.f.flags = flags | if self.truncated { FLAG_TRUNCATED } else { 0 };
        self.f
    }
}

/// Tokenise with a grammar. Falls back to `Plain` spans on a parse failure,
/// which happens on genuinely broken source and should still render.
pub fn tokenize(text: &str, grammar: &Grammar) -> FileData {
    let mut builder = Builder::new(text.len());
    let mut highlighter = Highlighter::new();

    // Arguments after the source are the text encoding (None for UTF-8), a
    // cancellation flag, and the injection callback. Injections are declined:
    // a fenced code block inside Markdown highlighted as its own language
    // would be nice, and needs its own grammar lookup to do properly.
    let events = match highlighter.highlight(
        &grammar.config,
        text.as_bytes(),
        None,
        None,
        |_| None,
    ) {
        Ok(e) => e,
        Err(_) => return crate::scan::plain_file_data(text),
    };

    // Highlights nest, so the innermost open one wins; a stack is the only way
    // to know what applies when one ends.
    let mut stack: Vec<Kind> = Vec::with_capacity(8);
    for event in events {
        match event {
            Ok(HighlightEvent::HighlightStart(h)) => stack.push(kind_for_highlight(h.0)),
            Ok(HighlightEvent::HighlightEnd) => {
                stack.pop();
            }
            Ok(HighlightEvent::Source { start, end }) => {
                let kind = stack.last().copied().unwrap_or(Kind::Plain);
                let Some(slice) = text.get(start..end) else { continue };
                for ch in slice.chars() {
                    builder.push_char(ch, kind);
                }
            }
            Err(_) => return crate::scan::plain_file_data(text),
        }
    }

    builder.finish(grammar.id, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lang::grammar_for_extension;
    use crate::wire::{span_col, span_kind, span_len};

    fn kinds_on_line(f: &FileData, line: usize) -> Vec<u8> {
        let s = f.span_start[line] as usize;
        let e = f.span_start[line + 1] as usize;
        f.spans[s..e].iter().map(|&x| span_kind(x)).collect()
    }

    #[test]
    fn rust_gets_keywords_strings_and_comments() {
        let g = grammar_for_extension("rs").unwrap();
        let src = "// a note\nfn main() {\n    let s = \"hi\";\n}\n";
        let f = tokenize(src, g);
        f.validate().unwrap();
        assert_eq!(f.line_count(), 4);
        assert_eq!(f.lang_id, g.id);

        assert!(kinds_on_line(&f, 0).contains(&(Kind::Comment as u8)), "comment on line 0");
        assert!(kinds_on_line(&f, 1).contains(&(Kind::Keyword as u8)), "fn is a keyword");
        let line2 = kinds_on_line(&f, 2);
        assert!(line2.contains(&(Kind::Keyword as u8)), "let is a keyword");
        assert!(line2.contains(&(Kind::String as u8)), "string literal");
    }

    #[test]
    fn python_and_typescript_produce_highlights() {
        for (ext, src, want) in [
            ("py", "def f(x):\n    return \"s\"\n", Kind::Keyword),
            ("ts", "const x: number = 1;\n", Kind::Keyword),
            ("json", "{\"a\": 1}\n", Kind::String),
        ] {
            let g = grammar_for_extension(ext).unwrap();
            let f = tokenize(src, g);
            f.validate().unwrap();
            let all: Vec<u8> = f.spans.iter().map(|&x| span_kind(x)).collect();
            assert!(all.contains(&(want as u8)), "{ext}: expected kind {want:?} in {all:?}");
            // And something must be more specific than Plain overall.
            assert!(all.iter().any(|&k| k != Kind::Plain as u8), "{ext}: nothing highlighted");
        }
    }

    #[test]
    fn line_counting_matches_the_plain_scanner() {
        let g = grammar_for_extension("rs").unwrap();
        // Trailing newline, no trailing newline, blank lines, CRLF.
        for src in [
            "fn a() {}\n",
            "fn a() {}",
            "\n\nfn a() {}\n\n",
            "fn a() {}\r\nfn b() {}\r\n",
            "",
        ] {
            let tok = tokenize(src, g);
            let plain = crate::scan::plain_file_data(src);
            tok.validate().unwrap();
            assert_eq!(
                tok.line_count(),
                plain.line_count(),
                "line count differs for {src:?}"
            );
            assert_eq!(
                tok.line_cols, plain.line_cols,
                "column widths differ for {src:?}"
            );
            assert_eq!(tok.line_indent, plain.line_indent, "indents differ for {src:?}");
        }
    }

    #[test]
    fn whitespace_never_becomes_a_span() {
        let g = grammar_for_extension("rs").unwrap();
        let f = tokenize("    let    x   =  1;\n", g);
        // Every span must start on a non-space character.
        let chars: Vec<char> = "    let    x   =  1;".chars().collect();
        for &s in &f.spans {
            let col = span_col(s) as usize;
            assert_ne!(chars[col], ' ', "span starts on a space at column {col}");
            // And must not run through one.
            let len = span_len(s) as usize;
            for (offset, ch) in chars[col..col + len].iter().enumerate() {
                assert_ne!(*ch, ' ', "span covers a space at column {}", col + offset);
            }
        }
    }

    #[test]
    fn indentation_is_preserved_for_the_overview() {
        let g = grammar_for_extension("py").unwrap();
        let f = tokenize("def f():\n    if x:\n        return 1\n", g);
        assert_eq!(f.line_indent.as_slice(), &[0, 4, 8]);
    }

    #[test]
    fn a_long_line_is_split_and_flagged() {
        let g = grammar_for_extension("rs").unwrap();
        let src = format!("const S: &str = \"{}\";\n", "x".repeat(MAX_COLS as usize + 200));
        let f = tokenize(&src, g);
        f.validate().unwrap();
        assert!(f.flags & FLAG_TRUNCATED != 0);
        assert_eq!(f.line_cols[0] as u32, MAX_COLS);
        assert!(f.spans.iter().all(|&s| span_len(s) <= MAX_SPAN_LEN));
    }

    #[test]
    fn broken_source_still_tokenises() {
        let g = grammar_for_extension("rs").unwrap();
        let f = tokenize("fn ((( unclosed \"string\n", g);
        f.validate().unwrap();
        assert_eq!(f.line_count(), 1);
    }
}
