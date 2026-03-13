/**
 * Client-side semantic URL redirect matcher.
 * 
 * Core rules:
 * 1. Products ONLY match to /products/ — NEVER to /collections/ or /pages/
 * 2. Categories ONLY match to /collections/ — NEVER to /products/ or /pages/
 * 3. Pages ONLY match to /pages/
 * 4. Matching is semantic (word-based), not string similarity
 * 5. Brand-only matches are capped at 30%
 * 6. Minimum 50% for auto-matching
 */

// ============================================
// TYPES
// ============================================

export type OldUrlType = 'product' | 'category' | 'page' | 'unknown';
export type ShopifyUrlType = 'product' | 'collection' | 'page';

export interface OldUrl {
  loc: string;
  type: OldUrlType;
  words: string[];
  slug: string;
  numericId: string | null;
}

export interface ShopifyDestination {
  id: string;
  type: ShopifyUrlType;
  title: string;
  handle: string;
  path: string;
  words: string[];
}

export interface MatchResult {
  oldUrl: string;
  oldType: OldUrlType;
  matchedDestination: ShopifyDestination | null;
  score: number;
  matchMethod: string;
  suggestions: Array<{ destination: ShopifyDestination; score: number }>;
}

// ============================================
// DANISH STOP WORDS (not meaningful for matching)
// ============================================

const STOP_WORDS = new Set([
  'og', 'i', 'til', 'med', 'for', 'den', 'det', 'de', 'en', 'et',
  'af', 'på', 'er', 'som', 'fra', 'eller', 'har', 'var', 'kan',
  'shop', 'html', 'asp', 'php', 'www', 'http', 'https',
  'the', 'and', 'or', 'of', 'in', 'to', 'a', 'an',
]);

// ============================================
// URL CLASSIFICATION
// ============================================

export function classifyOldUrl(path: string): OldUrlType {
  const lower = path.toLowerCase();
  // DanDomain product: ends with -NNNNp.html or -NNNNpN.html
  if (/-\d+p\d*\.html$/i.test(lower)) return 'product';
  // DanDomain category: ends with -NNNNc1.html or -NNNNcN.html or -NNNNsN.html
  if (/-\d+[cs]\d*\.html$/i.test(lower)) return 'category';
  // Shopify-style
  if (lower.includes('/products/')) return 'product';
  if (lower.includes('/collections/')) return 'category';
  if (lower.includes('/pages/')) return 'page';
  return 'unknown';
}

function getCompatibleShopifyType(oldType: OldUrlType): ShopifyUrlType | null {
  switch (oldType) {
    case 'product': return 'product';
    case 'category': return 'collection';
    case 'page': return 'page';
    default: return null;
  }
}

// ============================================
// WORD EXTRACTION
// ============================================

/** Normalize Danish characters for comparison */
function normalizeDanish(text: string): string {
  return text
    .toLowerCase()
    .replace(/[æ]/g, 'ae')
    .replace(/[ø]/g, 'oe')
    .replace(/[å]/g, 'aa')
    .replace(/ü/g, 'ue')
    .replace(/ö/g, 'oe')
    .replace(/ä/g, 'ae')
    .replace(/ß/g, 'ss');
}

/** Extract meaningful words from a DanDomain URL slug */
export function extractWordsFromOldUrl(path: string): { words: string[]; slug: string; numericId: string | null } {
  // Remove path prefix and extension
  let slug = path
    .replace(/^\/shop\//, '')
    .replace(/^\//, '')
    .replace(/\.html$/i, '')
    .replace(/\.asp$/i, '')
    .replace(/\.php$/i, '');

  // Extract and remove the numeric ID suffix (e.g., -47516p, -178c1)
  let numericId: string | null = null;
  const idMatch = slug.match(/-(\d+)[pcs]\d*$/i);
  if (idMatch) {
    numericId = idMatch[1];
    slug = slug.replace(/-\d+[pcs]\d*$/i, '');
  }

  // Split by hyphens and underscores
  const parts = slug.split(/[-_]+/).filter(Boolean);

  // Filter out stop words, pure numbers, and very short tokens
  const words = parts
    .map(p => normalizeDanish(p))
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  return { words, slug, numericId };
}

/** Extract meaningful words from a Shopify entity title or handle */
export function extractWordsFromShopifyEntity(title: string, handle: string): string[] {
  // Combine title and handle for richer word extraction
  const titleWords = title
    .split(/[\s\-_,./]+/)
    .filter(Boolean)
    .map(w => normalizeDanish(w))
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  const handleWords = handle
    .split(/[-_]+/)
    .filter(Boolean)
    .map(w => normalizeDanish(w))
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  // Deduplicate
  const allWords = new Set([...titleWords, ...handleWords]);
  return Array.from(allWords);
}

// ============================================
// SCORING
// ============================================

/** 
 * Calculate semantic match score between old URL words and Shopify entity words.
 * Returns 0-100.
 * 
 * Rules:
 * - Exact word matches count fully
 * - Partial word matches (substring) count 50%
 * - Brand-only match (first word) capped at 30%
 * - Full match = 100%
 */
function calculateScore(oldWords: string[], shopifyWords: string[]): number {
  if (oldWords.length === 0 || shopifyWords.length === 0) return 0;

  let matchedOldWords = 0;
  let partialMatches = 0;
  const matchedIndices = new Set<number>();

  for (const oldWord of oldWords) {
    let bestMatch = 0;
    for (let i = 0; i < shopifyWords.length; i++) {
      if (matchedIndices.has(i)) continue;
      const shopWord = shopifyWords[i];

      if (oldWord === shopWord) {
        bestMatch = 1;
        matchedIndices.add(i);
        break;
      }

      // Partial match: one contains the other
      if (oldWord.length >= 3 && shopWord.length >= 3) {
        if (oldWord.includes(shopWord) || shopWord.includes(oldWord)) {
          if (bestMatch < 0.5) {
            bestMatch = 0.5;
            // Don't mark as used for partial — allow reuse
          }
        }
      }
    }

    if (bestMatch >= 1) {
      matchedOldWords++;
    } else if (bestMatch > 0) {
      partialMatches += bestMatch;
    }
  }

  const totalMatchValue = matchedOldWords + partialMatches;
  const maxPossible = Math.max(oldWords.length, shopifyWords.length);
  let rawScore = (totalMatchValue / maxPossible) * 100;

  // Brand-only cap: if only the first word (likely brand) matched and nothing else,
  // cap at 30%
  if (oldWords.length >= 2 && matchedOldWords === 1 && partialMatches === 0) {
    // Check if the match was only the first word (brand)
    const firstWordMatches = shopifyWords.some(sw => sw === oldWords[0] || sw.includes(oldWords[0]) || oldWords[0].includes(sw));
    const otherWordsMatch = oldWords.slice(1).some(ow => 
      shopifyWords.some(sw => sw === ow || (ow.length >= 3 && sw.length >= 3 && (sw.includes(ow) || ow.includes(sw))))
    );
    
    if (firstWordMatches && !otherWordsMatch) {
      rawScore = Math.min(rawScore, 30);
    }
  }

  return Math.round(Math.min(100, Math.max(0, rawScore)));
}

// ============================================
// MAIN MATCHER
// ============================================

export interface MatcherOptions {
  autoApproveThreshold?: number; // Default 80
  reviewThreshold?: number;      // Default 50
  maxSuggestions?: number;       // Default 3
}

/**
 * Match a list of old DanDomain URLs to Shopify destinations.
 * Enforces strict type safety: products→products, categories→collections.
 */
export function matchUrls(
  oldUrls: Array<{ loc: string; type: OldUrlType }>,
  shopifyDestinations: ShopifyDestination[],
  options: MatcherOptions = {}
): MatchResult[] {
  const {
    maxSuggestions = 3,
  } = options;

  // Index destinations by type for fast lookup
  const destByType: Record<ShopifyUrlType, ShopifyDestination[]> = {
    product: shopifyDestinations.filter(d => d.type === 'product'),
    collection: shopifyDestinations.filter(d => d.type === 'collection'),
    page: shopifyDestinations.filter(d => d.type === 'page'),
  };

  const results: MatchResult[] = [];

  for (const oldUrl of oldUrls) {
    const { words, slug, numericId } = extractWordsFromOldUrl(oldUrl.loc);

    // Determine which Shopify type to match against
    const targetType = getCompatibleShopifyType(oldUrl.type);

    if (!targetType || words.length === 0) {
      results.push({
        oldUrl: oldUrl.loc,
        oldType: oldUrl.type,
        matchedDestination: null,
        score: 0,
        matchMethod: 'none',
        suggestions: [],
      });
      continue;
    }

    const candidates = destByType[targetType];
    if (!candidates || candidates.length === 0) {
      results.push({
        oldUrl: oldUrl.loc,
        oldType: oldUrl.type,
        matchedDestination: null,
        score: 0,
        matchMethod: 'no_candidates',
        suggestions: [],
      });
      continue;
    }

    // Score all candidates
    const scored: Array<{ destination: ShopifyDestination; score: number; method: string }> = [];

    for (const dest of candidates) {
      let score = calculateScore(words, dest.words);
      let method = 'semantic';

      // Bonus: if the normalized slug exactly matches the handle
      const normalizedSlug = normalizeDanish(slug);
      const normalizedHandle = normalizeDanish(dest.handle);
      if (normalizedSlug === normalizedHandle) {
        score = Math.max(score, 98);
        method = 'exact_handle';
      } else if (normalizedHandle.includes(normalizedSlug) || normalizedSlug.includes(normalizedHandle)) {
        // Partial handle match bonus
        const overlapRatio = Math.min(normalizedSlug.length, normalizedHandle.length) / 
                            Math.max(normalizedSlug.length, normalizedHandle.length);
        if (overlapRatio > 0.7) {
          score = Math.max(score, Math.round(overlapRatio * 95));
          method = 'handle_overlap';
        }
      }

      if (score > 0) {
        scored.push({ destination: dest, score, method });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const bestMatch = scored[0] || null;
    const suggestions = scored
      .slice(0, maxSuggestions)
      .map(s => ({ destination: s.destination, score: s.score }));

    results.push({
      oldUrl: oldUrl.loc,
      oldType: oldUrl.type,
      matchedDestination: bestMatch ? bestMatch.destination : null,
      score: bestMatch ? bestMatch.score : 0,
      matchMethod: bestMatch ? bestMatch.method : 'none',
      suggestions,
    });
  }

  return results;
}

/**
 * Build ShopifyDestination objects from database entities.
 */
export function buildShopifyDestinations(entities: Array<{
  id: string;
  type: ShopifyUrlType;
  title: string;
  handle: string;
  path: string;
}>): ShopifyDestination[] {
  return entities.map(e => ({
    ...e,
    words: extractWordsFromShopifyEntity(e.title, e.handle),
  }));
}
