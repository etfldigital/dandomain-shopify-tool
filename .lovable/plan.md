

## Plan: Redesign UploadStep.tsx to a Unified, Consistent Upload Progress UI

### Overview
Replace the current inconsistent rendering (SimplifiedEntityCard for customers/orders, inline layout for others) with a single unified `EntityCard` component used by ALL 5 entity types. Fix build errors in edge functions. Delete SimplifiedEntityCard.

### 1. Fix Build Errors in Edge Functions

These are pre-existing TypeScript errors unrelated to the redesign but blocking builds:

- **detect-duplicate-orders/index.ts** (lines 57, 61, 84, 86): Add explicit type annotations to `url: string`, `response: Response`, `linkHeader: string | null`, `match: RegExpMatchArray | null`
- **fetch-dandomain-periods/index.ts** (line 162): Cast `error` to `Error` — `(error as Error).message`
- **fix-period-compare-prices/index.ts** (lines 176, 192): Cast `e` and `error` to `Error`
- **shopify-upload/index.ts** (lines 2149, 2597): Add `(item: any)` type annotation to the `.map()` callbacks

### 2. Create New `EntityCard` Component

**File:** `src/components/wizard/steps/EntityCard.tsx`

A single compact card component used for ALL entity types with this layout:

```text
┌─────────────────────────────────────────────────────────────┐
│ [icon] Label    1.234 / 8.751   ⚠47  ❌3  🟢18.382  ↻  ⋮  │
│ ████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
└─────────────────────────────────────────────────────────────┘
```

**Props interface:**
- `type`, `label`, `icon` (from ENTITY_CONFIG)
- `processed`, `total` (numbers for progress)
- `duplicates`, `errors`, `skipped` (stat badges, shown only when > 0)
- `shopifyLiveCount`, `isShopifyLoading`, `onRefreshShopify`
- `isRunning`, `isComplete`, `isPaused`, `isWaiting`
- `onMenuAction(action)` — callback for kebab menu items
- `menuItems` — array of available menu actions (dynamic per entity state)
- `onErrorClick` — opens error report dialog

**Progress bar logic (simplified):**
- `percent = total > 0 ? (processed / total) * 100 : 0`
- Bar color: green (`bg-green-500`) when `isComplete`, indigo (`bg-indigo-500`) with shimmer when `isRunning`, gray (`bg-secondary`) when idle
- Height: `h-[5px]` with `rounded-full`
- Shimmer: CSS animation on the indigo bar using a gradient overlay

**Badges (inline, right side):**
- Duplicates: amber badge, only when > 0
- Errors: red badge, clickable, only when > 0
- Shopify live count: green badge with refresh button
- Kebab menu (DropdownMenu) with all actions

### 3. Rewrite UploadStep JSX (lines ~1472–2384)

**Preserve ALL existing logic** — state, hooks, useEffect, handlers, computed values. Only change the `return (...)` JSX block.

**New structure:**

```text
<div className="max-w-3xl mx-auto space-y-6">
  <!-- Header with status badge -->
  <header>
    <h2>Upload til Shopify</h2>
    <Badge: "Klar" (gray) / "Synkroniserer" (indigo pulse) / "Pauset" (amber) / "Færdig" (green)
  </header>

  <!-- Celebration banner (existing, keep) -->

  <!-- Overall progress bar + percent badge -->
  <Card>
    <Progress bar (overall)>
    <Speed chip (yellow) + ETA chip (blue) — only during upload>
  </Card>

  <!-- Entity cards — ALL use EntityCard -->
  <Card>
    {ENTITY_CONFIG.map(...) => <EntityCard ... />}
  </Card>

  <!-- Footer: sequence dots + action buttons -->
  <footer>
    <SequenceDots: 5 circles (green=done, indigo=active, gray=pending)>
    <Action buttons: Start/Pause/Fortsæt/Stop/Videre (existing logic)>
  </footer>

  <!-- All existing dialogs (unchanged) -->
</div>
```

**Per-entity rendering (replacing the big `if (type === 'customers' || type === 'orders')` branch):**

All entities use the same computed values:
- `processed = effectiveUploaded + effectiveFailed + effectiveDuplicate + skipped`
- `total = (dbTimedOut ? job.total_count : totalFromDb) + skipped`
- Live progress when running: `Math.max(processed, getLiveProcessedCount(job, job.processed_count))`
- `isComplete = effectivePending === 0 && total > 0`

Menu items are built dynamically per entity — including "Genindlæs fra XML" only for customers/orders.

**Speed/ETA display (anti-flicker):**
- Speed: Use `job.items_per_minute` as primary source (stable). Show "–" if null during upload.
- ETA: `remaining / speed`, formatted as "~X min" or "~X,X timer"
- Both shown as compact badge chips under the overall progress bar

### 4. Add Shimmer Animation

Add to `tailwind.config.ts` keyframes:
```css
shimmer: {
  "0%": { transform: "translateX(-100%)" },
  "100%": { transform: "translateX(100%)" },
}
```
And animation: `shimmer: "shimmer 2s infinite"`

Used as an overlay `::after` pseudo-element on the indigo progress bar via a utility class.

### 5. Delete SimplifiedEntityCard

Remove `src/components/wizard/steps/SimplifiedEntityCard.tsx` and its import from UploadStep.

### 6. Overall Progress + Status Header

- Overall progress bar at the top of the card, summing all entities
- Percentage badge to the right
- Status badge in header: derived from existing `isUploading`, `isPaused`, `allCompleted` state

### 7. Sequence Dots in Footer

Five small circles representing the upload order (Pages → Categories → Products → Customers → Orders). Color based on entity completion state.

### Files Changed

| File | Action |
|------|--------|
| `src/components/wizard/steps/EntityCard.tsx` | Create (new unified card component) |
| `src/components/wizard/steps/UploadStep.tsx` | Edit (replace JSX return, keep all logic) |
| `src/components/wizard/steps/SimplifiedEntityCard.tsx` | Delete |
| `tailwind.config.ts` | Edit (add shimmer keyframe) |
| `supabase/functions/detect-duplicate-orders/index.ts` | Edit (fix TS errors) |
| `supabase/functions/fetch-dandomain-periods/index.ts` | Edit (fix TS error) |
| `supabase/functions/fix-period-compare-prices/index.ts` | Edit (fix TS errors) |
| `supabase/functions/shopify-upload/index.ts` | Edit (fix TS errors) |

