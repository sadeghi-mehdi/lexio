export interface DocumentSearchMatch {
  page: number;
  occurrence: number;
}

export function findDocumentMatches(
  pageTexts: ReadonlyMap<number, string>,
  query: string,
  maximumMatches = 10000
): DocumentSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];

  const matches: DocumentSearchMatch[] = [];
  const pages = [...pageTexts.entries()].sort(([pageA], [pageB]) => pageA - pageB);
  for (const [page, text] of pages) {
    const haystack = text.toLocaleLowerCase();
    let offset = 0;
    let occurrence = 0;
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      matches.push({ page, occurrence });
      if (matches.length >= maximumMatches) return matches;
      occurrence++;
      offset = index + Math.max(1, needle.length);
    }
  }
  return matches;
}
