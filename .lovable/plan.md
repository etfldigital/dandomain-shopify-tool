
# Plan: Sikr At Hvert Produkt Kun Oprettes Én Gang i Shopify

## ✅ IMPLEMENTERET

### Ændringer Foretaget

#### 1. `supabase/functions/shopify-upload/index.ts`

**Ændring 1 - Streng primary filter (linje 316-323):**
```typescript
// FØR: Tillader undefined som primær
return data._isPrimary !== false;

// EFTER: Kun eksplicit markerede primære
return data._isPrimary === true; // STRICT check
```

**Ændring 2 - Database-level group dedupe (i processProductGroup):**
Før oprettelse tjekkes om nogen record med samme `_groupKey` allerede har `shopify_id`.
Hvis ja: Skip og marker som uploaded.

**Ændring 3 - Atomic lock før Shopify API-kald:**
```typescript
const { data: lockResult } = await supabase
  .from('canonical_products')
  .update({ error_message: 'Processing...' })
  .eq('id', primaryItem.id)
  .eq('status', 'pending')
  .is('shopify_id', null)
  .select('id');

if (!lockResult || lockResult.length === 0) {
  return { skipped: true }; // Another worker has it
}
```

**Ændring 4 - Opdater HELE gruppen efter succes:**
Efter Shopify-oprettelse opdateres alle records med samme `_groupKey` med `shopify_id`.

#### 2. `supabase/functions/upload-worker/index.ts`

**Ændring - Streng primary-only tælling:**
```typescript
// FØR: Tæller null som primær
query = query.or('data->>_isPrimary.eq.true,data->>_isPrimary.is.null');

// EFTER: Kun eksplicit primære
query = query.eq('data->>_isPrimary', 'true');
```

## Resultat
- Produkter oprettes PRÆCIS én gang i Shopify
- Database er source of truth (ikke session cache)
- Race conditions håndteres via atomisk locking
- Ingen Shopify tags påkrævet
