

## Plan: Fix Redirect Destination URLs and Category Matching

### Problem
Collections get wrong Shopify URLs (e.g., `/collections/Dear Denier` with spaces) because `shopify_tag` is used as the handle instead of the actual Shopify-generated handle. Category source paths also don't match DanDomain sitemap URL formats.

### Changes

**1. Database migration**
Add `shopify_handle` column to `canonical_categories`:
```sql
ALTER TABLE canonical_categories ADD COLUMN IF NOT EXISTS shopify_handle text;
```

**2. `supabase/functions/shopify-upload/index.ts` — Store Shopify handle for collections**
- Change `existingCollections` map from `Map<string, string>` to `Map<string, { id: string; handle: string }>`, storing both `col.id` and `col.handle` from the Shopify response
- When matching an existing collection (line 1870-1876): save `shopify_handle` alongside `shopify_collection_id`
- When creating a new collection (line 1912-1918): extract `responseData.smart_collection.handle` and save it to `shopify_handle`

**3. `supabase/functions/match-redirects/index.ts` — Use real handles + sitemap paths**
- Update categories SELECT query (line 288) to include `shopify_handle`
- Change category entity building (lines 291-302):
  - Use `category.shopify_handle || generateShopifyHandle(category.shopify_tag || category.name)` for handle
  - Build sitemap-style source_path: `/shop/${slug}-${extId}c1.html` when slug and external_id are available
  - Also register clean slug path (`/shop/${slug}/`) in a secondary lookup for matching
- Add space-safety check to `generateShopifyHandle`

**4. `src/lib/xml-parser.ts` — No changes needed**
The sitemap path construction will be done in `match-redirects` using the slug and external_id already stored in the database, so no XML parser changes are required.

### Files changed
| File | Change |
|------|--------|
| Database migration | Add `shopify_handle text` column to `canonical_categories` |
| `shopify-upload/index.ts` | Store `handle` from Shopify API response for both new and existing collections |
| `match-redirects/index.ts` | Use `shopify_handle` for collection paths, build sitemap-format source paths, add safety check to handle generation |

### Files NOT changed
- `xml-parser.ts` (not needed — match-redirects builds paths from DB data)
- `create-redirects/index.ts`
- `RedirectsStep.tsx`
- `ShopifyDestinationSearch.tsx`

