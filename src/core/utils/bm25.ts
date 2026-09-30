export interface SearchDocument {
  id: string;
  text: string;
}

export interface SearchMatch {
  id: string;
  score: number;
}

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
]);

function stem(term: string): string {
  if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
  return term;
}

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && !STOP_WORDS.has(term))
    .map(stem);
}

export function rankBm25(
  query: string,
  documents: readonly SearchDocument[],
  limit: number,
): SearchMatch[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || documents.length === 0 || limit <= 0) return [];
  const counts = documents.map((document) => {
    const frequencies = new Map<string, number>();
    for (const term of tokenize(document.text)) {
      frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    }
    return frequencies;
  });
  const lengths = counts.map((frequencies) =>
    [...frequencies.values()].reduce((sum, count) => sum + count, 0),
  );
  const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
  const idf = new Map(
    terms.map((term) => {
      const frequency = counts.filter((frequencies) => frequencies.has(term)).length;
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))];
    }),
  );
  const matches: SearchMatch[] = [];
  documents.forEach((document, index) => {
    let score = 0;
    for (const term of terms) {
      const count = counts[index]!.get(term);
      if (!count) continue;
      const norm = 1.2 * (1 - 0.75 + (0.75 * lengths[index]!) / averageLength);
      score += idf.get(term)! * ((count * (1.2 + 1)) / (count + norm));
    }
    if (score > 0) matches.push({ id: document.id, score });
  });
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
