//! A coarse lexer for languages with no usable tree-sitter grammar.
//!
//! Verilog-A is the case that forced this. It looks like Verilog and is not:
//! `analog begin`, contribution statements (`I(a,b) <+ ...`), `nature` and
//! `discipline` declarations, and `parameter real type = 1.0` where `type` is
//! a SystemVerilog keyword. Both grammars on crates.io were measured against
//! the 18,452 lines of Verilog-A in a real project:
//!
//! | grammar                    | share of the file inside an ERROR node |
//! |----------------------------|----------------------------------------|
//! | tree-sitter-verilog 1.0.3  | 29% to 100%, and 100% on the two biggest files |
//! | tree-sitter-systemverilog  | 0.0% on the largest, 100% on four others |
//!
//! Inside an ERROR node nothing is captured, so those files rendered as flat
//! text. A parser that fails on whole files is worse here than a lexer that
//! never fails on any: this format keeps twelve coarse kinds and is mostly
//! seen at a few pixels per line, where the distinction between a real parse
//! and a good guess does not survive anyway.
//!
//! What this deliberately cannot do: anything needing structure. An identifier
//! is a function because a bracket follows it, not because it was declared
//! one. That is the trade.

use crate::tokenize::Builder;
use crate::wire::{FileData, Kind};

/// A language described well enough to lex.
pub struct Syntax {
    pub line_comments: &'static [&'static str],
    /// Markers that only start a comment when nothing but whitespace precedes
    /// them on the line. SPICE needs this: `*` in the first column is a
    /// comment and `*` anywhere else is multiplication.
    pub line_comments_at_start: &'static [&'static str],
    pub block_comment: Option<(&'static str, &'static str)>,
    /// Quote characters that open and close a string, escaped with backslash.
    pub strings: &'static [char],
    /// Characters that begin a directive running over the following
    /// identifier: the backtick in Verilog, the dot in SPICE.
    pub directive: &'static [char],
    /// What a directive reads as. A Verilog macro is an annotation on the
    /// code; a SPICE dot-command is the statement itself.
    pub directive_kind: Kind,
    /// Characters that begin a built-in call: the dollar in Verilog.
    pub system: &'static [char],
    pub keywords: &'static [&'static str],
    pub types: &'static [&'static str],
    pub builtins: &'static [&'static str],
    pub constants: &'static [&'static str],
    /// When set, the first identifier on a line is the name of the thing the
    /// line declares, and reads as one. True for SPICE, where every element
    /// line starts with its instance name.
    pub first_token_names: bool,
}

fn is_ident_start(c: char) -> bool {
    c.is_alphabetic() || c == '_'
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '$'
}

/// Where a token ends and what it is.
struct Token {
    end: usize,
    kind: Kind,
}

/// Position in the line, which two of the rules depend on.
#[derive(Clone, Copy)]
struct LineState {
    /// Nothing but whitespace since the last newline.
    at_start: bool,
    /// No identifier yet on this line.
    first_ident: bool,
}

/// Classify the token starting at `i`. Never returns `end <= i`, so the caller
/// cannot loop forever on an input it does not understand.
fn next_token(chars: &[char], i: usize, syn: &Syntax, line: LineState) -> Token {
    let c = chars[i];

    // Matching a literal at a position, on chars rather than bytes: the file
    // may be UTF-8 and a byte index into a comment marker would be wrong.
    let at = |k: usize, lit: &str| -> bool {
        let mut k = k;
        for ch in lit.chars() {
            if chars.get(k) != Some(&ch) {
                return false;
            }
            k += 1;
        }
        true
    };

    // Comments first: everything inside one is a comment whatever it looks
    // like, which is the whole point of doing this in one pass.
    let starts_comment = syn.line_comments.iter().any(|m| at(i, m))
        || (line.at_start && syn.line_comments_at_start.iter().any(|m| at(i, m)));
    if starts_comment {
        let mut j = i;
        while j < chars.len() && chars[j] != '\n' {
            j += 1;
        }
        return Token { end: j.max(i + 1), kind: Kind::Comment };
    }

    if let Some((open, close)) = syn.block_comment {
        if at(i, open) {
            let open_len = open.chars().count();
            let mut j = i + open_len;
            while j < chars.len() && !at(j, close) {
                j += 1;
            }
            // Unterminated runs to the end of the file, which is what a
            // half-written file looks like and must not be a panic.
            let end = (j + close.chars().count()).min(chars.len());
            // A marker with its last character doubled is a doc comment in
            // every language that has the convention: `/**`, `(**`.
            let doubled = chars.get(i + open_len) == open.chars().last().as_ref();
            let kind = if doubled { Kind::DocComment } else { Kind::Comment };
            return Token { end: end.max(i + 1), kind };
        }
    }

    if syn.strings.contains(&c) {
        let mut j = i + 1;
        while j < chars.len() && chars[j] != c && chars[j] != '\n' {
            // A backslash takes the next character with it, including a quote,
            // so `"a\"b"` is one string.
            j += if chars[j] == '\\' { 2 } else { 1 };
        }
        return Token { end: (j + 1).min(chars.len()).max(i + 1), kind: Kind::String };
    }

    // Numbers before directives, so SPICE's dot does not swallow `.5`.
    if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(|d| d.is_ascii_digit())) {
        return Token { end: number_end(chars, i), kind: Kind::Number };
    }

    // `include and `define in Verilog, .model and .tran in SPICE.
    if syn.directive.contains(&c) {
        let mut j = i + 1;
        while j < chars.len() && is_ident(chars[j]) {
            j += 1;
        }
        // A lone marker with no name after it is just punctuation.
        let kind = if j > i + 1 { syn.directive_kind } else { Kind::Punctuation };
        return Token { end: j.max(i + 1), kind };
    }

    // $temperature, $vt, $finish.
    if syn.system.contains(&c) {
        let mut j = i + 1;
        while j < chars.len() && is_ident(chars[j]) {
            j += 1;
        }
        let kind = if j > i + 1 { Kind::Function } else { Kind::Punctuation };
        return Token { end: j.max(i + 1), kind };
    }

    if is_ident_start(c) {
        let mut j = i;
        while j < chars.len() && is_ident(chars[j]) {
            j += 1;
        }
        let word: String = chars[i..j].iter().collect();
        let kind = if syn.first_token_names && line.first_ident {
            // In SPICE the first word on a line is the instance or subcircuit
            // being declared, whatever it is called.
            Kind::Function
        } else if syn.keywords.iter().any(|k| k.eq_ignore_ascii_case(&word)) {
            Kind::Keyword
        } else if syn.types.iter().any(|k| k.eq_ignore_ascii_case(&word)) {
            Kind::Type
        } else if syn.builtins.iter().any(|k| k.eq_ignore_ascii_case(&word)) {
            Kind::Function
        } else if syn.constants.contains(&word.as_str()) {
            Kind::Constant
        } else {
            // A bracket after the name makes it a call. Structure is not
            // available here, so this is the one inference worth making: it is
            // right far more often than it is wrong, and it is what makes a
            // file of model equations readable in outline.
            let mut k = j;
            while k < chars.len() && (chars[k] == ' ' || chars[k] == '\t') {
                k += 1;
            }
            if chars.get(k) == Some(&'(') {
                Kind::Function
            } else {
                // A bare name is a variable, which is what every tree-sitter
                // query does with one too. Leaving it Plain gave a Verilog-A
                // file two thirds the coloured coverage of the same code in
                // any other language, and model code is mostly names.
                Kind::Variable
            }
        };
        return Token { end: j, kind };
    }

    // Whitespace passes through so the builder can close runs and count
    // columns; everything else is punctuation.
    let kind = if c.is_whitespace() { Kind::Plain } else { Kind::Punctuation };
    Token { end: i + 1, kind }
}

/// End of a number, including the engineering suffixes that make `1.5n` one
/// token in Verilog-A and SPICE and `1.5` followed by a name anywhere else.
fn number_end(chars: &[char], i: usize) -> usize {
    let mut j = i;
    let mut seen_exp = false;
    while j < chars.len() {
        let d = chars[j];
        if d.is_ascii_digit() || d == '.' || d == '_' {
            j += 1;
        } else if (d == 'e' || d == 'E') && !seen_exp {
            seen_exp = true;
            j += 1;
            if matches!(chars.get(j), Some('+') | Some('-')) {
                j += 1;
            }
        } else if matches!(d, 'T' | 'G' | 'M' | 'K' | 'k' | 'm' | 'u' | 'n' | 'p' | 'f' | 'a')
            && !chars.get(j + 1).copied().is_some_and(is_ident)
        {
            // A scale suffix, but only when nothing follows it: `1.5n` is a
            // number and `1.5nice` is not.
            j += 1;
            break;
        } else {
            break;
        }
    }
    j.max(i + 1)
}

/// Lex `text` and produce the same payload a grammar would.
pub fn lex(text: &str, lang_id: u32, syn: &Syntax) -> FileData {
    let chars: Vec<char> = text.chars().collect();
    let mut b = Builder::new(text.len());
    let mut line = LineState { at_start: true, first_ident: true };
    let mut i = 0usize;

    while i < chars.len() {
        let token = next_token(&chars, i, syn, line);
        debug_assert!(token.end > i, "a token has to consume something");

        for &ch in &chars[i..token.end] {
            b.push_char(ch, token.kind);
            // Line position, kept in step here rather than in every branch of
            // the classifier: each branch advances by a different amount and
            // one of them forgetting would show up as a comment marker missed
            // on one line in a hundred.
            if ch == '\n' {
                line = LineState { at_start: true, first_ident: true };
            } else if !ch.is_whitespace() {
                line.at_start = false;
            }
        }
        if token.kind != Kind::Plain && token.kind != Kind::Comment {
            line.first_ident = false;
        }
        i = token.end;
    }

    b.finish(lang_id, 0)
}

/// Verilog-A and Verilog-AMS.
///
/// Keyword list from the Verilog-AMS Language Reference Manual 2.4, trimmed to
/// what appears in device models: that is what these files are, and a list
/// including every digital construct would colour words that never occur.
pub const VERILOG_A: Syntax = Syntax {
    line_comments: &["//"],
    line_comments_at_start: &[],
    block_comment: Some(("/*", "*/")),
    strings: &['"'],
    directive: &['`'],
    directive_kind: Kind::Attribute,
    system: &['$'],
    keywords: &[
        "module", "endmodule", "macromodule", "connectmodule", "endconnectmodule",
        "connectrules", "endconnectrules", "paramset", "endparamset",
        "discipline", "enddiscipline", "nature", "endnature",
        "analog", "initial", "final", "always", "begin", "end",
        "function", "endfunction", "task", "endtask",
        "if", "else", "case", "casex", "casez", "endcase", "default",
        "for", "while", "repeat", "forever", "generate", "endgenerate",
        "input", "output", "inout", "parameter", "localparam", "aliasparam",
        "defparam", "branch", "assign", "return", "domain", "potential", "flow",
        "abstol", "units", "access", "idt_nature", "ddt_nature", "from",
        "exclude", "inf", "and", "or", "not", "signed", "unsigned",
        "include", "define", "ifdef", "ifndef", "elsif", "endif", "undef",
    ],
    types: &[
        "real", "integer", "string", "genvar", "reg", "wire", "wreal",
        "electrical", "voltage", "current", "thermal", "ground",
        "magnetic", "rotational", "kinematic", "logic", "time", "realtime",
    ],
    builtins: &[
        // Analog operators: the ones that make it an analog language.
        "ddt", "idt", "idtmod", "ddx", "absdelay", "transition", "slew",
        "laplace_zd", "laplace_zp", "laplace_np", "laplace_nd",
        "zi_zd", "zi_zp", "zi_np", "zi_nd",
        "white_noise", "flicker_noise", "noise_table", "ac_stim", "analysis",
        "limexp", "last_crossing",
        // Mathematics.
        "abs", "max", "min", "pow", "sqrt", "exp", "ln", "log", "hypot",
        "sin", "cos", "tan", "asin", "acos", "atan", "atan2",
        "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
        "floor", "ceil",
    ],
    constants: &["M_PI", "M_E", "M_TWO_PI", "M_SQRT2", "P_Q", "P_K", "P_EPS0", "P_CELSIUS0"],
    first_token_names: false,
};

/// SPICE netlists, in the dialects ngspice and Spectre accept.
///
/// A netlist is not really a programming language: every line is either a
/// dot-command or an element instance whose first word is its own name. That
/// makes it easy to lex and impossible to parse with a grammar written for
/// something else, which is why it is here.
pub const SPICE: Syntax = Syntax {
    // `;` and `//` are inline comments in ngspice.
    line_comments: &[";", "//", "$ "],
    // `*` in the first column is a comment; anywhere else it is multiplication.
    line_comments_at_start: &["*"],
    block_comment: None,
    strings: &['"', '\''],
    // A dot-command is the statement, so it reads as a keyword rather than as
    // an annotation on one.
    directive: &['.'],
    directive_kind: Kind::Keyword,
    system: &[],
    keywords: &[
        // Value kinds on a source line, which are the words that are not names.
        "dc", "ac", "tran", "pulse", "sin", "sine", "pwl", "exp", "sffm", "am",
        "noise", "distof1", "distof2", "temp", "poly", "table", "value",
        "all", "on", "off", "true", "false", "yes", "no",
    ],
    types: &[
        // The analyses and structure, without the leading dot: a line may say
        // `tran` in the middle of a `.control` block.
        "model", "subckt", "ends", "end", "param", "include", "lib", "options",
        "option", "control", "endc", "nodeset", "ic", "global", "func", "save",
        "print", "plot", "probe", "measure", "meas", "step", "op", "four",
    ],
    builtins: &[
        "abs", "sqrt", "exp", "ln", "log", "log10", "pow", "pwr", "min", "max",
        "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
        "floor", "ceil", "int", "nint", "sgn", "if", "limit", "uramp", "u",
    ],
    constants: &["pi", "e", "boltz", "echarge", "kelvin"],
    first_token_names: true,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{span_kind, span_len};

    fn kinds(f: &FileData, line: usize) -> Vec<u8> {
        let a = f.span_start[line] as usize;
        let b = f.span_start[line + 1] as usize;
        f.spans[a..b].iter().map(|&s| span_kind(s)).collect()
    }

    #[test]
    fn verilog_a_gets_its_own_vocabulary() {
        let src = concat!(
            "// a note\n",
            "`include \"disciplines.vams\"\n",
            "module res(a, b);\n",
            "    electrical a, b;\n",
            "    parameter real r = 1.0e3 from (0:inf);\n",
            "    analog I(a, b) <+ V(a, b) / r;\n",
            "endmodule\n",
        );
        let f = lex(src, 18, &VERILOG_A);
        f.validate().unwrap();
        assert_eq!(f.line_count(), 7);
        assert_eq!(f.lang_id, 18);

        assert!(kinds(&f, 0).contains(&(Kind::Comment as u8)), "line comment");
        assert!(kinds(&f, 1).contains(&(Kind::Attribute as u8)), "`include is a directive");
        assert!(kinds(&f, 1).contains(&(Kind::String as u8)), "the included name is a string");
        assert!(kinds(&f, 2).contains(&(Kind::Keyword as u8)), "module");
        assert!(kinds(&f, 3).contains(&(Kind::Type as u8)), "electrical is a discipline");
        let params = kinds(&f, 4);
        assert!(params.contains(&(Kind::Keyword as u8)), "parameter");
        assert!(params.contains(&(Kind::Type as u8)), "real");
        assert!(params.contains(&(Kind::Number as u8)), "1.0e3");
        assert!(kinds(&f, 5).contains(&(Kind::Function as u8)), "I(a,b) reads as a call");
    }

    #[test]
    fn engineering_suffixes_are_part_of_the_number() {
        // `1.5n` is one token in Verilog-A. Getting this wrong would colour
        // the suffix as a variable in the middle of every model parameter.
        let f = lex("x = 1.5n;\ny = 2.5nice;\n", 18, &VERILOG_A);
        let first = f.span_start[0] as usize..f.span_start[1] as usize;
        let numbers: Vec<u32> = f.spans[first]
            .iter()
            .filter(|&&s| span_kind(s) == Kind::Number as u8)
            .map(|&s| span_len(s))
            .collect();
        assert_eq!(numbers, vec![4], "1.5n is four characters of number");

        // And a suffix with a word attached is not a suffix.
        let second = f.span_start[1] as usize..f.span_start[2] as usize;
        let numbers: Vec<u32> = f.spans[second]
            .iter()
            .filter(|&&s| span_kind(s) == Kind::Number as u8)
            .map(|&s| span_len(s))
            .collect();
        assert_eq!(numbers, vec![3], "2.5 stops before nice");
    }

    #[test]
    fn a_string_with_an_escaped_quote_is_one_string() {
        let f = lex("s = \"a\\\"b\";\n", 18, &VERILOG_A);
        let strings = kinds(&f, 0).iter().filter(|&&k| k == Kind::String as u8).count();
        assert_eq!(strings, 1, "the escape must not end the string");
    }

    #[test]
    fn an_unterminated_comment_runs_to_the_end_without_panicking() {
        // Real files are truncated and half written; running off the end is
        // the one way a hand written lexer crashes.
        let f = lex("/* never closed\nmore text\n", 18, &VERILOG_A);
        f.validate().unwrap();
        assert!(kinds(&f, 0).contains(&(Kind::Comment as u8)));
    }

    #[test]
    fn whitespace_never_becomes_a_span() {
        // The same invariant the grammar path has: indentation is what gives a
        // zoomed out file its shape.
        let f = lex("    x = 1;\n\n        y = 2;\n", 18, &VERILOG_A);
        for line in 0..f.line_count() {
            let a = f.span_start[line] as usize;
            let b = f.span_start[line + 1] as usize;
            for &s in &f.spans[a..b] {
                assert!(span_len(s) > 0);
            }
        }
        assert_eq!(f.line_indent.as_slice(), &[4, 0, 8]);
    }

#[test]
    fn spice_marks_dot_commands_instance_names_and_comments() {
        let src = concat!(
            "* biased clipper\n",
            "V1 3 0 DC 1.3\n",
            "R1 2 1 1k\n",
            "D1 2 3 DMOD  ; the clamp\n",
            ".model DMOD D(Is=1e-14 N=1 Vt=0.02585)\n",
            ".end\n",
        );
        let f = lex(src, 19, &SPICE);
        f.validate().unwrap();
        assert_eq!(f.line_count(), 6);

        assert!(kinds(&f, 0).contains(&(Kind::Comment as u8)), "a star in column one");
        let source = kinds(&f, 1);
        assert_eq!(source[0], Kind::Function as u8, "V1 is the instance name");
        assert!(source.contains(&(Kind::Keyword as u8)), "DC is a value kind");
        assert!(source.contains(&(Kind::Number as u8)), "1.3");
        assert!(kinds(&f, 2).contains(&(Kind::Number as u8)), "1k is a number with a suffix");
        assert!(kinds(&f, 3).contains(&(Kind::Comment as u8)), "a semicolon comments the rest");
        assert!(kinds(&f, 4).contains(&(Kind::Keyword as u8)), ".model is a dot command");
        assert!(kinds(&f, 5).contains(&(Kind::Keyword as u8)), ".end is a dot command");
    }

    #[test]
    fn a_star_away_from_the_line_start_is_multiplication() {
        // The rule that makes SPICE different from everything else, and the
        // one that would silently comment out half a file if it were wrong.
        let f = lex("R1 1 0 {2*rval}\n", 19, &SPICE);
        let k = kinds(&f, 0);
        assert!(
            !k.contains(&(Kind::Comment as u8)),
            "a star inside an expression is not a comment: {k:?}"
        );
    }

    #[test]
    fn a_leading_dot_number_is_a_number_not_a_command() {
        let f = lex("V1 1 0 .5\n", 19, &SPICE);
        assert!(kinds(&f, 0).contains(&(Kind::Number as u8)));
        assert!(
            !kinds(&f, 0).contains(&(Kind::Keyword as u8)),
            "`.5` must not be read as a dot command"
        );
    }

    #[test]
    fn dot_commands_are_case_insensitive() {
        // Netlists in the wild are written in both cases, often in the same
        // file, and SPICE itself does not care.
        for src in [".TRAN 1n 10n\n", ".tran 1n 10n\n"] {
            let f = lex(src, 19, &SPICE);
            assert!(
                kinds(&f, 0).contains(&(Kind::Keyword as u8)),
                "{src:?} should start with a command"
            );
        }
    }

    #[test]
    fn every_token_consumes_something() {
        // The one way a hand written lexer hangs. Run both syntaxes over text
        // made of the characters most likely to fall through every branch.
        for syn in [&VERILOG_A, &SPICE] {
            for src in ["", "\n", "\u{00e9}", "@#~", "`", "$", ".", "*", "/*", "\"", "'", "0x"] {
                let f = lex(src, 0, syn);
                f.validate().unwrap();
            }
        }
    }

    #[test]
    fn an_empty_file_is_valid() {
        let f = lex("", 18, &VERILOG_A);
        f.validate().unwrap();
        assert_eq!(f.line_count(), 0);
    }
}
