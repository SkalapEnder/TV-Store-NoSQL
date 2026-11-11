# Performance Analysis and Optimization Report

How fast the recommendation system is as the database grows, which optimizations matter and
why. All numbers come from [`scripts/benchmark.js`](../scripts/benchmark.js) (`npm run bench`).
The raw tables are in [perf/RESULTS.md](perf/RESULTS.md), the charts in
[perf/charts.html](perf/charts.html) (open in a browser) and the data in [perf/results.json](perf/results.json).

## 1. Method

| | |
|---|---|
| Hardware | Intel Core i5-12500H (16 threads), 16 GB RAM, Windows 10 |
| Software | MongoDB 8.0.4 (local, single node), Node.js 22.12, Mongoose 9 |
| Database | separate `tvstore_bench`, dropped before the run; the application database is not touched |
| Catalog | 600 synthetic TVs: 5 display types, 15 brands, prices by size and type |
| Users | grown step by step: **1,000 → 5,000 → 20,000 → 50,000** |
| Interactions | about 20 products per user (5–45); 30 % of them rated, about 2 purchases per user. At 50k users: about 1 million interactions and 110k purchases |
| Behaviour model | each synthetic user has a hidden taste (display type, 1–2 brands, price band) and product popularity follows a Zipf curve, so there is real structure for collaborative filtering to find |
| Sampling | 100 random users per measurement (30 for the slowest variant), latency as p50 / p95 |
| Variants | item-based with cache, without cache, without index; user-based with and without indexes; popularity |

Latency is measured end-to-end inside the application process: all MongoDB queries, scoring, and
loading the product cards. HTTP time is not included.

## 2. Offline build of the similarity matrix

| Users | Interactions (≈) | Item pairs | Build time | `item_similarities` size |
|---:|---:|---:|---:|---:|
| 1,000 | 20 k | 87,279 | 0.9 s | 1.14 MB |
| 5,000 | 100 k | 153,139 | 1.2 s | 1.16 MB |
| 20,000 | 400 k | 178,166 | 4.3 s | 1.16 MB |
| 50,000 | 1 M | 179,679 | 8.6 s | 1.16 MB |

- **Build time grows linearly with the number of interactions.** Each user is read once
  through a streaming cursor, and the pair updates for a user are bounded by the 60-interaction cap.
- **The result does not grow with users.** It is bounded by *products × K* (600 × 40 neighbours),
  so the online queries read the same small documents at 1k and at 50k users.
- The number of distinct pairs levels off, because the catalog is the limit
  (≤ 600·599/2 = 179,700). Memory needed for the build is bounded by the catalog size too.

## 3. Online latency per recommendation request

p50 / p95 in milliseconds:

| Users | Item-based, **cache** | Item-based, no cache | User-based on the fly, indexed | Popular, no cache |
|---:|---:|---:|---:|---:|
| 1,000 | 0.001 / 0.004 | 4.1 / 6.2 | 50.7 / 58.8 | 2.5 / 4.3 |
| 5,000 | 0.001 / 0.003 | 3.1 / 4.4 | 183.2 / 195.8 | 2.4 / 4.3 |
| 20,000 | 0.003 / 0.004 | 4.7 / 7.9 | 281.0 / 302.7 | 2.9 / 4.6 |
| 50,000 | 0.002 / 0.004 | 4.9 / 6.2 | 275.8 / 298.1 | 4.0 / 5.5 |

**Main result:** with 50× more users, the item-based request stays at **3–5 ms**. The user-based
request computed on the fly grows **5.4×** (51 → 276 ms) and stops growing only because it hits
the cap of 3,000 candidate users.

- **Item-based:** one user document, ~20–40 similarity documents by unique index, then ~48 product
  documents by unique index. None of these grows with the number of users.
- **User-based:** it must read every user who shares a product with the target user. In this
  data that is most users: at 5,000 users the query already returns 3,000, which is the cap. Above
  the cap the latency stays flat, but the algorithm then sees only an arbitrary subset of possible
  neighbours, so its quality would degrade with growth. That is the reason to precompute.
- **Cache:** a repeated request costs microseconds. That is 2,000–5,000× faster than computing it,
  and it covers the common case of a user moving between the home page, the product page and *For you*.

## 4. Effect of the indexes

### 4.1 Neighbour lookup: unique index on `item_similarities.product_id`

The cost of this query depends on the **catalog size**, not on the number of users. It was
measured separately on a growing synthetic matrix (40 products looked up per request, 100 requests):

| Products in the matrix | With index, ms p50 / p95 | Without index, ms p50 / p95 | Docs examined: with / without |
|---:|---:|---:|---:|
| 600 | 1.9 / 2.6 | 2.1 / 2.5 | 39 / 600 |
| 5,000 | 1.9 / 2.5 | 3.6 / 4.6 | 40 / 5,000 |
| 20,000 | 2.0 / 2.4 | 11.0 / 12.8 | 40 / 20,000 |
| 50,000 | 2.2 / 2.9 | 24.2 / 30.2 | 40 / 50,000 |

With the index the plan is `IXSCAN → FETCH` and reads exactly the requested documents, so the time is flat.
Without it the plan is a `COLLSCAN` over the whole collection: the time grows linearly and is
**11× slower at 50,000 products**. In our 600-product store the difference is still small (2.1 vs 1.9 ms),
but the index is what keeps the request flat as the catalog grows.

### 4.2 User-based candidates: multikey indexes on `view_history.product_id` / `purchase_history.product_id`

| Users | With indexes: plan, docs examined | Without: plan, docs examined | p50 with / without, ms |
|---:|---|---|---:|
| 1,000 | `OR → IXSCAN`, 823 | `IXSCAN (_id) → FETCH`, 999 | 50.7 / 45.7 |
| 5,000 | `OR → IXSCAN`, 3,001 | 3,859 | 183.2 / 179.7 |
| 50,000 | `OR → IXSCAN`, 3,001 | 3,366 | 275.8 / 239.3 |

The multikey index **barely helps here, and the measurements show why.** The filter "shared at
least one product with me" is not selective: with ~20 products per user and popular products in
every history, 80–100 % of users match. With `LIMIT 3000` the full scan also stops after reading
about 3,000–3,900 documents, so both plans read about the same amount, and the scan avoids the
`OR` merge. An index pays off when it filters most documents out, which is the case for the
neighbour lookup in 4.1. The fix for user-based CF was therefore to **avoid running it online at all**
(precomputation), not another index. The indexes stay, because they cost about 3.5 MB at
50k users and make "which users interacted with product X" fast for analytics.

## 5. Recommendation quality

The cost of an algorithm only matters if its results are good. Quality was measured at 5,000 users:
for 297 test users the 3 most recent positive interactions (weight ≥ 2) were hidden, the matrix
was rebuilt without them, and the top-10 recommendations were checked against the hidden products.

| Algorithm | HitRate@10 | Precision@10 | Recall@10 | Catalog coverage |
|---|---:|---:|---:|---:|
| **Item-based CF** | **0.670** | **0.091** | **0.302** | 20.7 % |
| User-based CF | 0.643 | 0.084 | 0.280 | 46.8 % |
| Popularity baseline | 0.444 | 0.052 | 0.172 | 3.7 % |

- Item-based CF finds a hidden product for **2 of 3 users** and has **1.76× the recall of the
  popularity baseline**.
- User-based CF is close behind and recommends a much wider part of the catalog (46.8 %), but it
  costs about 60× more per request.
- Popularity recommends the same ~20 hits to everyone (3.7 % coverage). It is used only as the
  cold-start fallback.

## 6. Summary of optimizations

| Optimization | Before | After | Gain |
|---|---|---|---:|
| Precomputed item neighbours instead of user-based on the fly (50k users) | 275.8 ms p50 | 4.9 ms p50 | **56×** |
| LRU cache for repeated requests (50k users) | 4.9 ms p50 | 0.002 ms p50 | **> 2,000×** |
| Unique index on `item_similarities.product_id` (50k products) | 24.2 ms, 50,000 docs read | 2.2 ms, 40 docs read | **11×** |
| `{popularity: -1}` index for trending | sort of the whole collection | IXSCAN, top-200 | flat 2–4 ms |
| Projections (history fields only) and the 60-interaction cap | full user documents | ~1 KB per user read | less data read, bounded work |
| Cache invalidation on view / rating / purchase | stale for up to 5 min | fresh on the next request | correctness |
| `Cache-Control: no-cache` on personal results | the browser kept results for 60 s after a new view (found during testing) | always revalidated | correctness |

## 7. Limitations and next steps

- **The build runs inside the web process.** 8.6 s at 50k users is acceptable once per hour, but the
  pair counting is CPU-bound and blocks the event loop while it runs. At larger scale it should run
  in a `worker_thread` or as a separate cron job (`npm run recs:build` already works standalone).
- **The cache is per process.** With several application instances a shared cache (for example Redis
  with the same keys and TTL) would be needed, and invalidation would have to be broadcast.
- **The matrix is rebuilt in full.** An incremental update (only pairs of users active since the last
  build) would make the rebuild cost depend on activity instead of total history.
- **Synthetic data.** The latencies depend on the data shape: history length, catalog size, overlap.
  The behaviour model is plausible, but the quality numbers should be checked again on real traffic.

## 8. Reproduce

```bash
# needs a MongoDB whose database name contains "bench" (default: local mongodb://127.0.0.1:27017/tvstore_bench)
npm run bench
# shorter run
npm run bench -- --scales 1000,5000 --queries 50 --eval-scale 5000
```

Options: `--scales`, `--products`, `--queries`, `--slow-queries`, `--eval-scale`, `--eval-users`,
`--catalog-scales`, `--out`. The whole run (4 scales, 50k users, quality and catalog phases) takes
about 5 minutes on the hardware above.
