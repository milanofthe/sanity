; The HTML half of a PHP file, copied from tree-sitter-php 0.24.2's
; queries/injections-text.scm, which the crate ships but does not export.
;
; LANGUAGE_PHP parses everything outside `<?php ... ?>` as `text` nodes and
; leaves them there, so without this a template, which is most of the PHP in
; the wild, is coloured only between its tags. `combined` hands every text
; node to one HTML parse, so an element opened before a `<?php` block and
; closed after it is still one element.

((text) @injection.content
 (#set! injection.language "html")
 (#set! injection.combined))
