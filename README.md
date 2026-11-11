
# TV Store Website | IT-2308 | Alisher Berik

## Description

The Final Project of Advanced Database (NoSQL) subject.
The project is TV Store Website using MongoDB Atlas.

Project presentation: [Link](https://www.canva.com/design/DAGaaIXPnLc/tB2iQ9L4YuvMBGXciCFusQ/edit?utm_content=DAGaaIXPnLc&utm_campaign=designshare&utm_medium=link2&utm_source=sharebutton)

## Technical Description

The project database consists of 5 collections:

1) Users
2) Categories
3) Brands
4) Products (Consist relationships with Category and Brand)

Data model, trade-offs and indexes: [docs/DATA_MODEL.md](docs/DATA_MODEL.md).
After changing a schema, run `npm run sync-indexes` to update the indexes in MongoDB.

There you can search TV products, find TV by specific brands, or perform administrative actions (CRUD operations) (Users authentification)

To get admin privilege, create new account and choose role 'Admin', then below appears input for secret code.

#### Secret code: admin1243

## Installation
Before testing project, write next command in IDE terminal
```
npm i express ejs express-validator express-session body-parser nodemon bcryptjs mongoose passport passport-local mongodb dotenv
```

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
| `npm run bench` | Performance benchmark on a separate local database `tvstore_bench` (dropped on every run) |



