

## Problem

DanDomain product URLs contain the **INTERNAL_ID** (e.g. `-27795p.html`), but the code uses the **SKU/external_id** (e.g. `0951`) in two critical places:

1. **`xml-parser.ts`** builds `source_path` using SKU: `/shop/...-0951p.html` instead of `/shop/...-27795p.html`
2. **`match-redirects/index.ts`** Strategy 1.5 looks up the extracted numeric ID against `external_id` (which is SKU), not `internal_id`

This means both Strategy 1 (exact source_path) and Strategy 1.5 (numeric ID lookup) fail for nearly all products.

## Changes

### 1. `src/lib/xml-parser.ts` (~line 220)
Change source_path construction to use `internalId` instead of `sku`:

```typescript
const sourceId = internalId || sku;
const sourcePath = sourceId ? `/shop/${slugifiedTitle}-${sourceId}p.html` : null;
```

### 2. `supabase/functions/match-redirects/index.ts`

**A) Add `internal_id` to `UploadedEntity` interface** (line 47):
```typescript
internal_id?: string;
```

**B) Extract `internal_id` when building product entities** (~line 388-406):
```typescript
const internalId = (data?.internal_id as string) || '';
// ... and include it in the entity push
internal_id: internalId,
```

**C) Build `internalIdToEntity` lookup map** (after line 500, alongside existing maps):
```typescript
const internalIdToEntity = new Map<string, UploadedEntity>();
for (const entity of entities) {
  if (entity.internal_id) {
    internalIdToEntity.set(entity.internal_id, entity);
  }
}
```

**D) Update Strategy 1.5** (~line 576-586) to check `internal_id` first, then fall back to `external_id`:
```typescript
if (!matched) {
  const productIdMatch = normalized.match(/-(\d+)p\.html$/i);
  if (productIdMatch) {
    const dandoId = productIdMatch[1];
    // Try internal_id first (what DanDomain actually uses in URLs)
    const entityByInternalId = internalIdToEntity.get(dandoId);
    if (entityByInternalId && entityByInternalId.entity_type === 'product') {
      matched = entityByInternalId;
      confidence = 99;
      matchedBy = 'external_id';
    }
    // Fall back to external_id (SKU)
    if (!matched) {
      const entity = productEntities.find(e => e.external_id === dandoId);
      if (entity) {
        matched = entity;
        confidence = 98;
        matchedBy = 'external_id';
      }
    }
  }
  // ... existing category matching unchanged
}
```

**E) Fix Strategy 1.3** (~line 560) to use type-appropriate entity list instead of all entities:
```typescript
// Determine which entities to search based on URL type
const urlType = normalized.match(/-\d+p\.html$/i) ? 'product'
  : normalized.match(/-\d+[cs]\d*\.html$/i) ? 'category' : null;
const allowedEntities = urlType === 'product' ? productEntities
  : urlType === 'category' ? categoryEntities : entities;

// Then use allowedEntities in the Strategy 1.3 loop
```

### Expected Impact
- Most of the 911 unmatched product URLs will now match via the `internalIdToEntity` lookup (Strategy 1.5) with 99% confidence
- The `source_path` fix ensures Strategy 1 (exact path match) also works for future imports
- Remaining unmatched URLs will be genuinely missing products (discontinued, not migrated)

