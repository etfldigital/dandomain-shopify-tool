

## Investigation Results

The "i Shopify" refresh button is **NOT broken by CORS**. The full flow works correctly:

1. Browser calls backend Edge Function `shopify-products-count` via `supabase.functions.invoke()` -- confirmed in console logs and network requests
2. Edge Function calls Shopify REST API at `https://alexandrasdk.myshopify.com/admin/api/2025-01/products/count.json?status=any`
3. Shopify returns `{"count":0}` -- HTTP 200, not an error

This is confirmed by edge function logs showing dozens of calls all returning `{"count":0}`. Meanwhile, the same function correctly returns customers (16,215), orders (4,539), categories (405), and pages (1).

### Root Cause

The Shopify REST Products API (`/products/count.json`) was deprecated starting in API version `2024-10`. In version `2025-01`, this endpoint returns 0 even though products exist. The upload works because `POST /products.json` still functions for creation, but the count endpoint is broken.

### Plan

**1. Fix `shopify-products-count` Edge Function** -- use GraphQL for products count instead of the deprecated REST endpoint

Replace the products case in `fetchCountForEntity` with a GraphQL query:
```graphql
{ productsCount { count } }
```

This hits `POST /admin/api/2025-01/graphql.json` which is the supported way to count products in newer API versions. All other entity types (customers, orders, categories, pages) keep their current REST endpoints since those still work.

**2. No frontend changes needed**

The frontend code in `UploadStep.tsx` already:
- Calls the backend Edge Function (not Shopify directly)
- Has per-entity-type refresh via `fetchShopifyLiveCountForEntity()`
- Displays "–" when fetch fails (`null` values)
- Logs responses to console

The only change is in the backend Edge Function.

### Technical Detail

```text
Current (broken):
  GET /admin/api/2025-01/products/count.json?status=any → {"count": 0}

Fixed:
  POST /admin/api/2025-01/graphql.json
  Body: { "query": "{ productsCount { count } }" }
  → {"data": {"productsCount": {"count": 431}}}
```

### Files to change

- `supabase/functions/shopify-products-count/index.ts` -- replace REST products count with GraphQL query
- `supabase/functions/upload-worker/index.ts` -- also fix the products count at line 172 which has the same bug (used for sequencing gate)

### Not changing
- Upload logic, payload mapping, retry logic
- "Afventer" count logic
- Frontend UploadStep.tsx
- Watchdog mechanism

