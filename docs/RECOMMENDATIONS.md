# Recommendation System

Final Project: collaborative-filtering recommendations on top of the Assignment #6 data model
(MongoDB, `users` with embedded interaction history, `products` catalog).

- Engine: [`scripts/recommender.js`](../scripts/recommender.js)
- API: [`routes/api/recommendationRoutes.js`](../routes/api/recommendationRoutes.js)
- Pages: `/recommendations` ("For you"), home page block, product page block
- Performance report: [PERFORMANCE.md](PERFORMANCE.md), raw results in [perf/](perf/)

## 1. Input data: user–item interactions

The interactions are already stored by Assignment #6 inside each user document:

| Source | Field | Signal |
|---|---|---|
| Product page opened | `view_history[].views`, `lastViewed` | implicit, weak |
| Rating 1–5 | `view_history[].rating`, `ratedAt` | explicit, can be negative |
| Purchase | `purchase_history[]` | implicit, strongest |

They are mixed into one weight per (user, item), from 0 to 10:

```
w(u, i) = min(1 + ln(views), 3)          // interest; repeated views count, but slowly
        + 4      if purchased
        + (rating − 3) · 1.5  if rated   // 5★ → +3, 4★ → +1.5, 2★ → −1.5, 1★ → −3
```

Items with `w ≤ 0` (disliked) are never used as positive evidence. Only the 60 most recent
interactions of a user are used, which bounds the cost per user.

## 2. Algorithm: item-based collaborative filtering

**Offline (every hour, at startup, or on demand):** for each pair of products the engine
computes the cosine similarity of their columns in the user–item matrix, with significance
shrinkage so pairs supported by only a few users are trusted less:

```
sim(i, j) = (Σ_u w(u,i)·w(u,j)) / (‖w(·,i)‖ · ‖w(·,j)‖)  ·  co(i,j) / (co(i,j) + 5)
```

`co(i, j)` is the number of users who interacted with both. Pairs with `co < 2` are dropped.
For every product the top **K = 40** neighbours are stored in the `item_similarities` collection:

```js
{ product_id: 1023, neighbors: [{ product_id: 1047, score: 0.4123, co: 18 }, …],
  popularity: 812.5, interactions: 240, builtAt: ISODate(…) }
```

The users collection is read once with a streaming cursor and a projection of only the history
fields. Pair counts live in a `Map` keyed by `a·2²¹ + b`, so the memory needed grows with the number
of distinct co-occurring pairs (≤ items²/2), not with the number of users.

**Online (per request):**

```
score(j) = Σ_{i ∈ history(u)}  sim(i, j) · w(u, i) · 0.5^(age_i / 60 days)
```

1. Read the user's history: one document by `_id`.
2. Read the neighbour lists of those items: `item_similarities.find({product_id: {$in: …}})`, unique index.
3. Add up the scores, drop products the user already saw, keep the top 48.
4. Load the cards, in stock only: `products.find({product_id: {$in: …}, quantity > 0})`, unique index.

Each recommendation remembers the history item that contributed most. The UI uses it as the
explanation: *"Because you viewed / liked / bought X"*.

**Cold start:** if the user has no history, or collaborative filtering finds too few
products, the list is filled with **trending** products (sum of interaction weights, index
`{popularity: -1}`). Products from the categories the user looked at come first.

**Time decay:** at query time each interaction is weighted with a 60-day half-life, so the
recommendations follow the user's current interest. The decay is not applied in the matrix
build, because the similarity between two products does not depend on when one user saw them.

### Alternative kept for comparison: user-based CF on the fly

`recommendUserBased()` finds the users who interacted with the same products (multikey indexes
`view_history.product_id`, `purchase_history.product_id`), at most 3,000 candidates. It takes the
50 most similar users (cosine) and recommends what they liked. It needs no precomputation and
reacts to new data at once. Its cost, however, grows with the database: see the performance
report. The UI can show it under *For you → Shoppers like you*, and the API under `?algorithm=user`.

### Why item-based

| | Item-based (chosen) | User-based on the fly |
|---|---|---|
| Online work per request | 3 indexed queries, ~40 small documents | reads up to 3,000 user documents |
| Latency as users grow | flat | grows until the candidate cap, then quality suffers |
| Stability | item neighbourhoods change slowly, so hourly rebuilds are enough | always fresh |
| Explanation for the user | "Because you viewed X" | "Shoppers like you" |
| Accuracy on our data | higher (see quality table) | lower, but covers more of the catalog |

A store usually has far fewer products than users, and item–item similarities change slowly.
That makes the item-based model the standard choice for e-commerce.

## 3. Optimizations

| Technique | Where | Effect |
|---|---|---|
| Precomputed top-K neighbours | `item_similarities` | Request does no pair computations; storage bounded by items × K |
| Unique index `item_similarities.product_id` | neighbour lookup | IXSCAN of ~40 keys instead of a full scan of the catalog |
| Index `item_similarities.popularity` | trending / cold start | top-N without a sort in memory |
| Multikey indexes on `view_history.product_id`, `purchase_history.product_id` | user-based candidates | finds co-interacting users without a full scan |
| Projections | all engine queries | only history fields are read and sent |
| Interaction cap (60 most recent) | build + request | bounded work per user |
| In-memory LRU cache with TTL (5 min, 5,000 entries) | `recommendForUser`, `similarItems`, `popular` | repeated requests answered in microseconds |
| Event-based invalidation | `trackView` (new product), `trackRating`, `recordPurchase` | the user sees fresh recommendations right after acting; repeated views of the same product keep the cache |
| Single-flight build | `buildSimilarities` | concurrent rebuild requests share one run |
| Batched writes (`bulkWrite`, 1,000 per batch) | build | one round trip per thousand items |

## 4. API

All endpoints return JSON. A personal endpoint needs a logged-in session.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/recommendations` | user | Personal recommendations. Query: `limit` (1–48, default 12), `algorithm` (`item` default, or `user`) |
| GET | `/api/recommendations/popular` | public | Trending products. Query: `limit` |
| GET | `/api/recommendations/similar/:productId` | public | "Customers who viewed this also viewed". Query: `limit` (default 8) |
| GET | `/api/recommendations/users/:userId` | admin | Recommendations for any user (debugging, evaluation) |
| GET | `/api/recommendations/status` | admin | Last matrix build, cache statistics, engine settings |
| POST | `/api/recommendations/rebuild` | admin | Rebuild the similarity matrix now |

Example: `GET /api/recommendations?limit=1`

```json
{
  "userId": "6730c1…",
  "algorithm": "item-based",
  "generatedAt": "2026-11-10T15:20:11.402Z",
  "interactions": 33,
  "personalized": 28,
  "cached": false,
  "tookMs": 4,
  "items": [{
    "product_id": 196810, "name": "Материнская плата ASUS TUF Gaming B850-Pro WiFi7 W Neo, AM5",
    "model": "90MB1KD0-M0EAY0", "price": 169990, "brand": "ASUS", "category": "motherboard",
    "specs": { "socket": "AM5", "chipset": "B850", "memory": "DDR5", "wifi": true },
    "picture": "https://…", "rating_avg": 3.7, "score": 8.6075,
    "reason": { "type": "rated", "product_id": 175290, "name": "Процессор AMD Ryzen 7 7800X3D, AM5, OEM" },
    "url": "/products/196810"
  }]
}
```

`reason.type` is one of `viewed`, `rated`, `bought` (item-based), `similar-users` (user-based) or
`popular` (cold-start fill). `personalized` is how many of the items came from collaborative filtering.

Errors: `401` not logged in, `403` not an admin, `404` unknown user, `500` with `{ "error": "…" }`.

Caching headers: personal results are sent with `Cache-Control: private, no-cache`, because the
server cache is dropped after the user's actions and a browser cache would keep stale data.
Trending and similar products use `public, max-age=300`.

## 5. User interface

| Page | What it shows |
|---|---|
| `/recommendations` ("For you" in the header) | Personal picks with the reason under each card. Switch between *Similar products* (item-based) and *Shoppers like you* (user-based); time of the computation; trending list; short explanation; *Rebuild now* for admins |
| Home page | *Recommended for you*: 4 products |
| Product page | *Customers who viewed this also viewed*: the product's neighbours from the matrix |
| Profile | Link to *For you* in the sidebar |

## 6. Setup and run

```bash
npm install
npm run sync-indexes        # create indexes (incl. item_similarities, reco_builds)
npm run seed:demo           # optional: 150 demo shoppers (demo1@demo.tvstore / Demo12345)
npm start                   # or: nodemon index
```

- The matrix is built at startup when it is missing or older than `RECO_REBUILD_MINUTES`
  (default 60), then every `RECO_REBUILD_MINUTES`. `RECO_SCHEDULE=off` disables the schedule.
- Manual rebuild: `npm run recs:build`, the *Rebuild now* button on `/recommendations` (admin), or
  `POST /api/recommendations/rebuild`.
- Remove the demo shoppers: `npm run seed:demo -- --clean`.
- Benchmark: `npm run bench`. It needs a MongoDB whose database name contains `bench`. The
  default is local `mongodb://127.0.0.1:27017/techstore_bench`; change it with `BENCH_MONGO_URI`.
  Results go to `docs/perf/`.

| Variable | Default | Meaning |
|---|---|---|
| `MONGO_URI` | — | Application database |
| `PORT` | 3000 | HTTP port |
| `RECO_REBUILD_MINUTES` | 60 | Matrix rebuild interval |
| `RECO_SCHEDULE` | on | `off` disables automatic rebuilds |
| `BENCH_MONGO_URI` | `mongodb://127.0.0.1:27017/techstore_bench` | Benchmark database (dropped on every run) |

## 7. Data model additions

| Collection | Documents | Indexes |
|---|---|---|
| `item_similarities` | one per product with interactions: top-40 neighbours, popularity | `{product_id: 1}` unique, `{popularity: -1}` |
| `reco_builds` | one per matrix build: time, duration, users, items, pairs | `{startedAt: -1}` |

The interaction data is not duplicated: the engine reads the history already embedded in
`users` (Assignment #6). That is also why a recommendation is cheap to personalize: the whole
profile of a user is one document read by `_id`.
