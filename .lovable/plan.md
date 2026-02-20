
# Sanitize Image Filenames for Shopify Upload

## Problem
Product image filenames from DanDomain XML contain spaces and Danish special characters (e.g. `/images/Miriam - black.jpg`) which cause Shopify image uploads to fail.

## Solution
Add a `sanitizeImageFilename` function and apply it at the point where image URLs are normalized before sending to Shopify.

## Changes

### 1. Add sanitize function to `supabase/functions/shopify-upload/index.ts`

A new `sanitizeImageFilename` utility function will be added that:
- Extracts just the filename portion from the URL path
- Replaces Danish characters (ae, oe, aa)
- Replaces spaces and unsafe characters with hyphens
- Collapses double hyphens
- Converts to lowercase
- Preserves the file extension and directory path

### 2. Apply sanitization inside `normalizeImageUrl`

The existing `normalizeImageUrl` function (already called for every image) will be updated to run the filename through the sanitizer before returning the final URL. This is the single choke-point for all image URLs going to Shopify, so no other call sites need changes.

## Technical Details

```text
sanitizeImageFilename("Miriam - black.jpg")
  -> "miriam-black.jpg"

normalizeImageUrl("/images/Miriam - black.jpg", "https://example.dk")
  -> "https://example.dk/images/miriam-black.jpg"
```

The function:
1. Splits the URL into directory path + filename
2. Separates the extension from the base name
3. Applies Danish character replacements (ae, oe, aa, Ae, Oe, Aa)
4. Replaces non-alphanumeric/non-dot characters with hyphens
5. Collapses multiple hyphens, trims leading/trailing hyphens
6. Lowercases the result
7. Reassembles directory + sanitized filename

Only the `shopify-upload` edge function is modified -- the XML parser stores raw data as-is, and sanitization happens at upload time.
