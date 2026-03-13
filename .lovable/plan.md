

## Plan: Validate redirect destinations + filter to uploaded entities only

### 1. `supabase/functions/match-redirects/index.ts` — Filter entities to uploaded-only

Change the three entity queries (lines 381-455) to only include entities that exist in Shopify:

- **Products** (line 381-385): Change `.neq('status', 'duplicate')` to `.eq('status', 'uploaded').not('shopify_id', 'is', null)`
- **Categories** (line 409-412): Add `.eq('status', 'uploaded').not('shopify_collection_id', 'is', null)`
- **Pages** (line 452-455): Add `.eq('status', 'uploaded').not('shopify_id', 'is', null)`

Update the comments accordingly (remove "include all" comments).

### 2. `supabase/functions/create-redirects/index.ts` — Validate destinations before creating

Inside the `for (const redirect of redirects)` loop (line 107), before the existing Shopify redirect creation call (line 110), add a validation block:

- Extract `redirect.new_path` and determine resource type (`/products/`, `/collections/`, `/pages/`)
- For products: `GET /admin/api/2025-01/products.json?handle={handle}&fields=id`
- For collections: Check both `smart_collections` and `custom_collections` by handle
- For pages: `GET /admin/api/2025-01/pages.json?handle={handle}&fields=id`
- If resource not found → mark redirect as `failed` with error message "Destination findes ikke i Shopify: {path}", increment `failed`, `continue`
- If validation network error → fail open (allow redirect to proceed)
- Add `await sleep(200)` between validation checks for rate limiting

### Files changed
| File | Change |
|------|--------|
| `match-redirects/index.ts` | Filter products, categories, pages to `status='uploaded'` with non-null Shopify IDs |
| `create-redirects/index.ts` | Add destination existence validation via Shopify Admin API before creating each redirect |

### Files NOT changed
- Frontend/UI components
- Upload logic
- Matching strategies/confidence scores

