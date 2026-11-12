# Data Model

MongoDB (Atlas), accessed through Mongoose. The model is designed around the queries the
site runs most often: show the catalog with filters, open a product page, show a user's
profile with their history, and record a view, a rating or a purchase.

## Collections

| Collection   | What it stores | Key fields |
|--------------|----------------|------------|
| `users`      | Account, profile, interaction history | `email` (unique), `role`, `profile{}`, `view_history[]`, `purchase_history[]` |
| `products`   | The whole catalog: phones, TVs, PC components, monitors, peripherals, printers | `product_id` (unique), `name`, `model`, `description`, `price`, `quantity`, `brand`, `category`, `group`, `specs{}`, `pictures[]`, `rating_sum`, `rating_count` |
| `carts`      | One shopping cart per user | `user_id` (unique), `products[]` (name/price/picture copied in), `cart_total` |

The store grew from a TV shop (Assignment #6) into a general electronics store. The `brands` and
`categories` collections of the TV model were removed: brand and category are now values on the
product (see *Products: one collection, many shapes* below). `npm run sync-indexes -- --drop-obsolete`
drops the old collections.

### Products: one collection, many shapes

```js
{
  product_id: 187883, name: "Видеокарта ASUS RTX 5070 TUF Gaming OC Edition, 12 GB, GeForce RTX 5070",
  model: "TUF-RTX5070-O12G-GAMING", price: 489990, currency: "KZT", quantity: 42, available: true,
  brand: "ASUS",                         // plain value, no brands collection
  category: "gpu", group: "pc-parts",    // slugs defined in config/categories.js
  specs: { chip_vendor: "NVIDIA", chip: "RTX 5070", memory_gb: 12 },   // shape depends on category
  pictures: ["https://static.shop.kz/…"], url: "https://shop.kz/offer/…",
  rating_sum: 37, rating_count: 9
}
```

| Category (`category`) | Group | `specs` fields |
|---|---|---|
| `phone` Smartphones | phones-tv | `storage_gb`, `ram_gb`, `color` |
| `tv` Televisions | phones-tv | `diagonal`, `panel` |
| `gpu` Graphics cards | pc-parts | `chip_vendor`, `chip`, `memory_gb` |
| `cpu` Processors | pc-parts | `series`, `socket`, `packaging`, `cooler` |
| `motherboard` Motherboards | pc-parts | `socket`, `chipset`, `memory`, `wifi` |
| `ram` Memory | pc-parts | `type`, `capacity_gb`, `speed_mhz`, `modules` |
| `storage` Storage | pc-parts | `type`, `capacity_gb`, `form_factor`, `interface` |
| `psu` Power supplies | pc-parts | `wattage`, `form_factor` |
| `monitor` Monitors | peripherals | `diagonal`, `refresh_hz`, `color` |
| `keyboard` Keyboards | peripherals | `connection`, `mechanical`, `gaming`, `color` |
| `mouse` Mice | peripherals | `connection`, `gaming`, `color` |
| `headphones` Headphones | peripherals | `connection`, `microphone`, `color` |
| `printer` Printers & MFPs | office | `device`, `technology` |

- **Polymorphic pattern.** All products live in one collection, so search, cart, purchase,
  ratings and recommendations work the same for every product, and a recommendation can cross
  categories (a GPU → a power supply). The common fields are typed; the category-specific ones
  are in `specs` (a Mongoose `Mixed` field).
- **Categories are configuration, not data.** `config/categories.js` lists the groups and
  categories, the feed categories each one imports, and the spec fields with their type, unit
  and filter kind. A category is code because it also defines the shape of `specs` and the
  filters of its page. The schema's `pre("validate")` hook keeps `specs` consistent with that
  definition (`cleanSpecs`: unknown keys dropped, numbers and booleans coerced) and copies `group`.
- **Brand is a value.** The brand list of a category is `Product.distinct("brand", { category })`
  (a DISTINCT_SCAN on `{category, brand, price}`); the catalog shows it with counts from a
  `$facet` aggregation. Removing the brands collection removed a lookup and the work of keeping
  copied brand names in step.
- **Where the specs come from.** The shop.kz feed has no structured characteristics, but the
  names follow a pattern per category (`"DDR-5 DIMM 32 GB 6000 MHz …, 2x 16 GB Kit"`).
  `scripts/lib/specParsers.js` extracts the specs with one parser per category; 90–100 % of
  products get each filterable field.

#### Alternative: the attribute pattern

```js
specs: [{ k: "socket", v: "AM5" }, { k: "memory_gb", v: 12 }]      // + index { "specs.k": 1, "specs.v": 1 }
```

One compound multikey index would serve a filter on any spec. It was not chosen: the specs are
always read and filtered together with `category`, which narrows the scan to at most ~900
products through the `{category, …}` indexes, and the object form is easier to read, display and
update. If the catalog grew to hundreds of thousands of products per category, the attribute
pattern (or a wildcard index `{"specs.$**": 1}`) would be the next step.

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
| **Brand and category as plain values on the product** (`brand: "ASUS"`, `category: "gpu"`) | The catalog card and the product page render from one document, no `$lookup`. Filters use indexes on the product itself. The brands of a category are a distinct query. | Brand spelling must be consistent: the importer merges spellings that differ only in case ("EPSON" / "Epson"). Category names, icons and spec definitions live in code (`config/categories.js`). |
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
| products | text `{name: 10, model: 5, brand: 5, description: 1}`, `default_language: "none"` | Search box: `$text` with relevance ranking; no stemming, so Russian and English names both work |
| products | `{category: 1, price: 1}` | Category page + price range / price sort (equality field first, then range: ESR rule); "similar products at this price" on the product page |
| products | `{category: 1, brand: 1, price: 1}` | Brand list of a category (DISTINCT_SCAN), category + brand filter |
| products | `{group: 1, price: 1}` | Group pages ("PC components") |
| products | `{brand: 1, price: 1}` | Brand link on the product page across categories |
| products | `{price: 1}` | Price range without category, price sort |
| users | `{email: 1}` unique | Login, duplicate check at registration |
| users | `{"view_history.product_id": 1}` multikey | Update of a history entry; "users who viewed X" for recommendations |
| users | `{"purchase_history.product_id": 1}` multikey | "Users who bought X" for recommendations |
| carts | `{user_id: 1}` unique | Cart page, add to cart, purchase; guarantees one cart per user |

Search without a whole-word match (for example `sams` or part of a model number) falls back
to a case-insensitive substring match on `name` / `model` / `brand`, still limited by the other
filters, which use the indexes above. Results are paginated (48 per page) and only the fields a card
needs are returned. Spec filters (`specs.socket`, `specs.memory_gb`…) are not indexed: they are
always combined with `category`, so the index narrows the scan to one category first.

To check that a query uses an index:

```js
db.products.find({ category: "gpu", price: { $lte: 300000 } }).sort({ price: 1 }).explain("executionStats")
// winningPlan -> IXSCAN on category_1_price_1
```

## Search

`POST /products/filter` (JSON) and `GET /products?...` accept the same optional parameters:

| Parameter | Meaning |
|-----------|---------|
| `q` | Text in name / model / brand / description |
| `category` | Category slug (`gpu`, `phone`, `tv`…); enables the spec filters of that category |
| `group` | Group slug (`phones-tv`, `pc-parts`, `peripherals`, `office`) |
| `brand` | Exact brand name; may repeat (`brand=ASUS&brand=MSI`) |
| `min`, `max` | Price range (KZT) |
| `spec_<key>` | Value of a "select" spec, may repeat (`spec_socket=AM5`); `true` for a yes/no spec (`spec_wifi=true`) |
| `spec_<key>_min`, `spec_<key>_max` | Range of a numeric spec (`spec_wattage_min=750`) |
| `in_stock=true` | Only products with `quantity > 0` |
| `sort` | `price_asc`, `price_desc`, `rating`, `name` (default: relevance for text search, otherwise price) |
| `page` | Page number (48 products per page) |

Spec parameters are read only for the keys the category declares, so a request cannot filter on
arbitrary fields. `GET /products/brands?category=gpu` returns the brands of a category with counts.

All user input is escaped before it is used in a regular expression.
