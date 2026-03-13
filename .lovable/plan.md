

## Plan: Simplify `resolveVendorName()` — Direct Lookup Only

### Problem
`resolveVendorName()` has ~80 lines of fallback logic (abbreviation matching, title inference) that guesses wrong vendor names. The manufacturer cache already has correct MANUFAC_ID → MANUFAC_NAME mappings.

### Changes (single file: `supabase/functions/shopify-upload/index.ts`)

**1. Replace `resolveVendorName()` (lines 455–539) with simple direct lookup:**
```typescript
function resolveVendorName(rawId: string): string {
  const manufacId = String(rawId || '').trim();
  if (!manufacId) return '';
  const directMatch = manufacturerNameCache.get(manufacId);
  if (directMatch) return directMatch;
  const normalizedId = manufacId.trim().replace(/\s+/g, ' ').toLowerCase();
  const normalizedMatch = manufacturerNameCache.get(normalizedId);
  if (normalizedMatch) return normalizedMatch;
  console.warn(`[PRODUCTS][VENDOR] No manufacturer name found for MANUFAC_ID="${manufacId}" — using raw ID`);
  return manufacId;
}
```

**2. Delete helper functions** (lines 390–453):
- `formatInferredVendor()`
- `inferVendorFromTitle()`

**3. Update call site** (line 787):
- From: `resolveVendorName(manufacId, originalTitle, groupedTitle)`
- To: `resolveVendorName(manufacId)`

**4. Add cache sample logging** in `loadManufacturerNames()` (after line 383):
```typescript
const sample = Array.from(cache.entries()).slice(0, 5);
console.log(`[PRODUCTS] Manufacturer cache sample:`, sample.map(([k, v]) => `${k} → ${v}`).join(', '));
```

### No changes to
- `xml-parser.ts`, `upload-worker/index.ts`, `prepare-upload/index.ts`, any frontend code

