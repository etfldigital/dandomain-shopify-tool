
# Plan: Vis alle mappede metafelter i Shopify preview

## Problemet
Aktuelt filtreres metafelter med tomme værdier væk i preview'et (linje 498). Dette betyder at brugeren ikke kan se hvilke felter der kommer til at eksistere i Shopify - kun dem der har data for det specifikke produkt.

## Løsning
Ændre logikken så **alle** konfigurerede felt-mappings vises i preview'et, med "Ikke udfyldt" i grå tekst for tomme felter.

---

## Ændringer

### 1. Opdater useEffect der beregner mappedFields (linje 486-546)
Fjern filtreringen af tomme værdier, så alle mappings inkluderes:

```typescript
for (const mapping of fieldMappings) {
  const sourceValue = rawData[mapping.sourceField];
  // ALTID tilføj mapping - også for tomme værdier
  mappedFields.push({
    field: mapping.targetField,
    value: sourceValue ?? null, // null for tomme værdier
    source: mapping.sourceField,
  });
  
  // Kun anvend til transformed hvis der er en værdi
  if (sourceValue !== undefined && sourceValue !== null && sourceValue !== '') {
    // ... eksisterende switch statement
  }
}
```

### 2. Opdater Metafields Card i preview'et (linje 1325-1403)
- Fjern de hardcodede felter (Materiale, Farve, Pasform, Vaskeanvisning) da disse nu vises dynamisk via mappings
- Vis ALLE metafield mappings fra `fieldMappings` i stedet for kun dem på produktet
- For tomme værdier: vis grå "Ikke udfyldt" tekst

```tsx
{/* Metafields Card - Vis ALLE mappede metafelter */}
{fieldMappings.filter(m => m.targetField.startsWith('metafields.')).length > 0 && (
  <Card>
    <CardContent className="pt-4">
      <label className="text-sm font-medium text-foreground mb-2 block flex items-center gap-2">
        Metafelter
        <Badge variant="secondary" className="text-[10px] py-0 px-1.5 font-medium rounded-full">
          Shopify
        </Badge>
      </label>
      <div className="grid grid-cols-2 gap-3">
        {fieldMappings
          .filter(m => m.targetField.startsWith('metafields.'))
          .map((mapping, i) => {
            // Find værdien for dette produkt
            const mappedField = product.mappedFields.find(
              mf => mf.field === mapping.targetField
            );
            const value = mappedField?.value;
            const hasValue = value !== null && value !== undefined && value !== '';
            
            // Udled visningsnavn fra targetField
            const parts = mapping.targetField.split('.');
            const fieldName = parts[parts.length - 1].replace(/_/g, ' ');
            const displayName = fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
            
            return (
              <div key={i}>
                <label className="text-xs text-muted-foreground mb-1 block flex items-center gap-1">
                  {displayName}
                  <span className="text-[10px] text-primary">← {mapping.sourceField}</span>
                </label>
                <Input 
                  value={hasValue ? String(value) : ''} 
                  placeholder={hasValue ? undefined : 'Ikke udfyldt'}
                  readOnly 
                  className={cn(
                    "bg-background h-8 text-xs",
                    !hasValue && "text-muted-foreground italic placeholder:text-muted-foreground"
                  )}
                />
              </div>
            );
          })}
      </div>
    </CardContent>
  </Card>
)}
```

---

## Resultat
- Alle konfigurerede metafelt-mappings vises altid i preview'et
- Felter uden værdi for det aktuelle produkt viser "Ikke udfyldt" i grå, kursiv tekst
- Brugeren kan nu se præcis hvilke metafelter der oprettes i Shopify, uanset om de har data
- Hardcodede feltnavne (Materiale, Farve, etc.) er fjernet - i stedet vises det faktiske feltnavn fra mapping
