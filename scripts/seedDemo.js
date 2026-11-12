/**
 * Demo data for the recommendation system: synthetic customers with views, ratings and
 * purchases of the products already in the catalog, then a similarity-matrix build.
 *
 *   npm run seed:demo                 # 150 demo users (default)
 *   npm run seed:demo -- --users 300
 *   npm run seed:demo -- --clean      # remove all demo users
 *
 * Demo users: demo1@demo.tvstore … demoN@demo.tvstore, password Demo12345.
 * Only users with this email domain are created or removed; real accounts, products and stock
 * are not changed (synthetic purchases do not decrease stock).
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Product = require("../models/Product");
const { makeUserGenerator } = require("./lib/synthetic");
const { buildSimilarities } = require("./recommender");

const DOMAIN = "demo.tvstore";
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

// Product rating totals recomputed from all users' ratings (keeps them consistent after
// demo users are added or removed)
async function recomputeProductRatings() {
    const totals = await User.aggregate([
        { $unwind: "$view_history" },
        { $match: { "view_history.rating": { $gte: 1 } } },
        { $group: { _id: "$view_history.product_id", sum: { $sum: "$view_history.rating" }, count: { $sum: 1 } } }
    ]);
    await Product.updateMany({}, { $set: { rating_sum: 0, rating_count: 0 } });
    if (totals.length) {
        await Product.bulkWrite(totals.map(t => ({
            updateOne: { filter: { product_id: t._id }, update: { $set: { rating_sum: t.sum, rating_count: t.count } } }
        })), { ordered: false });
    }
    console.log(`Product ratings recomputed: ${totals.length} rated products`);
}

async function main() {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    const removed = await User.deleteMany({ email: new RegExp(`@${DOMAIN.replace(".", "\\.")}$`) });
    console.log(`Removed ${removed.deletedCount} previous demo users`);
    if (args.includes("--clean")) {
        await recomputeProductRatings();
        await buildSimilarities("script");
        return;
    }

    const count = parseInt(arg("users", "150"));
    const products = await Product.find({}, "product_id name price pictures brand category specs.socket").lean();
    if (products.length < 10) throw new Error("The catalog has fewer than 10 products: import products first (Products → Import from feed)");

    const generate = makeUserGenerator(products, { seed: 2026, minItems: 5, maxItems: Math.min(35, products.length), withPictures: true });
    const password = await bcrypt.hash("Demo12345", 10);
    const now = new Date();
    const docs = Array.from({ length: count }, (_, i) => ({
        username: `Demo ${i + 1}`,
        email: `demo${i + 1}@${DOMAIN}`,
        password,
        role: "user",
        profile: { city: ["Almaty", "Astana", "Shymkent", "Karaganda"][i % 4] },
        ...generate(),
        createdAt: now,
        updatedAt: now
    }));
    await User.collection.insertMany(docs, { ordered: false });
    const interactions = docs.reduce((s, d) => s + d.view_history.length, 0);
    const purchases = docs.reduce((s, d) => s + d.purchase_history.length, 0);
    console.log(`Created ${count} demo users: ${interactions} viewed products, ${purchases} purchases, catalog of ${products.length}`);
    await recomputeProductRatings();

    const stats = await buildSimilarities("script");
    console.log(`Similarity matrix: ${stats.items} items, ${stats.neighbors} neighbor links, ${stats.durationMs} ms`);
    console.log(`Log in as demo1@${DOMAIN} / Demo12345 to see personal recommendations`);
}

main()
    .then(() => mongoose.disconnect())
    .catch(err => { console.error("Seed failed:", err.message); process.exit(1); });
