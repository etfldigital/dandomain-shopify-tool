
# Plan: Case-insensitiv vendor-stripping fra produkttitler

## Problem
Når produkttitlen starter med et brand-navn der har anden kapitalisering end vendor-feltet, fjernes præfikset ikke:
- Titel: `"Ivy Copenhagen - Augusta French jeans Cool barcelona"`
- Vendor: `"Ivy copenhagen"` (lille 'c')
- Resultat: Titlen forbliver uændret, fordi "Ivy Copenhagen" ≠ "Ivy copenhagen"

## Løsning
Implementer case-insensitiv (og lettere fuzzy) vendor-matching i alle tre steder hvor title-normalisering sker.

## Ændringer

### 1. ProductMappingTab.tsx (Preview)
**Fil:** `src/components/wizard/steps/ProductMappingTab.tsx`

Opdater title-transform logikken (linje 362-379) til:
- Søge efter den første separator (`" - "`, `" – "`, etc.) i titlen
- Sammenligne præfikset **case-insensitivt** med vendor
- Hvis de matcher, fjern præfikset + separator

```text
// Nuværende (case-sensitive):
if (transformedTitle.startsWith(vendor + separator)) { ... }

// Ny (case-insensitive):
// Find separator i titel, sammenlign præfiks lowercase med vendor lowercase
```

### 2. shopify-upload/index.ts (Endelig upload)
**Fil:** `supabase/functions/shopify-upload/index.ts`

Opdater title-transform i `processProductGroup` funktionen (linje 439-450) til samme logik:
- Find separator i titlen
- Sammenlign præfiks case-insensitivt
- Fjern hele præfikset baseret på separator-position (ikke vendor.length)

### 3. prepare-upload/index.ts (Grouping)
**Fil:** `supabase/functions/prepare-upload/index.ts`

Opdater `normalizeTitle()` funktionen (linje 264-291) til:
- Først søge efter separator i titlen
- Sammenligne præfikset case-insensitivt med vendor
- Bruge separator-positionen til at fjerne præfikset

---

## Teknisk implementation

### Ny hjælpefunktion: `stripVendorPrefix()`
Oprettes i alle tre filer (da de ikke kan dele kode):

```typescript
function stripVendorPrefix(title: string, vendor: string): string {
  const trimmedTitle = title.trim();
  const trimmedVendor = vendor.trim().toLowerCase();
  
  if (!trimmedVendor) return trimmedTitle;
  
  // Find separator i titlen
  const separators = [' - ', ' – ', ' — ', ': ', ' | '];
  
  for (const sep of separators) {
    const sepIndex = trimmedTitle.indexOf(sep);
    if (sepIndex > 0 && sepIndex < 60) {
      const prefix = trimmedTitle.slice(0, sepIndex).trim();
      
      // Case-insensitiv sammenligning
      if (prefix.toLowerCase() === trimmedVendor) {
        const rest = trimmedTitle.slice(sepIndex + sep.length).trim();
        return rest || trimmedTitle;
      }
    }
  }
  
  // Fallback: Simpel startsWith med case-insensitiv check
  if (trimmedTitle.toLowerCase().startsWith(trimmedVendor)) {
    const rest = trimmedTitle.substring(trimmedVendor.length)
      .replace(/^[\s\-–—:]+/, '').trim();
    return rest || trimmedTitle;
  }
  
  return trimmedTitle;
}
```

---

## Eksempler efter ændring

| Original Titel | Vendor | Resultat |
|----------------|--------|----------|
| "Ivy Copenhagen - Augusta jeans" | "Ivy copenhagen" | "Augusta jeans" |
| "MADS NØRGAARD - T-shirt" | "Mads Nørgaard" | "T-shirt" |
| "Brand – Produkt" | "brand" | "Produkt" |
| "Produkt uden brand" | "Brand" | "Produkt uden brand" (uændret) |

---

## Berørte filer
1. `src/components/wizard/steps/ProductMappingTab.tsx` - Preview visning
2. `supabase/functions/shopify-upload/index.ts` - Endelig upload til Shopify
3. `supabase/functions/prepare-upload/index.ts` - Grouping logik (til konsistens)

## Test
Efter implementation:
1. Genimporter PRODUCTS.xml
2. Kør "Opdater forecast" 
3. Verificer at preview viser korrekt titel uden vendor-præfiks
4. Kør upload og bekræft at Shopify-produkter har korrekte titler
