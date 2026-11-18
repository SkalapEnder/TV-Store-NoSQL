
# TechStore: Electronics Store with Recommendations | IT-2308 | Alisher Berik

## Description

The Final Project of Advanced Database (NoSQL) subject.
An electronics store on MongoDB Atlas: smartphones, TVs, PC components (graphics cards,
processors, motherboards, memory, storage, power supplies), monitors, keyboards, mice,
headphones and printers. The project started as a TV store (Assignment #6) and grew into a
general store with the same database and the same user / interaction model.

Project presentation: [Link](https://www.canva.com/design/DAGaaIXPnLc/tB2iQ9L4YuvMBGXciCFusQ/edit?utm_content=DAGaaIXPnLc&utm_campaign=designshare&utm_medium=link2&utm_source=sharebutton)

## Technical Description

Main collections:

1) **users**: account, profile, embedded view / rating / purchase history
2) **products**: the whole catalog in one collection. `brand` and `category` are fields of the
   product; category-specific characteristics are in `specs` (a GPU has `chip` and `memory_gb`,
   a power supply `wattage`…). Categories and their spec fields are defined in
   [config/categories.js](config/categories.js).
3) **carts**: one cart per user
4) **item_similarities**, **reco_builds**: the recommendation engine

Data model, trade-offs and indexes: [docs/DATA_MODEL.md](docs/DATA_MODEL.md).
After changing a schema, run `npm run sync-indexes` to update the indexes in MongoDB.

You can browse categories, filter each category by brand (only the brands of that category are
listed), price and its own specs (socket, video memory, screen size, wattage…), search the
catalog, rate and buy products, get personal recommendations, and manage products and users as
an administrator.

To get admin privilege, create new account and choose role 'Admin', then below appears input for secret code.

#### Secret code: admin1243

## Installation
```
npm install
npm run sync-indexes   # create the indexes
npm run import         # load the catalog from the shop.kz feed (≈5,000 products, about a minute)
```

**Upgrading a database from the TV-store version:** run `npm run import` (it rewrites every
product in the new shape and removes products that are no longer in the feed; product ids, user
histories and carts stay valid), then `npm run sync-indexes -- --drop-obsolete` to drop the old
indexes and the `brands` / `categories` collections, then `npm run recs:build`.

Then, open project folder and write next command in terminal:
```
nodemon index
```

## Final Project: Recommendation System

Personalized recommendations with **item-based collaborative filtering** on the interactions the
store already records (views, ratings 1–5, purchases embedded in `users`).

- **For you** page (`/recommendations`), *Recommended for you* on the home page, and *Customers who
  viewed this also viewed* on every product page. Each recommendation says why it was picked.
- **API:** `GET /api/recommendations`, `/popular`, `/similar/:productId`, plus admin `/users/:id`, `/status`
  and `POST /rebuild`.
- **Optimizations:** precomputed top-40 item neighbours (`item_similarities`), indexes, projections,
  an LRU cache that is dropped after the user's actions, and an hourly background rebuild.

| Document | Contents |
|---|---|
| [docs/RECOMMENDATIONS.md](docs/RECOMMENDATIONS.md) | Algorithm, design choices, API reference, setup |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Performance testing and optimization report |
| [docs/perf/RESULTS.md](docs/perf/RESULTS.md), [docs/perf/charts.html](docs/perf/charts.html) | Raw benchmark tables and charts |

### Run

```bash
npm install
npm run sync-indexes   # indexes, including the recommendation collections
npm run seed:demo      # optional demo shoppers: demo1@demo.tvstore / Demo12345
npm start
```

| Command | What it does |
|---|---|
| `npm run recs:build` | Rebuild the similarity matrix (also runs at startup and every hour) |
| `npm run seed:demo -- --users 300` | Add synthetic shoppers to see recommendations on a fresh database |
| `npm run seed:demo -- --clean` | Remove the demo shoppers |
| `npm run seed:demo -- --reviews` | Give every purchase of the existing demo shoppers a rating and a review text (new demo shoppers get them automatically) |
| `npm run bench` | Performance benchmark on a separate local database `techstore_bench` (dropped on every run) |
| `npm run import` | Import / update the catalog from the shop.kz feed (also *Products → Import from feed* in admin). `-- --file feed.xml` uses a saved copy |



