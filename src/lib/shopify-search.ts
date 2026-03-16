export interface SearchableEntity {
  title: string;
  handle: string;
}

export function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeForSearch(query);
  if (!normalized) return [];

  return Array.from(new Set(normalized.split(/\s+/).filter((token) => token.length >= 2)));
}

export function matchesEntityQuery(entity: SearchableEntity, query: string): boolean {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) return true;

  const title = normalizeForSearch(entity.title);
  const handle = normalizeForSearch(entity.handle.replace(/-/g, ' '));

  return tokens.every((token) => title.includes(token) || handle.includes(token));
}

export function getEntityQueryMatchStats(entity: SearchableEntity, query: string): {
  totalTokens: number;
  matchedTokens: number;
  matchRatio: number;
  fullMatch: boolean;
} {
  const tokens = tokenizeSearchQuery(query);
  if (tokens.length === 0) {
    return {
      totalTokens: 0,
      matchedTokens: 0,
      matchRatio: 0,
      fullMatch: false,
    };
  }

  const title = normalizeForSearch(entity.title);
  const handle = normalizeForSearch(entity.handle.replace(/-/g, ' '));

  const matchedTokens = tokens.reduce((count, token) => {
    if (title.includes(token) || handle.includes(token)) {
      return count + 1;
    }
    return count;
  }, 0);

  const matchRatio = matchedTokens / tokens.length;

  return {
    totalTokens: tokens.length,
    matchedTokens,
    matchRatio,
    fullMatch: matchedTokens === tokens.length,
  };
}
