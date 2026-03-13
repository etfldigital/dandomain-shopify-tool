

## Plan: Page Sitemap, Better Matching, Inline Destination Search

### 1. Add page sitemap field — `parse-sitemap/index.ts`
- Add `pageSitemapUrl` to `ParseSitemapRequest` interface
- Add `'page'` to `SitemapUrl.type` union: `'product' | 'category' | 'page' | 'unknown'`
- Update `classifyUrl` to accept and pass through `'page'` as sourceType
- Destructure `pageSitemapUrl` from request body (line 107)
- Update validation (line 116): `if (!productSitemapUrl && !categorySitemapUrl && !pageSitemapUrl)`
- Add page sitemap parsing block after category block (after line 155), passing `'page'` as sourceType
- Add `pages` count to stats response (line 168)

### 2. Add page sitemap field — `RedirectsStep.tsx`
- Add `pageSitemapUrl` state (after line 256)
- Update `SitemapUrl` interface (line 78) to include `'page'` type
- Change grid from `md:grid-cols-2` to `md:grid-cols-3` (line 1004), add third input for page sitemap
- Update `fetchSitemaps` (line 453): validate `pageSitemapUrl`, send it in body
- Update localStorage persistence (lines 288-318) to include `pageSitemapUrl`
- Update "Hent sitemaps" disabled check (line 1028) to include `pageSitemapUrl`
- Update `handleReset` (line 853) to clear `pageSitemapUrl`
- Add page count to dandomain stats display (line 1082 area)
- Update toast description (line 488) to include pages count

### 3. Add Strategy 2.5 (handle matching) and Strategy 4.5 (fuzzy/Dice) — `match-redirects/index.ts`
- Add `'handle'` to `matched_by` union in `MatchedRedirect` interface (line 20)
- After Strategy 2 SKU match (line 437), add Strategy 2.5:
  - Extract clean slug via `extractProductNameFromSlug(slug)`, normalize it
  - Compare against each entity's Shopify handle (last segment after `/`)
  - Exact handle match → confidence 92, `matchedBy = 'handle'`
  - Partial containment (both > 5 chars) → confidence 75, `matchedBy = 'handle'`
- After Strategy 4 partial title match (line 493), add Strategy 4.5:
  - Dice coefficient (bigram overlap) between `normalizedName` and entity titles
  - Threshold ≥ 0.6, confidence = `Math.round(score * 80)`, `matchedBy = 'title'`
- Add `'handle'` to `matchedByStrategy` stats in response (line 636)

### 4. Update `matched_by` display in `RedirectsStep.tsx`
- Add handle display label (after line 1373): `{redirect.matched_by === 'handle' && 'Handle'}`

### 5. Inline mode for `ShopifyDestinationSearch`
- Add `inline?: boolean` prop to interface
- When `inline={true}`, render an input-like button as PopoverTrigger instead of icon button:
  - Full width, shows `currentValue` in mono text or placeholder "Søg produkt, kollektion..."
  - Search icon on left
- Keep existing icon-button mode as default (`inline={false}`)

### 6. Use inline search in redirect table
- Replace the `<Input>` + `<ShopifyDestinationSearch>` combo (lines 1314-1340) with:
  - Read-only text for `status === 'created'`
  - `<ShopifyDestinationSearch inline={true}>` for editable rows
  - Keep external link button

### Files changed
- `supabase/functions/parse-sitemap/index.ts` — page sitemap support
- `supabase/functions/match-redirects/index.ts` — handle + fuzzy matching strategies
- `src/components/wizard/steps/RedirectsStep.tsx` — page sitemap field, inline search, handle label
- `src/components/wizard/steps/ShopifyDestinationSearch.tsx` — inline mode

### Files NOT changed
- `create-redirects/index.ts`, upload logic, other steps

