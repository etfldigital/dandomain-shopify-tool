

## Plan: Fix Product Image Upload — Sequential + Retry + Fail-on-no-images

### Overview
Replace concurrent image upload with sequential upload (with 3 retries per image), add pre-upload URL validation, add debug logging for missing images, and mark products as "failed" when ALL images fail so they get retried.

### Changes (single file: `supabase/functions/shopify-upload/index.ts`)

**1. Add debug logging for 0 images (after line 1017)**
Log `_mergedImages`, `images`, and `items[0].data.images` when no images are found, to diagnose missing image data.

**2. Add image URL pre-validation (after line 1017)**
Filter `allImages` through `normalizeImageUrl()` to drop invalid URLs before upload begins. Use `validatedImages` array for the rest of the upload logic.

**3. Replace concurrent image upload (lines 1180–1254) with sequential upload**
- Remove `IMAGE_CONCURRENCY` and `createConcurrencyLimiter`
- Loop through `validatedImages` sequentially with `for` loop
- Each image gets up to 3 retry attempts with exponential backoff
- On each attempt: try `src` upload first, fallback to `attachment` upload
- Rate limit responses trigger a wait + retry (not immediate failure)
- Track `added`, `failed`, `failedUrls`

**4. Mark product as "failed" when ALL images fail (new logic after image loop)**
- If `added === 0 && validatedImages.length > 0`: update product status to `'failed'` with error message listing failed URLs, return error to prevent marking as "uploaded"
- If some images failed but not all: log warning, continue with "uploaded" status

### No other files changed
- `xml-parser.ts`, `prepare-upload`, `upload-worker`, frontend — all unchanged

