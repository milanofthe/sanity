; Injection query for Markdown, replacing the one the grammar ships.
;
; The only change is `injection.include-children` on the inline pattern, and
; without it the whole feature does nothing: in tree-sitter-md a paragraph is
; an `(inline)` node whose emphasis and code-span delimiters are children of
; it in the *block* grammar, and injections exclude a content node's children
; by default. So the inline grammar was handed the prose with the markup cut
; out of it and captured nothing. Measured: 0.7 percent of characters coloured
; before, and the injection callback was being asked for `markdown_inline` the
; whole time, which is what made this hard to see.
;
; The rest is the shipped query, kept so replacing it loses nothing.

((inline) @injection.content
  (#set! injection.language "markdown_inline")
  (#set! injection.include-children))

(fenced_code_block
  (info_string
    (language) @injection.language)
  (code_fence_content) @injection.content)

((html_block) @injection.content
  (#set! injection.language "html"))

((minus_metadata) @injection.content
  (#set! injection.language "yaml"))

((plus_metadata) @injection.content
  (#set! injection.language "toml"))
