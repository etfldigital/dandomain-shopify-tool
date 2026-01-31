
# Plan: Fjern "Hent metafelter" knap og auto-fetch metafelter

## Baggrund
I `ProductMappingTab.tsx` under "Felt-mapping" fanen er der stadig en manuel "Hent metafelter" knap. Den skal fjernes, og Shopify metafelter skal automatisk hentes i baggrunden når komponenten indlæses - præcis som allerede implementeret i `FieldMappingEditor.tsx`.

DanDomain kildefelterne (FIELD_1, FIELD_2, FIELD_3, FIELD_9) er korrekt defineret i `KNOWN_SOURCE_FIELDS` og vises altid i "Kilde felt" dropdown'en. Disse afhænger ikke af "Hent metafelter" funktionen - den henter kun Shopify's egne metafield definitioner til "Mål felt" dropdown'en.

---

## Ændringer

### 1. Tilføj auto-fetch af metafelter ved mount
- Tilføj en `useEffect` hook der kalder `fetchShopifyMetafields(true)` stille i baggrunden når komponenten indlæses
- Brug en `metafieldsLoaded` state for at undgå gentagne kald

### 2. Fjern "Hent metafelter" knappen
- Fjern knappen helt fra CardHeader (linje 807-820)
- Behold kun "Auto-map" knappen i headeren

### 3. Omstrukturér layoutet
- Flyt "Tilføj mapping" knappen op over kilde- og målfelterne, centreret
- Gør "Tilføj mapping" knappen blå (primary variant) med Plus ikon og tekst
- Vis en lille loading-indikator i beskrivelsen mens metafelter hentes

---

## Tekniske detaljer

**Fil:** `src/components/wizard/steps/ProductMappingTab.tsx`

### Nye state variabler:
```typescript
const [metafieldsLoaded, setMetafieldsLoaded] = useState(false);
```

### Ny useEffect for auto-fetch:
```typescript
useEffect(() => {
  if (!metafieldsLoaded) {
    fetchShopifyMetafields(true); // silent mode
  }
}, [projectId, metafieldsLoaded]);
```

### Opdateret fetchShopifyMetafields funktion:
Tilføj `silent` parameter for at undertrykke toast-beskeder ved automatisk hentning.

### Nyt layout i CardHeader:
```tsx
<CardHeader>
  <div className="flex items-center justify-between">
    <div>
      <CardTitle>Ekstra felt-mappings</CardTitle>
      <CardDescription>
        Map ekstra felter fra DanDomain XML til Shopify felter
        {fetchingMetafields && (
          <span className="ml-2 text-xs">
            <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
            Henter metafelter...
          </span>
        )}
      </CardDescription>
    </div>
    <Button variant="outline" onClick={autoMapFields}>
      <Wand2 className="w-4 h-4 mr-2" />
      Auto-map
    </Button>
  </div>
</CardHeader>
```

### Nyt layout for "Tilføj mapping":
```tsx
{/* Centreret knap over kolonner */}
<div className="flex justify-center mb-4">
  <Button
    onClick={addFieldMapping}
    disabled={!newMapping.sourceField || !newMapping.targetField}
  >
    <Plus className="w-4 h-4 mr-2" />
    Tilføj mapping
  </Button>
</div>

{/* Kilde og mål felt dropdowns */}
<div className="flex gap-3 items-end">
  ...
</div>
```

---

## Resultat
- Shopify metafelter hentes automatisk og stille i baggrunden
- Brugeren ser ikke længere "Hent metafelter" knappen
- "Tilføj mapping" knappen er nu centreret, blå og mere synlig
- DanDomain felterne (FIELD_1, FIELD_2, etc.) vises som altid i "Kilde felt" dropdown
