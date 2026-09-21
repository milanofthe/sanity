// Substring search over file text, in the browser.
//
// The mirror of `find_in_text` in crates/sanity-core/src/find.rs, which is
// where a real repository is searched: the backend has the files, reads 18
// megabytes in 7 milliseconds and never has to hold them. This copy exists for
// the cases where there is no backend, which are the fixtures the checks run
// against and a future web demo, and it has the same test cases as the Rust
// side so the two cannot drift into disagreeing about what a hit is.

/** Hits in one file: line and column pairs, flattened. */
export interface FileHits {
  path: string;
  /** Two numbers per hit, line then column, both counting from zero. */
  at: number[];
  /** Hits past the per-file cap. */
  more: number;
}

/**
 * Every hit for `needleLower` in `text`, up to `cap` of them.
 *
 * Case insensitive over ASCII only, matching the Rust side: folding the rest
 * correctly needs a table, these are source files, and a wrong fold is worse
 * than none.
 */
export function findInText(
  text: string, needleLower: string, cap: number,
): { at: number[]; more: number } {
  const at: number[] = [];
  let more = 0;
  if (!needleLower) return { at, more };

  const lines = text.split('\n');
  for (let line = 0; line < lines.length; line++) {
    // A trailing carriage return is not part of the line, and a hit on the
    // last column would otherwise be off by one on Windows files.
    const raw = lines[line];
    const s = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (s.length < needleLower.length) continue;
    const lower = s.toLowerCase();
    let from = 0;
    for (;;) {
      const found = lower.indexOf(needleLower, from);
      if (found < 0) break;
      if (at.length / 2 < cap) at.push(line, found);
      else more++;
      // Non-overlapping, like the Rust side: "aa" in "aaa" is one hit.
      from = found + needleLower.length;
    }
  }
  return { at, more };
}

/** The same over a set of files, skipping those with no hit. */
export function findInTexts(
  texts: Iterable<[string, string]>, query: string, cap: number,
): FileHits[] {
  const needle = query.toLowerCase();
  const out: FileHits[] = [];
  if (!needle) return out;
  for (const [path, text] of texts) {
    const { at, more } = findInText(text, needle, cap);
    if (at.length > 0) out.push({ path, at, more });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** Hits counted across files: what is shown, and what there is. */
export function countHits(files: FileHits[]): { shown: number; total: number } {
  let shown = 0;
  let total = 0;
  for (const f of files) {
    shown += f.at.length / 2;
    total += f.at.length / 2 + f.more;
  }
  return { shown, total };
}
