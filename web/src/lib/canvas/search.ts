// Matching a typed query against file paths, as one pure function.
//
// Here rather than in the component because what counts as a match and what
// counts as a better match are two different judgements, both easy to get
// subtly wrong, and both worth stating in tests rather than trying out by
// typing. The ranking in particular: with a thousand files, "app" matches a
// hundred paths, and which one Enter should fly to is the whole question.
//
// Three tiers, in order. A hit in the file's own name beats a hit anywhere in
// its directories, because that is what someone typing a name means, and a run
// of consecutive characters beats the same characters scattered through the
// name, because that is what someone typing a fragment means. Within a tier
// the earlier and shorter match wins.
//
// There was a fourth tier, the query scattered through the whole path, and it
// is gone on the evidence. Measured over the 988 files of a real project:
// "renderer" matched 15 of them, all through that tier, in a project that has
// no renderer, and the best of the 15 was a report.md in an examples folder.
// It never once changed the top match for a query that had a real one, and it
// turned "found nothing" into fifteen highlights that mean nothing. A search
// that highlights has to be able to say no.

/** Lower is better. A path that does not match at all scores `null`. */
export type Score = number | null;

const NAME_RUN = 0;
const PATH_RUN = 1000;
const NAME_GAPS = 2000;

/**
 * Where a subsequence of `q` sits in `s`, as the span it covers, or -1.
 *
 * The span rather than merely "found": `sr` in `search.ts` covers two
 * characters and in `src/renderer/scene.ts` it covers twenty, and the first is
 * much more likely to be what was meant.
 */
function subsequence(q: string, s: string): number {
  let i = 0;
  let first = -1;
  for (let k = 0; k < s.length && i < q.length; k++) {
    if (s[k] !== q[i]) continue;
    if (first < 0) first = k;
    i++;
    if (i === q.length) return k - first + 1;
  }
  return -1;
}

/**
 * How well `path` matches `query`. Case is ignored; a leading or trailing
 * space is not part of the query.
 *
 * The fractional terms are tie-breaks inside a tier and are deliberately small
 * enough that they cannot promote a path from one tier to another: position
 * counts for at most a tenth of a tier and length for at most a hundredth.
 */
export function score(query: string, path: string): Score {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const p = path.toLowerCase();
  const cut = p.lastIndexOf('/') + 1;
  const name = p.slice(cut);

  const inName = name.indexOf(q);
  if (inName >= 0) return NAME_RUN + inName * 0.1 + name.length * 0.01;

  const inPath = p.indexOf(q);
  if (inPath >= 0) return PATH_RUN + inPath * 0.1 + p.length * 0.01;

  const nameSpan = subsequence(q, name);
  if (nameSpan >= 0) return NAME_GAPS + nameSpan * 0.1 + name.length * 0.01;

  return null;
}

export interface Ranked {
  path: string;
  score: number;
}

/**
 * Every path that matches, best first.
 *
 * Ties break on the path itself so the order is the same on every keystroke:
 * without that, two files with identical scores could swap places between
 * renders and Enter would fly somewhere else than the highlight suggested.
 */
export function rank(query: string, paths: Iterable<string>): Ranked[] {
  const out: Ranked[] = [];
  for (const path of paths) {
    const s = score(query, path);
    if (s !== null) out.push({ path, score: s });
  }
  out.sort((a, b) => a.score - b.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
