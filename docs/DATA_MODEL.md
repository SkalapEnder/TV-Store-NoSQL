# Data Model

MongoDB (Atlas), accessed through Mongoose. The model is designed around the queries the
site runs most often: show the catalog with filters, open a product page, show a user's
profile with their history, and record a view, a rating or a purchase.

## Collections

| Collection   | What it stores | Key fields |
|--------------|----------------|------------|
| `users`      | Account, profile, interaction history | `email` (unique), `role`, `profile{}`, `view_history[]`, `purchase_history[]` |
| `products`   | TV catalog | `product_id` (unique), `name`, `model`, `description`, `price`, `quantity`, `diagonal`, `brand{id,name}`, `category{id,name}`, `pictures[]`, `rating_sum`, `rating_count` |
| `brands`     | Brand directory | `brand_id` (unique), `brand_name` (unique), description, headquarters, founded year, website |
| `categories` | TV types (OLED, QLED, LED, ...) | `category_id` (unique), `category_name` (unique), description |
| `carts`      | One shopping cart per user | `user_id` (unique), `products[]` (name/price/picture copied in), `cart_total` |

### Users and interactions

```js
{
  _id, username, email, password /* bcrypt */, role: "user" | "admin",
  profile: { full_name, phone, city, birth_date, about },
  view_history: [{ product_id, name, price, url, pictures, views, rating, ratedAt, lastViewed }],
  purchase_history: [{ order_id, product_id, name, price, quantity, url, picture, purchasedAt }],
  createdAt, updatedAt
}
```

Interactions recorded:

| Interaction | Where it is written | How |
|-------------|---------------------|-----|
| View        | `users.view_history` | `scripts/tracker.js#trackView`: the first view adds an entry, later views do `$inc views` and update `lastViewed`. One entry per product, capped at 100 entries (`$slice`). |
| Rating 1–5  | `users.view_history[].rating` + `products.rating_sum/rating_count` | `trackRating`: the update is conditional on the previous value, so of two simultaneous requests only one is counted; the product totals get `$inc` by the difference. |
| Purchase    | `users.purchase_history` | `scripts/purchase.js#recordPurchase`: stock is decremented atomically (`quantity: {$gte: qty}`); if a later item fails, the stock taken for earlier items is returned. |
| Cart        | `carts` | Atomic `findOneAndUpdate` takes and empties the cart, so a double click cannot buy twice. |

## Design decisions and trade-offs

### Embedding vs. referencing

| Decision | Why | Cost |
|----------|-----|------|
| **Brand and category embedded in the product as `{id, name}`** (extended reference) | The catalog card and the product page need the brand/category name: they render from one document, no `$lookup`. Filtering by `brand.id` / `category.id` uses an index on the product itself. | The name is duplicated. When an admin renames a brand or a category, `Product.updateMany` updates the copies (see `routes/admin/adminBrandRoutes.js`, `adminCategoryRoutes.js`). Renames are rare, reads are constant: a good trade. |
| **History embedded in the user** | The profile page and the "recently viewed" block read one document by `_id`. Recording a view is one `updateOne` on the same document. | A document has a 16 MB limit and grows with history. `view_history` is capped at 100 products; `purchase_history` grows with orders, which for a store user stays far below the limit. |
| **Product snapshot in the history and the cart** (name, price, picture) | Pages show the history without loading products; the purchase keeps the price that was actually paid. | The snapshot can be out of date; the view tracker refreshes it on every view. |
| **Rating totals pre-aggregated in the product** | The average is `rating_sum / rating_count`, read with the product: no scan of the users collection. | Two writes per rating (user + product). |

### Alternative: a separate `interactions` collection

```js
{ user_id, product_id, type: "view" | "rating" | "purchase", value, at }
```

| | Embedded (chosen) | Separate collection |
|---|---|---|
| User profile with history | 1 read by `_id` | query by `user_id` index, many documents |
| Record a view | 1 update | 1 insert (fast, append-only) |
| "Who interacted with product X" | multikey index on `view_history.product_id` | index on `product_id` |
| Growth | bounded by the cap | unbounded, good for analytics, needs TTL or archiving |
| Aggregations for recommendations | `$unwind` first | direct |

The embedded variant fits the current pages better. If the recommendation step of the final
project needs the full event log (for example for collaborative filtering over all users),
an append-only `interactions` collection can be added next to it without changing the pages.

### Comparison of NoSQL models for this platform

| Model | Example | Strengths here | Weaknesses here |
|-------|---------|----------------|-----------------|
| **Document** (chosen) | MongoDB | Products have different attributes from the feed; nested objects (brand, history) map to one document; rich secondary indexes, text search, aggregation pipeline. | Joins (`$lookup`) are slower than in SQL, so data is denormalized and must be kept in step. |
| Key-value | Redis | Very fast counters, sessions, "recently viewed" lists, cache of popular products. | No queries by attributes (price range, brand): search would need to be built by hand. Good as a cache next to MongoDB, not as the main store. |
| Graph | Neo4j | User–product–brand relations and "users who bought X also bought Y" are natural graph traversals. | Catalog filtering by price/diagonal and full-text search are not its strength; a second database would be needed for the catalog. |
| Wide-column | Cassandra | Huge write volume of events, time-ordered per user. | Queries must be designed per table in advance; ad-hoc filters of the catalog are not possible. Too heavy for this data size. |

## Indexes

Every index serves a concrete query. Indexes are declared in the models and created by
Mongoose on startup. After a schema change run `npm run sync-indexes`
(`scripts/syncIndexes.js`): it creates missing indexes, rebuilds changed ones and drops unused ones.

| Collection | Index | Query it serves |
|------------|-------|-----------------|
| products | `{product_id: 1}` unique | Product page, cart, purchase, scraper upsert |
| products | text `{name: 10, model: 5, description: 1}`, `default_language: "none"` | Search box: `$text` with relevance ranking; no stemming, so Russian and English names both work |
| products | `{"category.id": 1, price: 1}` | Category filter + price range / price sort (equality field first, then range: ESR rule) |
| products | `{"brand.id": 1, price: 1}` | Brand filter + price range / sort; brand page `/products/filter/:brand` |
| products | `{price: 1}` | Price range without brand/category, price sort |
| products | `{diagonal: 1}` | Screen size range |
| users | `{email: 1}` unique | Login, duplicate check at registration |
| users | `{"view_history.product_id": 1}` multikey | Update of a history entry; "users who viewed X" for recommendations |
| users | `{"purchase_history.product_id": 1}` multikey | "Users who bought X" for recommendations |
| brands | `{brand_id: 1}` unique, `{brand_name: 1}` unique | Brand lookup by id (admin) and by name (scraper) |
| categories | `{category_id: 1}` unique, `{category_name: 1}` unique | Same as brands |
| carts | `{user_id: 1}` unique | Cart page, add to cart, purchase; guarantees one cart per user |

Search without a whole-word match (for example `sams` or part of a model number) falls back
to a case-insensitive substring match on `name` / `model`, still limited by the other filters,
which use the indexes above. Results are capped at 200 and only the fields a card needs are returned.

To check that a query uses an index:

```js
db.products.find({ "category.id": 2, price: { $lte: 300000 } }).sort({ price: 1 }).explain("executionStats")
// winningPlan -> IXSCAN on category.id_1_price_1
```

## Search

`POST /products/filter` (JSON) and `GET /products?...` accept the same optional parameters:

| Parameter | Meaning |
|-----------|---------|
| `q` | Text in name / model / description |
| `brand_id`, `category_id` | Exact brand / category (also `brand`, `category` by name, case-insensitive) |
| `min`, `max` | Price range (KZT) |
| `min_diag`, `max_diag` | Diagonal range (inches) |
| `in_stock=true` | Only products with `quantity > 0` |
| `sort` | `price_asc`, `price_desc`, `diagonal`, `rating`, `name` (default: relevance for text search, otherwise name) |

All user input is escaped before it is used in a regular expression.
