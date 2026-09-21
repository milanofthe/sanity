//! Binary wire format, the contract with the renderer.
//!
//! The layout is mirrored in `web/src/data/wire.ts`. Both sides carry a test
//! asserting the same bytes for the same input, because a silent disagreement
//! here shows up as garbled code on screen rather than an error.
//!
//! Sections, little endian, in order:
//!
//! ```text
//! header      6 x u32   magic, version, line_count, span_count, lang_id, flags
//! span_start  (line_count + 1) x u32   prefix offsets into spans
//! line_cols   line_count x u16         visual width of the line in columns
//! line_indent line_count x u8          leading indent in columns
//! line_state  line_count x u8          LineState
//! spans       span_count x u32         packed col, len, kind
//! ```
//!
//! Every section starts at a multiple of its own element width so the
//! TypeScript side can create typed array views over the buffer without
//! copying.

pub const MAGIC: u32 = 0x594e_5453; // "SNTY"
pub const VERSION: u32 = 1;

/// Token kinds. Four bits, deliberately coarse and language independent: the
/// overview needs a visual classification, not a parse tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Plain = 0,
    Comment = 1,
    DocComment = 2,
    String = 3,
    Number = 4,
    Keyword = 5,
    Type = 6,
    Function = 7,
    Variable = 8,
    Punctuation = 9,
    Constant = 10,
    Attribute = 11,
}

pub const KIND_COUNT: usize = 12;

/// Change state of a line, from git plus the live watcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum LineState {
    Unchanged = 0,
    Added = 1,
    Modified = 2,
    /// The line sits directly below a deletion.
    DeletedBelow = 3,
}

/// A line may be this many columns wide before it is clipped. Long lines are
/// an outlier in real code and clipping keeps a span in 32 bits.
pub const MAX_COLS: u32 = 4095;
pub const MAX_SPAN_LEN: u32 = 1023;

pub const FLAG_TRUNCATED: u32 = 1 << 0;
pub const FLAG_BINARY: u32 = 1 << 1;
pub const FLAG_NO_GRAMMAR: u32 = 1 << 2;

/// Pack a span: column in bits 0..11, length in 12..21, kind in 22..25.
#[inline]
pub fn pack_span(col: u32, len: u32, kind: Kind) -> u32 {
    (col & 0xfff) | ((len & 0x3ff) << 12) | ((kind as u32 & 0xf) << 22)
}

#[inline]
pub fn span_col(s: u32) -> u32 {
    s & 0xfff
}

#[inline]
pub fn span_len(s: u32) -> u32 {
    (s >> 12) & 0x3ff
}

#[inline]
pub fn span_kind(s: u32) -> u8 {
    ((s >> 22) & 0xf) as u8
}

/// The per-file payload, before encoding.
#[derive(Debug, Default, Clone)]
pub struct FileData {
    pub lang_id: u32,
    pub flags: u32,
    /// Length `line_count + 1`; the last entry equals `spans.len()`.
    pub span_start: Vec<u32>,
    pub line_cols: Vec<u16>,
    pub line_indent: Vec<u8>,
    pub line_state: Vec<u8>,
    pub spans: Vec<u32>,
}

impl FileData {
    pub fn line_count(&self) -> usize {
        self.line_cols.len()
    }

    /// Checks the invariants the renderer relies on. Cheap enough to call on
    /// every encode in debug builds, and a wrong `span_start` prefix is the
    /// kind of bug that would otherwise surface as one file drawing another
    /// file's tokens.
    pub fn validate(&self) -> Result<(), String> {
        let n = self.line_count();
        if self.span_start.len() != n + 1 {
            return Err(format!("span_start has {} entries, expected {}", self.span_start.len(), n + 1));
        }
        if self.line_indent.len() != n || self.line_state.len() != n {
            return Err("per-line arrays disagree on length".into());
        }
        if self.span_start.first().copied() != Some(0) {
            return Err("span_start must start at 0".into());
        }
        if self.span_start[n] as usize != self.spans.len() {
            return Err(format!(
                "span_start ends at {} but there are {} spans",
                self.span_start[n],
                self.spans.len()
            ));
        }
        for i in 0..n {
            if self.span_start[i] > self.span_start[i + 1] {
                return Err(format!("span_start not monotonic at line {i}"));
            }
        }
        Ok(())
    }
}

#[inline]
fn align4(n: usize) -> usize {
    (n + 3) & !3
}

/// Byte length of the encoded payload. Kept separate so a caller can size a
/// buffer up front.
pub fn encoded_len(line_count: usize, span_count: usize) -> usize {
    let mut size = 24 + (line_count + 1) * 4;
    size += align4(line_count * 2) + line_count * 2;
    align4(size) + span_count * 4
}

pub fn encode(f: &FileData) -> Vec<u8> {
    debug_assert!(f.validate().is_ok(), "{:?}", f.validate());
    let n = f.line_count();
    let mut out = Vec::with_capacity(encoded_len(n, f.spans.len()));

    for v in [MAGIC, VERSION, n as u32, f.spans.len() as u32, f.lang_id, f.flags] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in &f.span_start {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in &f.line_cols {
        out.extend_from_slice(&v.to_le_bytes());
    }
    // Pad so the byte arrays, and after them the spans, land where the
    // decoder expects them.
    while out.len() % 4 != 0 {
        out.push(0);
    }
    out.extend_from_slice(&f.line_indent);
    out.extend_from_slice(&f.line_state);
    while out.len() % 4 != 0 {
        out.push(0);
    }
    for v in &f.spans {
        out.extend_from_slice(&v.to_le_bytes());
    }

    debug_assert_eq!(out.len(), encoded_len(n, f.spans.len()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Small fixture with an odd line count, so the padding between the u16
    /// and u32 sections is actually exercised.
    fn fixture() -> FileData {
        FileData {
            lang_id: 3,
            flags: FLAG_TRUNCATED,
            span_start: vec![0, 2, 2, 3],
            line_cols: vec![12, 0, 7],
            line_indent: vec![0, 0, 4],
            line_state: vec![
                LineState::Added as u8,
                LineState::Unchanged as u8,
                LineState::Modified as u8,
            ],
            spans: vec![
                pack_span(0, 3, Kind::Keyword),
                pack_span(4, 8, Kind::String),
                pack_span(4, 3, Kind::Comment),
            ],
        }
    }

    #[test]
    fn fixture_is_valid() {
        fixture().validate().unwrap();
    }

    #[test]
    fn span_packing_roundtrips() {
        for &(col, len, kind) in &[(0, 1, Kind::Plain), (4095, 1023, Kind::Attribute), (137, 42, Kind::Type)] {
            let s = pack_span(col, len, kind);
            assert_eq!(span_col(s), col);
            assert_eq!(span_len(s), len);
            assert_eq!(span_kind(s), kind as u8);
        }
    }

    #[test]
    fn encoded_length_matches_formula() {
        let f = fixture();
        assert_eq!(encode(&f).len(), encoded_len(f.line_count(), f.spans.len()));
    }

    /// The bytes the TypeScript decoder must agree on. Printed by
    /// `cargo test -p sanity-core -- --nocapture golden_bytes` and compared
    /// against `web/src/data/wire.test.ts`.
    #[test]
    fn golden_bytes() {
        let bytes = encode(&fixture());
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        println!("golden {} bytes: {hex}", bytes.len());
        assert_eq!(bytes.len(), 68);
        // Header: magic, version, 3 lines, 3 spans, lang 3, flags 1.
        assert_eq!(&bytes[0..4], &MAGIC.to_le_bytes());
        assert_eq!(&bytes[8..12], &3u32.to_le_bytes());
        assert_eq!(&bytes[12..16], &3u32.to_le_bytes());
        assert_eq!(&bytes[20..24], &1u32.to_le_bytes());
    }

    #[test]
    fn validate_catches_broken_prefix() {
        let mut f = fixture();
        f.span_start = vec![0, 2, 1, 3];
        assert!(f.validate().unwrap_err().contains("monotonic"));

        let mut f = fixture();
        f.span_start = vec![0, 2, 2, 99];
        assert!(f.validate().unwrap_err().contains("span_start ends at"));
    }
}
