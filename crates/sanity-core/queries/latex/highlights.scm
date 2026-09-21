; Highlight query for LaTeX, written by hand.
;
; The grammar (latex-lsp, published as codebook-tree-sitter-latex) ships no
; query, so this is written against the node names and field names the grammar
; actually declares, read out of its node-types.json and checked against a real
; document with `cargo run -p sanity-core --example nodes -- latex <file>`.
; Measured on the 5300 lines of TeX in sane, where the grammar parses with no
; error regions at all.
;
; Coarse on purpose: the capture names here resolve against HIGHLIGHT_NAMES in
; lang.rs and collapse into twelve wire-format kinds, and at three pixels per
; line the useful distinctions are command against prose, comment against the
; rest, and where the mathematics is.

; A command is the active thing in a LaTeX document, so it reads as a call.
(command_name) @function

; Structure. These say what the document *is* rather than doing something in
; it, so they are keywords rather than just more commands.
[
  "\\documentclass"
  "\\usepackage"
  "\\RequirePackage"
  "\\begin"
  "\\end"
  "\\input"
  "\\include"
  "\\addbibresource"
  "\\bibliography"
  "\\newcommand"
  "\\renewcommand"
  "\\DeclareRobustCommand"
  "\\def"
  "\\newtheorem"
  "\\usetikzlibrary"
] @keyword

; The name of an environment, on both ends of it.
(begin name: (curly_group_text (text) @type))
(end name: (curly_group_text (text) @type))

; Labels, references and citations are names pointing at something else.
(label_definition name: (curly_group_label) @constant)
(label_reference names: (curly_group_label_list) @constant)
(citation keys: (curly_group_text_list) @constant)

; A file path is a literal.
(curly_group_path) @string
(curly_group_path_list) @string
(glob_pattern) @string

; Package and class options, and key-value groups generally.
(key_value_pair key: (text) @property)
(key_value_pair value: (value) @constant)

; The argument placeholders in a command definition, and their count.
(placeholder) @variable.parameter
(argc) @number

; Mathematics. The delimiters are marked rather than the whole formula: a paper
; is mostly prose with mathematics in it, and painting every formula one colour
; would say less than showing where each one starts and ends.
(inline_formula "$" @punctuation.special)
(displayed_equation "$$" @punctuation.special)
(math_delimiter left_command: _ @punctuation.special)
(math_delimiter right_command: _ @punctuation.special)

(operator) @operator
(superscript "^" @operator)
(subscript "_" @operator)

[
  "{"
  "}"
  "["
  "]"
] @punctuation.bracket

(line_comment) @comment
(block_comment) @comment
