export function findEditorMatches(text: string, query: string): number[] {
  if (!query) return [];
  const positions: number[] = [];
  let offset = 0;
  while (positions.length < 1000) {
    const found = text.indexOf(query, offset);
    if (found < 0) break;
    positions.push(found);
    offset = found + query.length;
  }
  return positions;
}
