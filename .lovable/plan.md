

## Root Cause (confirmed from live database)

I queried `pg_stat_activity` and found **9 active connections**, with **4 simultaneous `canonical_orders` count queries** each taking 1.7–2.6 seconds, plus 2 `canonical_pages` count queries. These are all coming from `fetchStatusCounts()` in `UploadStep.tsx`.

The problem: `fetchStatusCounts` fires 4 status queries **in parallel** per entity type (pending/uploaded/failed/duplicate), and it does this for all 5 entity types. That's up to **20 concurrent exact-count queries** hitting RLS-protected tables with 60k+ rows. The RLS JOIN to `projects` makes each query slow, and running them in parallel saturates the connection pool.

Additionally, `fetchRawEntityCounts()` fires **5 more parallel exact-count queries** on mount.

## Plan: Quick Stabilization (4 changes, 1 file)

### File: `src/components/wizard/steps/UploadStep.tsx`

**Change 1: Make ALL count queries fully sequential (not parallel-per-entity)**

Currently lines 312–319 run 4 status queries in parallel per entity. Change to run each one sequentially with no `Promise.all`:

```typescript
for (const { type, table } of entityTables) {
  const pending = await safeCount(table, 'pending');
  const uploaded = await safeCount(table, 'uploaded');
  const failed = await safeCount(table, 'failed');
  const duplicate = await safeCount(table, 'duplicate');
  counts[type] = { pending, uploaded, failed, duplicate };
}
```

This cuts peak concurrent DB connections from ~20 to 1.

**Change 2: Remove `fetchRawEntityCounts` entirely**

Lines 493–508 fire 5 parallel exact-count queries that duplicate data already available from `fetchStatusCounts`. Remove the function, the state, and the call on line 516. The total is already computed as `pending + uploaded + failed + duplicate`.

**Change 3: Increase fetchStatusCounts throttle from 15s → 30s**

Line 249: change `15_000` to `30_000`. This halves the query frequency during active uploads.

**Change 4: Remove the "Databasen er under pres" warning entirely**

Lines 1485–1500: Remove the `dbFetchFailed` banner. It's misleading and unhelpful — the user can't do anything about it, and the counts self-recover. Also remove the `dbFetchFailed` state variable and the logic that sets it (line 324). The warning creates more anxiety than value.

### Not changing
- Upload logic, worker, watchdog, mutex
- Edge functions
- Database schema or indexes (composite indexes already exist)
- Shopify count fetching logic

