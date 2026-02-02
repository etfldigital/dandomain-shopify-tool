
# Plan: Sikr At Hvert Produkt Kun Oprettes Én Gang i Shopify

## Problemet
Ved fuld upload oprettes mange produkter flere gange i Shopify. Selvom systemet har ~4069 linjer der svarer til ~1380 unikke produkter, ender der langt flere produkter i Shopify pga. manglende deduplikerings-logik mellem batches.

## Årsager
1. **Session cache forsvinder**: `sessionProductCache` eksisterer kun i én funktion-invocation - når en ny batch startes (ny invocation), er cachen tom
2. **For løs `_isPrimary` filter**: Produkter uden `_isPrimary` marker behandles som primære (`!== false` i stedet for `=== true`)
3. **Ingen persistent dedupe-check**: Der er ingen permanent registrering af hvilke produkter der allerede er uploadet til Shopify
4. **Race conditions**: Watchdog og worker kan køre overlappende

## Løsning: Database-Baseret Idempotency

### Fase 1: Streng Primary-Only Filtrering
Ændre `shopify-upload` til KUN at behandle produkter hvor `_isPrimary === true` (ikke `!== false`).

```typescript
// FØR: Tillader undefined som primær
const primaryProducts = pendingProducts.filter((p: any) => {
  return data._isPrimary !== false;
});

// EFTER: Kun eksplicit markerede primære
const primaryProducts = pendingProducts.filter((p: any) => {
  return data._isPrimary === true;
});
```

### Fase 2: Title-Lock Mekanisme Via Database
Før et produkt oprettes i Shopify, markeres det med en `_processing_key` i databasen. Alle andre workers der ser samme key vil skipe produktet.

**Workflow:**
1. Worker henter batch af `pending` produkter med `_isPrimary === true`
2. For hvert produkt: Generer en unik key (normaliseret titel)
3. Forsøg at opdatere status til `processing` med en atomisk WHERE-clause
4. Kun hvis UPDATE returnerer `count = 1`, fortsæt med Shopify-oprettelse
5. Ved succes: Marker som `uploaded` med `shopify_id`
6. Ved fejl: Marker som `failed`

### Fase 3: Group-Key Baseret Locking
Brug `_groupKey` fra prepare-upload som dedupe-nøgle. Før upload, tjek om nogen i samme gruppe allerede har `shopify_id` sat.

```typescript
// I shopify-upload, før oprettelse:
async function checkGroupAlreadyUploaded(supabase, projectId, groupKey) {
  const { data } = await supabase
    .from('canonical_products')
    .select('shopify_id')
    .eq('project_id', projectId)
    .eq('data->>_groupKey', groupKey)
    .not('shopify_id', 'is', null)
    .limit(1);
  
  return data && data.length > 0 ? data[0].shopify_id : null;
}
```

### Fase 4: Batch-Niveau Atomicitet
Modificer `processProductGroup` til at:
1. Først hente alle produkter med samme `_groupKey`
2. Tjekke om én af dem har `shopify_id` (allerede uploaded)
3. Hvis ja: Marker alle i gruppen som `uploaded` med samme `shopify_id`
4. Hvis nej: Oprette produktet og derefter opdatere HELE gruppen atomisk

## Tekniske Ændringer

### 1. `supabase/functions/shopify-upload/index.ts`

**Ændring 1 - Streng primary filter (linje ~318-322):**
```typescript
// Kun produkter eksplicit markeret som primær
const primaryProducts = pendingProducts.filter((p: any) => {
  const data = p.data || {};
  return data._isPrimary === true; // STRENG check
});
```

**Ændring 2 - Group-level dedupe check før oprettelse (i processProductGroup):**
```typescript
async function processProductGroup(...) {
  const data = items[0].data || {};
  const groupKey = data._groupKey;
  
  // CHECK: Er gruppen allerede uploaded?
  if (groupKey) {
    const { data: existing } = await supabase
      .from('canonical_products')
      .select('shopify_id')
      .eq('project_id', projectId) // Needs to be passed
      .eq('data->>_groupKey', groupKey)
      .not('shopify_id', 'is', null)
      .limit(1);
    
    if (existing?.[0]?.shopify_id) {
      console.log(`[PRODUCTS] Group "${groupKey}" already has shopify_id, skipping`);
      // Mark all items in current batch as uploaded with existing ID
      await supabase
        .from('canonical_products')
        .update({ 
          status: 'uploaded', 
          shopify_id: existing[0].shopify_id,
          error_message: 'Sprunget over: Variant grupperet med andet produkt',
          updated_at: new Date().toISOString() 
        })
        .in('id', items.map(i => i.id));
      return { skipped: true };
    }
  }
  
  // Continue with normal upload...
}
```

**Ændring 3 - Atomic status transition:**
```typescript
// Før Shopify API-kald, marker som "processing"
const { count: locked } = await supabase
  .from('canonical_products')
  .update({ 
    status: 'mapped', 
    error_message: 'Processing...' 
  })
  .eq('id', items[0].id)
  .eq('status', 'pending') // Kun hvis stadig pending
  .select('*', { count: 'exact', head: true });

if (locked !== 1) {
  console.log(`[PRODUCTS] "${groupKey}" already being processed by another worker`);
  return { skipped: true };
}
```

### 2. `supabase/functions/prepare-upload/index.ts`

**Sikre at ALLE pending produkter får `_isPrimary` sat:**
Fallback-logikken (linje 790-816) skal køre ALTID, ikke kun som fallback.

### 3. `supabase/functions/upload-worker/index.ts`

**Ændring - Serialiser produkt-batches:**
Reducer `batchSize` for produkter til 1-2 for at minimere race window, eller implementer en lock-mekanisme.

## Visuelt Flow

```text
┌────────────────────────────────────────────────────────────────┐
│                    FORBEDRET UPLOAD FLOW                       │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  1. prepare-upload:                                            │
│     ┌─────────────────────────────────────────────────────┐    │
│     │ • Grupper alle produkter efter normaliseret titel   │    │
│     │ • Marker ÉN som _isPrimary = true                   │    │
│     │ • Marker RESTEN som _isPrimary = false              │    │
│     │ • Gem _groupKey på ALLE i gruppen                   │    │
│     └─────────────────────────────────────────────────────┘    │
│                           │                                    │
│                           ▼                                    │
│  2. shopify-upload:                                            │
│     ┌─────────────────────────────────────────────────────┐    │
│     │ FILTER: Kun _isPrimary === true (STRENG)            │    │
│     │                                                     │    │
│     │ For hver primær:                                    │    │
│     │   ┌─────────────────────────────────────────────┐   │    │
│     │   │ 1. Tjek om _groupKey allerede har           │   │    │
│     │   │    shopify_id i databasen                   │   │    │
│     │   │    → JA: Skip og marker som uploaded        │   │    │
│     │   │    → NEJ: Fortsæt                           │   │    │
│     │   │                                             │   │    │
│     │   │ 2. Atomisk lock: UPDATE...WHERE pending     │   │    │
│     │   │    → count=0: Skip (anden worker har den)   │   │    │
│     │   │    → count=1: Fortsæt                       │   │    │
│     │   │                                             │   │    │
│     │   │ 3. Opret i Shopify                          │   │    │
│     │   │                                             │   │    │
│     │   │ 4. Marker HELE gruppen som uploaded         │   │    │
│     │   │    med samme shopify_id                     │   │    │
│     │   └─────────────────────────────────────────────┘   │    │
│     └─────────────────────────────────────────────────────┘    │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

## Resultat
- Produkter oprettes PRÆCIS én gang i Shopify
- Selv ved genstart, race conditions, eller parallelle workers undgås dubletter
- Databasen er source of truth (ikke session cache)
- Ingen Shopify tags påkrævet
