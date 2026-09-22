// Tab expansion, so one column means one thing.
//
// The wire format counts columns with tabs expanded to the next stop: that is
// what `line_metrics` in crates/sanity-core/src/scan.rs measures a line's
// width with, and what the column in every span refers to. The text the canvas
// draws has to be in the same space, or a line with a tab in it is drawn from
// the wrong offset.
//
// It was not, and the result was the two bugs this file exists to stop. A line
// starting with one tab has its spans at column 4 while its characters start
// at index 1, so the renderer read three characters too far in: `COLOR_RED`
// came out as `OR_RED`. And because the glyph pass drew only what a span
// covered, the three characters it skipped were not drawn at all, so the line
// also looked as though it had spaces in it.

/** Columns a tab advances to. Mirrors `scan::TAB_WIDTH`. */
export const TAB_WIDTH = 4;

/**
 * The line as the canvas measures it: every tab replaced by spaces up to the
 * next stop, so a character index is a column.
 *
 * Returns the same string when there is nothing to do, which is almost every
 * line, so the common case allocates nothing.
 */
export function expandTabs(line: string): string {
  if (!line.includes('\t')) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const width = TAB_WIDTH - (col % TAB_WIDTH);
      out += ' '.repeat(width);
      col += width;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/** Every line of a file, expanded. Split on newlines, carriage returns
 *  dropped, since a line ending is not part of the line. */
export function expandLines(text: string): string[] {
  return text.split('\n').map((line) =>
    expandTabs(line.endsWith('\r') ? line.slice(0, -1) : line),
  );
}
