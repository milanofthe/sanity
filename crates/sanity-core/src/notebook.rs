//! Notebooks as what they are: cells, not JSON.
//!
//! A `.ipynb` is a JSON document with its outputs embedded as base64, and
//! treating it as text means drawing that. Measured on pathsim's
//! `docs/source/examples/abs_braking.ipynb`: 727 lines, one of them 448,358
//! characters long, which the wire format clips at 4095 columns and the panel
//! then wraps across 45 rows of a 91 column column. Its actual content is 247
//! lines of code and 86 of markdown in 28 cells. Across pathsim's 34
//! notebooks that was 12,634 lines, 18 percent of everything the canvas drew,
//! and a good part of it base64, which tokenises as nothing and reads as grey
//! noise.
//!
//! So a notebook is read here instead: code cells as code, markdown cells as
//! prose, and one line per output saying what it is. The same 34 notebooks
//! come to 5733 lines, abs_braking to 424 with its widest line at 235
//! columns, and what fills a panel is the notebook rather than its encoding.
//!
//! The output lines are placeholders on purpose. Drawing a plot where its
//! cell is belongs to the image work, see issues #20 and #21.

use serde_json::Value;

use crate::wire::{pack_span, FileData, Kind};

/// Which grammar a line belongs to. A notebook mixes two, and the tokeniser
/// is pointed at them per line rather than per file.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineKind {
    Code,
    Prose,
    /// An output placeholder, which belongs to no grammar.
    Output,
}

/// A notebook flattened into lines, with what each line is.
pub struct Notebook {
    pub source: String,
    pub kinds: Vec<LineKind>,
    /// Extension of the kernel's language, for the grammar lookup. "py" when
    /// the notebook does not say.
    pub lang_ext: String,
}

/// Lines of output text kept per output before the rest is summarised. A
/// traceback is worth seeing and a training log is not.
const OUTPUT_LINES: usize = 24;

pub fn is_notebook(rel: &str) -> bool {
    rel.rsplit('.').next().map(|e| e.eq_ignore_ascii_case("ipynb")) == Some(true)
}

/// Read a notebook. Returns `None` for anything that is not one, including a
/// file that merely has the extension, so the caller falls back to treating it
/// as text rather than showing nothing.
pub fn parse(text: &str) -> Option<Notebook> {
    let doc: Value = serde_json::from_str(text).ok()?;
    let cells = doc.get("cells")?.as_array()?;

    let lang_ext = doc
        .get("metadata")
        .and_then(|m| m.get("language_info"))
        .and_then(|l| l.get("file_extension"))
        .and_then(Value::as_str)
        .map(|e| e.trim_start_matches('.').to_string())
        .or_else(|| {
            doc.get("metadata")
                .and_then(|m| m.get("kernelspec"))
                .and_then(|k| k.get("language"))
                .and_then(Value::as_str)
                .map(language_extension)
        })
        .unwrap_or_else(|| "py".to_string());

    let mut nb = Notebook { source: String::new(), kinds: Vec::new(), lang_ext };
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            nb.push("", LineKind::Code);
        }
        let kind = match cell.get("cell_type").and_then(Value::as_str) {
            Some("markdown") | Some("raw") => LineKind::Prose,
            _ => LineKind::Code,
        };
        for line in source_lines(cell.get("source")) {
            nb.push(&line, kind);
        }
        for out in cell.get("outputs").and_then(Value::as_array).into_iter().flatten() {
            push_output(&mut nb, out);
        }
    }
    Some(nb)
}

impl Notebook {
    fn push(&mut self, line: &str, kind: LineKind) {
        if !self.source.is_empty() {
            self.source.push('\n');
        }
        self.source.push_str(line);
        self.kinds.push(kind);
    }

    /// One view of the notebook, with every line that is not `kind` blanked.
    ///
    /// Blanked rather than removed, so the view has the same lines as the
    /// notebook and a span on line 40 of the view is a span on line 40 of the
    /// panel. Two views and two parses per notebook, rather than one parse per
    /// cell: on pathsim's 34 notebooks that is 68 parses instead of about 900.
    pub fn view(&self, kind: LineKind) -> String {
        let mut out = String::with_capacity(self.source.len());
        for (line, k) in self.source.lines().zip(self.kinds.iter()) {
            if *k == kind {
                out.push_str(line);
            }
            out.push('\n');
        }
        out
    }
}

/// A cell's source, which the format allows as a list of lines or one string.
/// Trailing newlines belong to the format, not to the line.
fn source_lines(v: Option<&Value>) -> Vec<String> {
    let text = match v {
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(""),
        Some(Value::String(s)) => s.clone(),
        _ => return Vec::new(),
    };
    let trimmed = text.strip_suffix('\n').unwrap_or(&text);
    trimmed.split('\n').map(str::to_string).collect()
}

/// One output, as the lines it is worth.
///
/// Text and tracebacks are kept, since that is what you look at when
/// something failed. Anything with pixels or markup in it becomes a single
/// line naming the type and, for an image, its size, which is also the line
/// an image will eventually be drawn on.
fn push_output(nb: &mut Notebook, out: &Value) {
    let data = out.get("data");

    if let Some(obj) = data.and_then(Value::as_object) {
        for (mime, payload) in obj {
            if let Some(dim) = image_size(mime, payload) {
                nb.push(&format!("[ {mime} {}x{} ]", dim.0, dim.1), LineKind::Output);
            } else if mime == "text/plain" {
                push_text(nb, source_lines(Some(payload)));
            } else {
                let lines = source_lines(Some(payload)).len();
                nb.push(&format!("[ {mime}, {lines} lines ]"), LineKind::Output);
            }
        }
        return;
    }

    // A stream (stdout, stderr) or an error, both of which are text.
    if let Some(text) = out.get("text") {
        push_text(nb, source_lines(Some(text)));
        return;
    }
    if let Some(tb) = out.get("traceback").and_then(Value::as_array) {
        let lines: Vec<String> = tb
            .iter()
            .filter_map(Value::as_str)
            .flat_map(|l| l.split('\n').map(strip_ansi).collect::<Vec<_>>())
            .collect();
        push_text(nb, lines);
        return;
    }
    if let Some(name) = out.get("ename").and_then(Value::as_str) {
        let msg = out.get("evalue").and_then(Value::as_str).unwrap_or("");
        nb.push(&format!("{name}: {msg}"), LineKind::Output);
    }
}

fn push_text(nb: &mut Notebook, lines: Vec<String>) {
    let total = lines.len();
    for line in lines.into_iter().take(OUTPUT_LINES) {
        nb.push(&line, LineKind::Output);
    }
    if total > OUTPUT_LINES {
        nb.push(&format!("[ {} more lines ]", total - OUTPUT_LINES), LineKind::Output);
    }
}

/// Pixel size of an image output, read from the encoded bytes rather than
/// from metadata, which is optional and often absent. PNG and GIF carry it in
/// a fixed header; JPEG and SVG are reported without a size rather than
/// decoded here.
fn image_size(mime: &str, payload: &Value) -> Option<(u32, u32)> {
    if !mime.starts_with("image/") {
        return None;
    }
    let raw = match payload {
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<String>(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    // Only the head is needed, and a base64 line break costs nothing to drop.
    let head: String = raw.chars().filter(|c| !c.is_whitespace()).take(64).collect();
    let bytes = base64_head(&head)?;
    if bytes.len() >= 24 && bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
        let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
        return Some((w, h));
    }
    if bytes.len() >= 10 && bytes.starts_with(b"GIF8") {
        let w = u16::from_le_bytes([bytes[6], bytes[7]]) as u32;
        let h = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        return Some((w, h));
    }
    None
}

/// Enough base64 to read an image header. Hand-rolled because pulling in a
/// dependency to decode 48 bytes is not a trade.
fn base64_head(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        let v = TABLE.iter().position(|&t| t == c)? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// A traceback arrives with terminal colour codes in it.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Kernel language to file extension, for the grammar lookup. Only the ones a
/// notebook is actually written in; anything else falls through to Python,
/// whose grammar at least agrees about comments and strings.
fn language_extension(language: &str) -> String {
    match language {
        "julia" => "jl",
        "r" => "r",
        "rust" => "rs",
        "javascript" | "typescript" => "ts",
        "bash" | "sh" => "sh",
        _ => "py",
    }
    .to_string()
}

/// Tokenise a notebook: one parse for its code, one for its prose, and a span
/// of its own for every output line.
///
/// The line metrics come from the notebook's own text, so widths and
/// indentation are what the panel will draw; only the spans come from the two
/// views. `lang_id` is the code language's, since that is what the file is
/// about and what the coverage report should count it as.
pub fn tokenize(nb: &Notebook) -> FileData {
    let mut data = crate::scan::plain_file_data(&nb.source);

    let code = crate::lang::grammar_for_extension(&nb.lang_ext)
        .map(|g| crate::tokenize::tokenize(&nb.view(LineKind::Code), g));
    let prose = crate::lang::grammar_for_extension("md")
        .map(|g| crate::tokenize::tokenize(&nb.view(LineKind::Prose), g));

    if let Some(c) = code.as_ref() {
        data.lang_id = c.lang_id;
    }

    let mut spans: Vec<u32> = Vec::with_capacity(data.spans.len());
    let mut span_start: Vec<u32> = Vec::with_capacity(data.line_count() + 1);
    for (line, kind) in nb.kinds.iter().enumerate() {
        span_start.push(spans.len() as u32);
        let from = match kind {
            LineKind::Code => code.as_ref(),
            LineKind::Prose => prose.as_ref(),
            // An output line has no grammar: one span over its text, in the
            // colour comments take, which is what it is.
            LineKind::Output => {
                let cols = data.line_cols[line] as u32;
                let indent = data.line_indent[line] as u32;
                if cols > indent {
                    spans.push(pack_span(indent, cols - indent, Kind::Comment));
                }
                continue;
            }
        };
        let Some(view) = from else { continue };
        // A view has the notebook's lines, so line `n` there is line `n` here.
        if line + 1 >= view.span_start.len() {
            continue;
        }
        let s0 = view.span_start[line] as usize;
        let s1 = view.span_start[line + 1] as usize;
        spans.extend_from_slice(&view.spans[s0..s1]);
    }
    span_start.push(spans.len() as u32);

    data.spans = spans;
    data.span_start = span_start;
    data
}

#[cfg(test)]
mod tests {
    use super::*;

    const NB: &str = r##"{
      "cells": [
        {"cell_type": "markdown", "source": ["# Title\n", "\n", "Some prose.\n"]},
        {"cell_type": "code", "source": "import numpy as np\nx = np.zeros(3)\n",
         "outputs": [
           {"output_type": "stream", "name": "stdout", "text": ["one\n", "two\n"]},
           {"output_type": "display_data", "data": {"image/png": "iVBORw0KGgoAAAANSUhEUgAAAAMAAAAFCAYAAAB4ka1VAAAAGXRFWHRTb2Z0"}}
         ]}
      ],
      "metadata": {"language_info": {"file_extension": ".py"}}
    }"##;

    #[test]
    fn a_notebook_reads_as_its_cells() {
        let nb = parse(NB).expect("parses");
        let lines: Vec<&str> = nb.source.lines().collect();
        assert_eq!(
            lines,
            vec![
                "# Title",
                "",
                "Some prose.",
                "",
                "import numpy as np",
                "x = np.zeros(3)",
                "one",
                "two",
                "[ image/png 3x5 ]",
            ]
        );
        assert_eq!(nb.kinds.len(), lines.len());
        assert_eq!(nb.kinds[0], LineKind::Prose);
        assert_eq!(nb.kinds[4], LineKind::Code);
        assert_eq!(nb.kinds[6], LineKind::Output);
        assert_eq!(nb.lang_ext, "py");
    }

    #[test]
    fn a_view_keeps_the_line_numbers() {
        let nb = parse(NB).expect("parses");
        let code_view = nb.view(LineKind::Code);
        let prose_view = nb.view(LineKind::Prose);
        let code: Vec<&str> = code_view.lines().collect();
        let prose: Vec<&str> = prose_view.lines().collect();
        assert_eq!(code.len(), nb.kinds.len());
        assert_eq!(prose.len(), nb.kinds.len());
        assert_eq!(code[4], "import numpy as np");
        assert_eq!(code[0], "");
        assert_eq!(prose[0], "# Title");
        assert_eq!(prose[4], "");
    }

    #[test]
    fn what_is_not_a_notebook_is_not_forced_into_one() {
        assert!(parse("{}").is_none());
        assert!(parse("not json at all").is_none());
        assert!(is_notebook("docs/x.ipynb"));
        assert!(!is_notebook("docs/x.py"));
    }

    #[test]
    fn long_output_is_summarised_rather_than_drawn() {
        let lines: Vec<String> = (0..100).map(|i| format!("line {i}\n")).collect();
        let doc = format!(
            r#"{{"cells": [{{"cell_type": "code", "source": "x = 1",
               "outputs": [{{"output_type": "stream", "text": {}}}]}}]}}"#,
            serde_json::to_string(&lines).unwrap()
        );
        let nb = parse(&doc).expect("parses");
        let last = nb.source.lines().last().unwrap();
        assert_eq!(last, "[ 76 more lines ]");
        assert_eq!(nb.source.lines().count(), 1 + OUTPUT_LINES + 1);
    }
}
