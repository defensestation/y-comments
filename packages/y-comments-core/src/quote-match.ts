export interface QuoteMatch {
  start: number;
  end: number;
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) {
    n++;
  }
  return n;
}

function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) {
    n++;
  }
  return n;
}

/**
 * Find `quote` in `text`. If it occurs more than once, score each occurrence
 * by how much of the stored `prefix`/`suffix` context matches its
 * surroundings (longest common suffix of prefix + longest common prefix of
 * suffix) and require a unique best match. Ambiguity is treated as not
 * found — we never guess between candidate locations.
 *
 * Exact matching only; fuzzy matching (edit distance) is a deliberate
 * non-goal for v2.0. This function is the seam where it would slot in.
 */
export function findQuote(
  text: string,
  quote: string,
  prefix: string,
  suffix: string
): QuoteMatch | null {
  if (quote.length === 0) {
    return null;
  }
  const occurrences: number[] = [];
  let i = text.indexOf(quote);
  while (i !== -1) {
    occurrences.push(i);
    i = text.indexOf(quote, i + 1);
  }
  if (occurrences.length === 0) {
    return null;
  }
  if (occurrences.length === 1) {
    return { start: occurrences[0], end: occurrences[0] + quote.length };
  }

  let best = -1;
  let bestScore = -1;
  let tied = false;
  for (const start of occurrences) {
    const before = text.slice(Math.max(0, start - prefix.length), start);
    const after = text.slice(start + quote.length, start + quote.length + suffix.length);
    const score = commonSuffixLen(prefix, before) + commonPrefixLen(suffix, after);
    if (score > bestScore) {
      bestScore = score;
      best = start;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }
  if (tied) {
    return null;
  }
  return { start: best, end: best + quote.length };
}
