

# AI-drevet Redirect Matching System

## Nuværende Situation

**Problemanalyse:**
1. **XML-data indeholder source_path**: Alle 4069 produkter har `source_path` i databasen (f.eks. `/shop/nailberry-boho-chic-NOX211p.html`)
2. **Gamle URLs bruger andet format**: De uploadede gamle URLs bruger et andet ID-format (f.eks. `/shop/nailberry-boho-chic-32129p.html`) - nummerisk ID i stedet for SKU
3. **Nuværende matching fejler**: Algoritmen matcher kun 39 produkter fordi den leder efter eksakte path-matches, som ikke findes på grund af ID-forskelle
4. **Kategorier har ingen slug**: `slug` kolonnen er NULL for alle kategorier, så der er ingen kategori source_paths at matche mod
5. **Shopify handles kendes**: Alle uploadede produkter har `shopify_handle` gemt (f.eks. `boho-chic`)

**Løsning med Lovable AI:**
Implementer en intelligent matching-algoritme der bruger AI til at analysere URL-strukturen og finde det korrekte match baseret på:
- Produktnavne ekstraheret fra URL-slugs
- Sammenligning med produkttitler i databasen
- Semantisk matching via Lovable AI Gateway

---

## Implementation Plan

### 1. Ny Edge Function: `match-redirects`
Opret en AI-drevet matching-funktion der:
- Modtager gamle URLs i batches
- Ekstraherer produktnavn/slug fra URL-strukturen
- Slår op i databasen for at finde det bedste match
- Bruger Lovable AI til at bestemme sandsynlige matches ved tvetydige tilfælde
- Returnerer confidence scores og foreslåede matches

**Matching Strategi (prioriteret rækkefølge):**
1. **Eksakt source_path match** (100% confidence) - hvor URL og source_path matcher
2. **SKU-baseret match** (95% confidence) - hvor URL indeholder produktets SKU
3. **Title-slug match** (90% confidence) - hvor URL-slug matcher produkttitlen efter normalisering
4. **AI-assisteret match** (70-85% confidence) - hvor AI analyserer URL og finder bedste match fra produktliste
5. **Unmatched** (0% confidence) - markeres til manuel gennemgang

### 2. Database Forbedringer
Opdater `project_redirects` tabellen til at understøtte:
- `matched_by` (text) - hvilken strategi fandt matchet ('exact', 'sku', 'title', 'ai', 'manual')
- `ai_suggestions` (jsonb) - alternative forslag fra AI til manuel review

### 3. UI Forbedringer i RedirectsStep
- **"AI Match" knap**: Kør intelligent matching på alle umatchede URLs
- **Forbedret Unmatched tab**: Vis AI-forslag og tillad hurtig godkendelse
- **Batch operations**: Godkend alle AI-forslag med høj confidence (>85%)
- **Progress indikator**: Vis status under AI-matching processen

### 4. Refaktoreret Matching Logik
Flyt matching-logikken fra frontend (handleFileUpload) til backend edge function for:
- Bedre performance ved store datasæt
- Adgang til AI gateway
- Mere kompleks analyse

---

## Tekniske Detaljer

### Edge Function: `match-redirects/index.ts`
```text
┌─────────────────────────────────────────────────────────────┐
│  1. Modtag batch af gamle URLs                              │
│  2. For hver URL:                                           │
│     a. Normaliser og ekstraher slug                         │
│     b. Forsøg direkte database matches (SKU, title, path)   │
│     c. Hvis ingen match: brug AI til semantisk matching     │
│  3. Returner matches med confidence scores                  │
└─────────────────────────────────────────────────────────────┘
```

### AI Prompt Struktur
AI'en får:
- Den gamle URL
- Liste af mulige produkter (titel + Shopify handle)
- Instruktion om at finde bedste match baseret på semantisk lighed

### Filændringer
1. `supabase/functions/match-redirects/index.ts` - **NY** - AI-drevet matching
2. `src/components/wizard/steps/RedirectsStep.tsx` - Tilføj "AI Match" knap og forbedret flow
3. `supabase/config.toml` - Tilføj ny funktion

---

## Forventet Resultat

| Metrik | Før | Efter |
|--------|-----|-------|
| Matchede produkter | 39 | ~1000+ |
| Matchede kategorier | 0 | ~100+ |
| Gennemsnitlig confidence | 55% | 85%+ |
| Unmatched til manuel review | Ukendt | <100 |

---

## Vigtige Noter

1. **AI-brug**: Lovable AI (google/gemini-3-flash-preview) bruges til semantisk matching - ingen API-nøgle nødvendig
2. **Rate limiting**: AI-kald batches for at undgå rate limits
3. **Fallback**: Hvis AI er utilgængelig, bruges kun database-matching
4. **Kategori-matching**: Da kategorier mangler slugs, matches de primært via navn-sammenligning

