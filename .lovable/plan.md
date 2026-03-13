

## Problem

All the code changes from the previous edit are already in place (shopify-upload saves handles, match-redirects uses them, migration exists). However, the existing categories in the database were uploaded **before** the code was deployed, so their `shopify_handle` column is NULL. The fallback `generateShopifyHandle()` produces different handles than what Shopify actually generated (e.g., it converts "Nørgaard På Strøget" differently than Shopify does).

Additionally, Strategy 1.5 (external_id) matches categories by the numeric ID in the DanDomain URL (e.g., `-29c1.html` → external_id `29`), but this ID maps to a completely different category than the URL slug suggests, resulting in wrong destinations.

## Fix

**Add a handle backfill step to `match-redirects/index.ts`** — before matching begins, check if any categories have `shopify_collection_id` but no `shopify_handle`. If so, fetch all Shopify collections and update the handles in the database.

### Changes to `supabase/functions/match-redirects/index.ts`

1. After fetching the project (to get Shopify credentials), and before building entity lists:
   - Query categories with `shopify_collection_id IS NOT NULL` and `shopify_handle IS NULL`
   - If any exist, fetch the project's Shopify domain and access token
   - Call Shopify REST API `GET /admin/api/2025-01/smart_collections.json` (paginated)
   - Build a map of `collection_id → handle`
   - Update all categories with their real Shopify handle
   - Log the backfill count

2. Add a validation to Strategy 1.5 for categories: when matching by external_id, verify the URL slug roughly matches the category name (using normalized comparison). If the slug says "noergaard-paa-stroeget" but the matched category is "Dear Denier", reject the match.

### Files changed
| File | Change |
|------|--------|
| `match-redirects/index.ts` | Add handle backfill step + Strategy 1.5 slug validation for categories |

### Files NOT changed
- `shopify-upload/index.ts` (already correct)
- `RedirectsStep.tsx`
- Database (migration already exists)

