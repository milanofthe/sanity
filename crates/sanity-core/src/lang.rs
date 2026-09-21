//! Language registry: which grammar handles which extension.
//!
//! One entry per language, with the extensions it claims and a lazily built
//! highlight configuration. Compiling a highlight query costs milliseconds, so
//! configurations are built once and shared; a repository of a thousand files
//! touches at most a dozen languages.

use std::sync::OnceLock;

use tree_sitter::Language;
use tree_sitter_highlight::HighlightConfiguration;

use crate::wire::Kind;

/// Capture names requested from every grammar.
///
/// `tree_sitter_highlight` resolves a capture to the longest entry here that
/// is a prefix of it, so `function.method` falls back to `function` without
/// needing its own row. The list is therefore only as long as the distinctions
/// that survive into the twelve wire-format kinds.
pub const HIGHLIGHT_NAMES: &[&str] = &[
    "attribute",
    "comment",
    "comment.documentation",
    "constant",
    "constant.builtin",
    "constructor",
    "escape",
    "function",
    "function.builtin",
    "function.method",
    "keyword",
    "label",
    "number",
    "operator",
    "property",
    "punctuation",
    "punctuation.bracket",
    "punctuation.delimiter",
    "punctuation.special",
    "string",
    "string.escape",
    "string.special",
    "tag",
    "type",
    "type.builtin",
    "variable",
    "variable.builtin",
    "variable.member",
    "variable.parameter",
];

/// Wire-format kind per entry in `HIGHLIGHT_NAMES`, same order.
///
/// Coarse by design: the overview needs a file to have a recognisable
/// signature, not a faithful editor theme. Operators map to punctuation and
/// properties to variables because at three pixels per line those
/// distinctions are noise.
const KIND_FOR_NAME: &[Kind] = &[
    Kind::Attribute,   // attribute
    Kind::Comment,     // comment
    Kind::DocComment,  // comment.documentation
    Kind::Constant,    // constant
    Kind::Constant,    // constant.builtin
    Kind::Type,        // constructor
    Kind::String,      // escape
    Kind::Function,    // function
    Kind::Function,    // function.builtin
    Kind::Function,    // function.method
    Kind::Keyword,     // keyword
    Kind::Constant,    // label
    Kind::Number,      // number
    Kind::Punctuation, // operator
    Kind::Variable,    // property
    Kind::Punctuation, // punctuation
    Kind::Punctuation, // punctuation.bracket
    Kind::Punctuation, // punctuation.delimiter
    Kind::Punctuation, // punctuation.special
    Kind::String,      // string
    Kind::String,      // string.escape
    Kind::String,      // string.special
    Kind::Type,        // tag
    Kind::Type,        // type
    Kind::Type,        // type.builtin
    Kind::Variable,    // variable
    Kind::Variable,    // variable.builtin
    Kind::Variable,    // variable.member
    Kind::Variable,    // variable.parameter
];

/// Kind for a highlight index, or `Plain` when the grammar reported a capture
/// outside the requested set.
pub fn kind_for_highlight(index: usize) -> Kind {
    KIND_FOR_NAME.get(index).copied().unwrap_or(Kind::Plain)
}

struct Entry {
    /// Stable id, written into the payload header. Used by the renderer to
    /// colour a file by language at the outermost zoom level.
    id: u32,
    name: &'static str,
    extensions: &'static [&'static str],
    language: fn() -> Language,
    /// Query parts, concatenated in order.
    ///
    /// A list rather than one string because several grammars only ship the
    /// patterns specific to them and expect a base language's query in front:
    /// TypeScript's own highlights do not mark `const` as a keyword, because
    /// that comes from JavaScript. Getting this wrong is quiet, the file just
    /// renders almost entirely as plain text.
    highlights: &'static [&'static str],
    injections: &'static [&'static str],
    locals: &'static [&'static str],
}

/// Registry order sets the language ids, so entries are only ever appended.
///
/// Id 15 is deliberately unused: it was LaTeX, dropped because
/// `tree-sitter-latex` ships the grammar with its highlight query commented
/// out, and `tree-sitter-verilog` ships none at all. Both need a query written
/// by hand before they can be added, which is tracked separately. Ids are
/// written into payload headers, so a gap is cheaper than a renumber.
fn entries() -> &'static [Entry] {
    &[
        Entry {
            id: 1,
            name: "rust",
            extensions: &["rs"],
            language: || tree_sitter_rust::LANGUAGE.into(),
            highlights: &[tree_sitter_rust::HIGHLIGHTS_QUERY],
            injections: &[tree_sitter_rust::INJECTIONS_QUERY],
            locals: &[],
        },
        Entry {
            id: 2,
            name: "python",
            extensions: &["py", "pyi", "pyw"],
            language: || tree_sitter_python::LANGUAGE.into(),
            highlights: &[tree_sitter_python::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 3,
            name: "typescript",
            extensions: &["ts", "mts", "cts"],
            language: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            highlights: &[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY,
            ],
            injections: &[],
            locals: &[tree_sitter_typescript::LOCALS_QUERY],
        },
        Entry {
            id: 4,
            name: "tsx",
            extensions: &["tsx", "jsx"],
            language: || tree_sitter_typescript::LANGUAGE_TSX.into(),
            highlights: &[
                tree_sitter_javascript::HIGHLIGHT_QUERY,
                tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                tree_sitter_typescript::HIGHLIGHTS_QUERY,
            ],
            injections: &[],
            locals: &[tree_sitter_typescript::LOCALS_QUERY],
        },
        Entry {
            id: 5,
            name: "javascript",
            extensions: &["js", "mjs", "cjs"],
            language: || tree_sitter_javascript::LANGUAGE.into(),
            highlights: &[tree_sitter_javascript::HIGHLIGHT_QUERY],
            injections: &[tree_sitter_javascript::INJECTIONS_QUERY],
            locals: &[tree_sitter_javascript::LOCALS_QUERY],
        },
        Entry {
            id: 6,
            name: "c",
            extensions: &["c", "h"],
            language: || tree_sitter_c::LANGUAGE.into(),
            highlights: &[tree_sitter_c::HIGHLIGHT_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 7,
            name: "cpp",
            extensions: &["cpp", "cc", "cxx", "hpp", "hh", "hxx", "cu", "cuh"],
            language: || tree_sitter_cpp::LANGUAGE.into(),
            highlights: &[tree_sitter_cpp::HIGHLIGHT_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 8,
            name: "go",
            extensions: &["go"],
            language: || tree_sitter_go::LANGUAGE.into(),
            highlights: &[tree_sitter_go::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 9,
            name: "json",
            extensions: &["json", "jsonc", "ndjson", "jsonl"],
            language: || tree_sitter_json::LANGUAGE.into(),
            highlights: &[tree_sitter_json::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 10,
            name: "toml",
            extensions: &["toml"],
            language: || tree_sitter_toml_ng::LANGUAGE.into(),
            highlights: &[tree_sitter_toml_ng::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 11,
            name: "yaml",
            extensions: &["yaml", "yml"],
            language: || tree_sitter_yaml::LANGUAGE.into(),
            highlights: &[tree_sitter_yaml::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 12,
            name: "markdown",
            extensions: &["md", "markdown"],
            language: || tree_sitter_md::LANGUAGE.into(),
            highlights: &[tree_sitter_md::HIGHLIGHT_QUERY_BLOCK],
            injections: &[tree_sitter_md::INJECTION_QUERY_BLOCK],
            locals: &[],
        },
        Entry {
            id: 13,
            name: "css",
            extensions: &["css", "scss"],
            language: || tree_sitter_css::LANGUAGE.into(),
            highlights: &[tree_sitter_css::HIGHLIGHTS_QUERY],
            injections: &[],
            locals: &[],
        },
        Entry {
            id: 14,
            name: "html",
            extensions: &["html", "htm", "svelte", "vue"],
            language: || tree_sitter_html::LANGUAGE.into(),
            highlights: &[tree_sitter_html::HIGHLIGHTS_QUERY],
            injections: &[tree_sitter_html::INJECTIONS_QUERY],
            locals: &[],
        },
        Entry {
            id: 16,
            name: "bash",
            extensions: &["sh", "bash", "zsh"],
            language: || tree_sitter_bash::LANGUAGE.into(),
            highlights: &[tree_sitter_bash::HIGHLIGHT_QUERY],
            injections: &[],
            locals: &[],
        },
    ]
}

/// A built, reusable highlight configuration.
pub struct Grammar {
    pub id: u32,
    pub name: &'static str,
    pub config: HighlightConfiguration,
}

static GRAMMARS: OnceLock<Vec<Grammar>> = OnceLock::new();

fn grammars() -> &'static [Grammar] {
    GRAMMARS.get_or_init(|| {
        entries()
            .iter()
            .filter_map(|e| {
                // A grammar whose query fails to compile is skipped rather than
                // fatal: its files then render as plain text, which is a far
                // better outcome than the app refusing to open a repository.
                let highlights = e.highlights.join("\n");
                let injections = e.injections.join("\n");
                let locals = e.locals.join("\n");
                let mut config = HighlightConfiguration::new(
                    (e.language)(),
                    e.name,
                    &highlights,
                    &injections,
                    &locals,
                )
                .ok()?;
                config.configure(HIGHLIGHT_NAMES);
                Some(Grammar { id: e.id, name: e.name, config })
            })
            .collect()
    })
}

/// The grammar claiming this extension, if any. Case insensitive.
pub fn grammar_for_extension(ext: &str) -> Option<&'static Grammar> {
    let lower = ext.to_ascii_lowercase();
    let id = entries()
        .iter()
        .find(|e| e.extensions.contains(&lower.as_str()))
        .map(|e| e.id)?;
    grammars().iter().find(|g| g.id == id)
}

/// Extension of a repo-relative path, or None for an extensionless file.
/// A leading dot is a name, not an extension: `.gitignore` has none.
pub fn extension_of(path: &str) -> Option<&str> {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => Some(ext),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_kinds_stay_in_step() {
        assert_eq!(
            HIGHLIGHT_NAMES.len(),
            KIND_FOR_NAME.len(),
            "every highlight name needs a kind"
        );
    }

    #[test]
    fn every_grammar_compiles() {
        // The registry silently skips a grammar whose query is broken, which
        // is right at runtime and wrong to leave unnoticed in a test.
        assert_eq!(
            grammars().len(),
            entries().len(),
            "a grammar failed to compile: {:?} built of {:?}",
            grammars().iter().map(|g| g.name).collect::<Vec<_>>(),
            entries().iter().map(|e| e.name).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn language_ids_are_unique() {
        let mut ids: Vec<u32> = entries().iter().map(|e| e.id).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate language id");
    }

    #[test]
    fn extensions_are_claimed_once() {
        let mut seen: Vec<&str> = Vec::new();
        for e in entries() {
            for ext in e.extensions {
                assert!(!seen.contains(ext), "{ext} claimed twice");
                seen.push(ext);
            }
        }
    }

    #[test]
    fn extension_lookup_handles_paths_and_dotfiles() {
        assert_eq!(extension_of("src/main.rs"), Some("rs"));
        assert_eq!(extension_of("a/b/c.test.ts"), Some("ts"));
        assert_eq!(extension_of("Makefile"), None);
        assert_eq!(extension_of(".gitignore"), None);
        assert_eq!(extension_of("x/.env"), None);
    }

    #[test]
    fn common_extensions_resolve() {
        for (ext, name) in [
            ("rs", "rust"), ("RS", "rust"), ("py", "python"), ("ts", "typescript"),
            ("tsx", "tsx"), ("h", "c"), ("cuh", "cpp"), ("svelte", "html"),
            ("yml", "yaml"), ("md", "markdown"),
        ] {
            let g = grammar_for_extension(ext).unwrap_or_else(|| panic!("{ext} unresolved"));
            assert_eq!(g.name, name, "{ext}");
        }
        assert!(grammar_for_extension("unknownext").is_none());
    }
}
