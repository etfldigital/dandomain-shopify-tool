import { getEntityQueryMatchStats, matchesEntityQuery } from '@/lib/shopify-search';

/**
 * Client-side semantic URL redirect matcher.
 * 
 * Core rules:
 * 1. Products ONLY match to /products/ — NEVER to /collections/ or /pages/
 * 2. Categories ONLY match to /collections/ — NEVER to /products/ or /pages/
 * 3. Pages ONLY match to /pages/
 * 4. Matching is semantic (word-based), not string similarity
 * 5. Brand-only matches are capped at 30%
 * 6. Minimum 30% for showing suggestions (low-confidence marked visually)
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

export interface OldUrlInput {
  loc: string;
  type: OldUrlType;
  productTitle?: string | null;
  productVendorWords?: string[];
}

export interface ShopifyDestination {
  id: string;
  type: ShopifyUrlType;
  title: string;
  handle: string;
  path: string;
  words: string[];
  vendorWords?: string[];
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
// WORD EXTRACTION & NORMALIZATION
// ============================================

/** Normalize Danish/German characters for comparison */
export function normalizeDanish(text: string): string {
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

/**
 * Get a stemmed version of a Danish/English word for fuzzy matching.
 * Strips common suffixes to match plurals, verb forms, etc.
 */
function stemWord(word: string): string {
  if (word.length < 4) return word;
  // Danish plural/inflection suffixes
  return word
    .replace(/erne$/i, '')
    .replace(/erne$/i, '')
    .replace(/inger$/i, 'ing')
    .replace(/elser$/i, 'else')
    .replace(/(er|en|et|ne|re|se|te|de)$/i, '')
    .replace(/s$/i, '');
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

function extractVendorWords(vendor: string | null | undefined): string[] {
  if (!vendor) return [];

  return Array.from(new Set(
    normalizeDanish(vendor)
      .split(/[\s\-_,./]+/)
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
  ));
}

function getProductTitleContext(
  productTitle: string | null | undefined,
  productVendorWords: string[] | undefined,
  knownBrands?: Set<string>
): {
  tokens: string[];
  searchQuery: string;
  brandStripped: boolean;
  strippedBrand: string | null;
} | null {
  if (!productTitle || !productTitle.trim()) return null;

  const titleTokens = normalizeDanish(productTitle)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));

  if (titleTokens.length === 0) return null;

  const vendorWords = Array.from(new Set((productVendorWords || []).map(normalizeDanish)));

  let stripCount = 0;
  let strippedBrand: string | null = null;

  if (vendorWords.length > 0 && titleTokens.length >= vendorWords.length) {
    const startsWithVendor = vendorWords.every((word, idx) => titleTokens[idx] === word);
    if (startsWithVendor) {
      stripCount = vendorWords.length;
      strippedBrand = vendorWords.join(' ');
    }
  }

  if (stripCount === 0 && knownBrands && knownBrands.size > 0) {
    while (stripCount < titleTokens.length && knownBrands.has(titleTokens[stripCount])) {
      stripCount += 1;
    }
    if (stripCount > 0) {
      strippedBrand = titleTokens.slice(0, stripCount).join(' ');
    }
  }

  const remaining = titleTokens.slice(stripCount);
  const tokens = remaining.length > 0 ? remaining : titleTokens;

  return {
    tokens,
    searchQuery: tokens.join(' '),
    brandStripped: stripCount > 0,
    strippedBrand,
  };
}

// ============================================
// SCORING
// ============================================

/** 
 * Calculate semantic match score between old URL words and Shopify entity words.
 * Returns 0-100.
 * 
 * Improved rules:
 * - Exact word matches count fully
 * - Stemmed matches count 80%
 * - Partial word matches (substring ≥4 chars) count 60%
 * - Score denominator uses old word count (not max) so long Shopify titles don't penalize
 * - Brand-only match capped at 30%
 */
function calculateScore(oldWords: string[], shopifyWords: string[]): number {
  if (oldWords.length === 0 || shopifyWords.length === 0) return 0;

  const shopifyStemmed = shopifyWords.map(w => stemWord(w));
  let totalMatchValue = 0;
  let exactMatches = 0;
  const matchedShopifyIndices = new Set<number>();

  for (const oldWord of oldWords) {
    let bestMatch = 0;
    let bestIdx = -1;
    const oldStem = stemWord(oldWord);

    for (let i = 0; i < shopifyWords.length; i++) {
      if (matchedShopifyIndices.has(i)) continue;
      const shopWord = shopifyWords[i];
      const shopStem = shopifyStemmed[i];

      // Exact match
      if (oldWord === shopWord) {
        bestMatch = 1;
        bestIdx = i;
        break;
      }

      // Stemmed match (e.g., "stroempebuker" ≈ "strompebukser")
      if (oldStem.length >= 3 && shopStem.length >= 3 && oldStem === shopStem) {
        if (bestMatch < 0.8) {
          bestMatch = 0.8;
          bestIdx = i;
        }
        continue;
      }

      // Partial match: one contains the other (minimum 4 chars)
      if (oldWord.length >= 4 && shopWord.length >= 4) {
        if (oldWord.includes(shopWord) || shopWord.includes(oldWord)) {
          const overlapLen = Math.min(oldWord.length, shopWord.length);
          const maxLen = Math.max(oldWord.length, shopWord.length);
          const partialScore = 0.4 + 0.4 * (overlapLen / maxLen); // 0.4-0.8 range
          if (bestMatch < partialScore) {
            bestMatch = partialScore;
            bestIdx = i;
          }
        }
      }

      // Stem-substring match
      if (oldStem.length >= 3 && shopStem.length >= 3) {
        if (oldStem.includes(shopStem) || shopStem.includes(oldStem)) {
          const partialScore = 0.5;
          if (bestMatch < partialScore) {
            bestMatch = partialScore;
            bestIdx = i;
          }
        }
      }
    }

    if (bestMatch >= 1) exactMatches++;
    if (bestIdx >= 0 && bestMatch >= 0.6) matchedShopifyIndices.add(bestIdx);
    totalMatchValue += bestMatch;
  }

  // Use old word count as denominator — if 2/3 old words match, that's 66% regardless of 
  // how many words the Shopify title has
  const denominator = oldWords.length;
  let rawScore = (totalMatchValue / denominator) * 100;

  // Slight penalty if Shopify entity has many more words (less specific match)
  if (shopifyWords.length > oldWords.length * 2) {
    rawScore *= 0.9;
  }

  // Brand-only cap: if only the first word matched and nothing else meaningful
  if (oldWords.length >= 2 && exactMatches <= 1 && totalMatchValue < 1.5) {
    const firstWordMatches = shopifyWords.some(sw => 
      sw === oldWords[0] || stemWord(sw) === stemWord(oldWords[0]) ||
      (oldWords[0].length >= 4 && sw.length >= 4 && (sw.includes(oldWords[0]) || oldWords[0].includes(sw)))
    );
    const anyOtherMatch = oldWords.slice(1).some(ow => 
      shopifyWords.some(sw => {
        if (sw === ow) return true;
        if (stemWord(sw) === stemWord(ow) && stemWord(ow).length >= 3) return true;
        if (ow.length >= 4 && sw.length >= 4 && (sw.includes(ow) || ow.includes(sw))) return true;
        return false;
      })
    );
    
    if (firstWordMatches && !anyOtherMatch) {
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
  reviewThreshold?: number;      // Default 30 (lowered from 50)
  maxSuggestions?: number;       // Default 3
  /**
   * Map of normalized brand/vendor words to strip from old product URLs before matching.
   * Key: old URL path (lowercase), Value: array of normalized brand words.
   * Only applies to product URLs — categories are matched as-is.
   */
  brandWordsMap?: Map<string, string[]>;
  /**
   * Set of all known brand names (normalized words) across the project.
   * Used as fallback when a specific URL isn't in brandWordsMap — 
   * the first word(s) of the old URL are checked against this set.
   */
  knownBrands?: Set<string>;
}

/**
 * Match a list of old DanDomain URLs to Shopify destinations.
 * Enforces strict type safety: products→products, categories→collections.
 * 
 * Uses a two-pass strategy:
 * 1. First pass: direct semantic matching
 * 2. Second pass: brand-first matching for unmatched URLs
 */
export function matchUrls(
  oldUrls: OldUrlInput[],
  shopifyDestinations: ShopifyDestination[],
  options: MatcherOptions = {}
): MatchResult[] {
  const {
    maxSuggestions = 3,
    brandWordsMap,
    knownBrands,
  } = options;

  // Index destinations by type for fast lookup
  const destByType: Record<ShopifyUrlType, ShopifyDestination[]> = {
    product: shopifyDestinations.filter(d => d.type === 'product'),
    collection: shopifyDestinations.filter(d => d.type === 'collection'),
    page: shopifyDestinations.filter(d => d.type === 'page'),
  };

  // Build brand index: first word → list of destinations containing that word
  const brandIndex: Record<string, Map<ShopifyUrlType, ShopifyDestination[]>> = {};
  for (const dest of shopifyDestinations) {
    for (const word of dest.words) {
      if (!brandIndex[word]) brandIndex[word] = new Map();
      const typeList = brandIndex[word].get(dest.type) || [];
      typeList.push(dest);
      brandIndex[word].set(dest.type, typeList);
    }
  }

  const results: MatchResult[] = [];

  for (const oldUrl of oldUrls) {
    const { words, slug } = extractWordsFromOldUrl(oldUrl.loc);

    // Determine which Shopify type to match against
    const targetType = getCompatibleShopifyType(oldUrl.type);

    const productTitleContext = oldUrl.type === 'product'
      ? getProductTitleContext(oldUrl.productTitle, oldUrl.productVendorWords, knownBrands)
      : null;

    // === Primary matching words and query ===
    let wordsToMatch = productTitleContext?.tokens?.length ? productTitleContext.tokens : words;
    let searchQuery = productTitleContext?.searchQuery || wordsToMatch.join(' ');
    let brandStripped = Boolean(productTitleContext?.brandStripped);
    let strippedBrand: string | null = productTitleContext?.strippedBrand || null;

    // Fallback brand stripping from URL slug when XML title context is unavailable
    if (oldUrl.type === 'product' && !productTitleContext) {
      const normalizedPath = oldUrl.loc.toLowerCase();

      if (brandWordsMap) {
        const brandWords = brandWordsMap.get(normalizedPath);
        if (brandWords && brandWords.length > 0) {
          const brandSet = new Set(brandWords);
          const filtered = words.filter(w => !brandSet.has(w));
          if (filtered.length > 0) {
            wordsToMatch = filtered;
            searchQuery = filtered.join(' ');
            brandStripped = true;
            strippedBrand = brandWords.join(' ');
          }
        }
      }

      if (!brandStripped && knownBrands && words.length >= 2) {
        const firstWord = words[0];
        if (knownBrands.has(firstWord)) {
          wordsToMatch = words.slice(1);
          searchQuery = wordsToMatch.join(' ');
          brandStripped = true;
          strippedBrand = firstWord;
        }
      }
    }

    if (!targetType || wordsToMatch.length === 0) {
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

    const scored: Array<{ destination: ShopifyDestination; score: number; method: string }> = [];

    const brandWord = wordsToMatch[0];
    const brandCandidates = brandWord ? (brandIndex[brandWord]?.get(targetType) || []) : [];

    const candidateSet = new Set<ShopifyDestination>();
    for (const c of brandCandidates) candidateSet.add(c);
    for (const c of candidates) candidateSet.add(c);

    let candidatePool = Array.from(candidateSet);

    // Brand-first narrowing for products when vendor info exists
    if (oldUrl.type === 'product' && oldUrl.productVendorWords && oldUrl.productVendorWords.length > 0) {
      const vendorSet = new Set(oldUrl.productVendorWords.map(normalizeDanish));
      const vendorMatches = candidatePool.filter(dest =>
        (dest.vendorWords || []).some(vw => vendorSet.has(vw))
      );
      if (vendorMatches.length > 0) {
        candidatePool = vendorMatches;
      }
    }

    for (const dest of candidatePool) {
      let score = calculateScore(wordsToMatch, dest.words);
      let method = brandStripped ? 'semantic_brand_stripped' : 'semantic';

      // Apply the same token logic as manual search for auto-match scoring
      if (searchQuery) {
        const queryStats = getEntityQueryMatchStats({ title: dest.title, handle: dest.handle }, searchQuery);

        if (queryStats.totalTokens > 0) {
          const overlapScore = Math.round(queryStats.matchRatio * 100);
          if (overlapScore > score) {
            score = overlapScore;
            method = 'query_overlap';
          }

          if (queryStats.fullMatch && queryStats.totalTokens >= 2) {
            const fullQueryScore = brandStripped ? 92 : 86;
            if (fullQueryScore > score) {
              score = fullQueryScore;
              method = brandStripped ? 'query_full_brand_stripped' : 'query_full';
            }
          } else if (brandStripped && queryStats.matchedTokens >= 2 && queryStats.matchRatio >= 0.5) {
            const boostedScore = Math.max(overlapScore, 80);
            if (boostedScore > score) {
              score = boostedScore;
              method = 'query_brand_stripped_overlap';
            }
          }
        }

        if (matchesEntityQuery({ title: dest.title, handle: dest.handle }, searchQuery)) {
          const strictQueryScore = brandStripped ? 93 : 88;
          if (strictQueryScore > score) {
            score = strictQueryScore;
            method = brandStripped ? 'query_manual_equivalent_brand_stripped' : 'query_manual_equivalent';
          }
        }
      }

      // If brand was stripped and score is decent, boost it — this is expected in migrated data
      if (brandStripped && score >= 40) {
        score = Math.max(score, Math.min(score + 15, 95));
        if (method === 'semantic' || method === 'semantic_brand_stripped') {
          method = 'brand_stripped';
        }
      }

      // Also try with original URL words in case Shopify title retained some brand context
      if (brandStripped) {
        const fullScore = calculateScore(words, dest.words);
        if (fullScore > score) {
          score = fullScore;
          method = 'semantic';
        }
      }

      // Bonus: if the normalized slug exactly matches the handle
      const normalizedSlug = normalizeDanish(slug);
      const normalizedHandle = normalizeDanish(dest.handle);
      if (normalizedSlug.length >= 3) {
        if (normalizedSlug === normalizedHandle) {
          score = Math.max(score, 98);
          method = 'exact_handle';
        } else if (normalizedHandle.includes(normalizedSlug) || normalizedSlug.includes(normalizedHandle)) {
          const overlapRatio = Math.min(normalizedSlug.length, normalizedHandle.length) /
            Math.max(normalizedSlug.length, normalizedHandle.length);
          if (overlapRatio > 0.6) {
            const handleScore = Math.round(overlapRatio * 95);
            if (handleScore > score) {
              score = handleScore;
              method = 'handle_overlap';
            }
          }
        }
      }

      // Also try brand-stripped slug against handle
      if (brandStripped && strippedBrand) {
        const strippedSlug = normalizeDanish(slug).replace(new RegExp(`^${normalizeDanish(strippedBrand).replace(/[^a-z0-9]/g, '[-]?')}[-]?`), '');
        if (strippedSlug.length >= 3) {
          if (normalizedHandle === strippedSlug) {
            score = Math.max(score, 96);
            method = 'handle_brand_stripped';
          } else if (normalizedHandle.includes(strippedSlug) || strippedSlug.includes(normalizedHandle)) {
            const overlapRatio = Math.min(strippedSlug.length, normalizedHandle.length) /
              Math.max(strippedSlug.length, normalizedHandle.length);
            if (overlapRatio > 0.5) {
              const handleScore = Math.round(overlapRatio * 95);
              if (handleScore > score) {
                score = handleScore;
                method = 'handle_brand_stripped';
              }
            }
          }
        }
      }

      if (score > 0) {
        scored.push({ destination: dest, score, method });
      }
    }

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
