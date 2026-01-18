export interface FuzzyMatch {
  matches: boolean;
  score: number;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return { matches: true, score: 0 };
  if (q.length > t.length) return { matches: false, score: 0 };

  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  let consecutive = 0;

  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      const isBoundary = i === 0 || /[\s\-_./]/.test(t[i - 1]!);

      if (lastMatch === i - 1) {
        consecutive++;
        score -= consecutive * 5;
      } else {
        consecutive = 0;
        if (lastMatch >= 0) {
          score += (i - lastMatch - 1) * 2;
        }
      }

      if (isBoundary) score -= 10;

      score += i * 0.1;

      lastMatch = i;
      qi++;
    }
  }

  if (qi < q.length) return { matches: false, score: 0 };
  return { matches: true, score };
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
  if (!query.trim()) return items;

  const scored: Array<{ item: T; score: number }> = [];

  for (const item of items) {
    const match = fuzzyMatch(query, getText(item));
    if (match.matches) scored.push({ item, score: match.score });
  }

  scored.sort((a, b) => a.score - b.score);
  return scored.map((s) => s.item);
}
