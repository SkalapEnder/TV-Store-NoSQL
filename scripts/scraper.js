/**
 * Imports the catalog from the shop.kz YML feed.
 *
 *   1. Download the feed (≈40 MB, all categories of the shop).
 *   2. Stream-parse it with SAX and keep the offers of the feed categories listed in
 *      config/categories.js (feedIds): phones, TVs, PC parts, monitors, peripherals, printers.
 *   3. Parse category specs from the product name (scripts/lib/specParsers.js).
 *   4. Upsert by product_id (the feed offer id), then delete products that left the feed.
 *
 * Run:  node scripts/scraper.js                     (download)
 *       node scripts/scraper.js --file feed.xml     (use a saved copy of the feed)
 */
require("dotenv").config();
const fs = require("fs");
const axios = require("axios");
const sax = require("sax");
const iconv = require("iconv-lite");
const Product = require("../models/Product");
const { CATEGORIES, categoryForFeedId, cleanSpecs } = require("../config/categories");
const { parseSpecs, SUBCATEGORY_OVERRIDES } = require("./lib/specParsers");

// ---------- Settings ----------
const YML_URL = "https://shop.kz/bitrix/catalog_export/yandex.php";
const EXCLUDED_VENDORS = new Set(["Rombica"]);
const NAME_EXCLUDE = /^(чехол|кабель|переходник|наклейк|коврик)/i;   // accessories that slip into a category

// ---------- 1. Download the feed ----------
async function fetchYML(file) {
    let buf;
    if (file) {
        buf = fs.readFileSync(file);
    } else {
        const response = await axios.get(YML_URL, {
            responseType: "arraybuffer",
            timeout: 300000,                       // the feed is large and slow to generate
            maxContentLength: Infinity,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        });
        buf = Buffer.from(response.data);
    }
    // Read the real encoding from the XML declaration instead of assuming one
    const declared = buf.subarray(0, 200).toString("ascii").match(/encoding=["']([^"']+)["']/i);
    const encoding = declared && iconv.encodingExists(declared[1]) ? declared[1] : "utf-8";
    console.log(`Feed ${file ? "read" : "downloaded"}: ${(buf.length / 1048576).toFixed(1)} MB, encoding: ${encoding}`);
    return iconv.decode(buf, encoding);
}

// ---------- 2. Parse: keep only offers of our categories (SAX: no giant object tree) ----------
function parseOffers(xml) {
    const parser = sax.parser(true);
    const FIELDS = ["url", "vendor", "vendorCode", "model", "price", "currencyId", "categoryId", "name", "description"];
    const offers = [];
    let offer = null, paramName = null, text = "";

    parser.onopentag = node => {
        text = "";
        if (node.name === "offer") {
            offer = { id: node.attributes.id, available: node.attributes.available === "true", pictures: [], params: {} };
        } else if (offer && node.name === "param") {
            paramName = node.attributes.name;
        }
    };
    parser.ontext = t => { text += t; };
    parser.oncdata = t => { text += t; };
    parser.onclosetag = name => {
        if (offer) {
            const value = text.trim();
            if (name === "offer") {
                if (categoryForFeedId(offer.categoryId)) offers.push(offer);
                offer = null;
            } else if (name === "picture") offer.pictures.push(value);
            else if (name === "param") offer.params[paramName] = value;
            else if (FIELDS.includes(name)) offer[name] = value;
        }
        text = "";
    };
    parser.onerror = err => { throw err; };

    parser.write(xml).close();
    return offers;
}

// The feed category, corrected by the offer's own sub-category (a keyboard listed under headphones)
function categoryOf(offer) {
    const sub = offer.params.category || "";
    for (const [re, slug] of SUBCATEGORY_OVERRIDES) if (re.test(sub)) return slug;
    return categoryForFeedId(offer.categoryId).slug;
}

// "EPSON" and "Epson" are the same brand: keep the spelling used most often
function brandNormalizer(offers) {
    const spellings = new Map();
    for (const o of offers) {
        const v = (o.vendor || "").trim();
        if (!v) continue;
        const key = v.toLowerCase();
        const m = spellings.get(key) || new Map();
        m.set(v, (m.get(v) || 0) + 1);
        spellings.set(key, m);
    }
    const best = new Map([...spellings].map(([key, m]) => [key, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
    return name => best.get(String(name).trim().toLowerCase()) || String(name).trim();
}

// Offer ids are numeric ("192905"), except some marketplace offers ("ЗКЗ00000009893"):
// those get a stable number in a separate range so they never collide with the shop ids.
function productIdOf(offerId) {
    const s = String(offerId || "").trim();
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const digits = s.match(/(\d+)$/);
    return digits ? 900000000 + parseInt(digits[1], 10) : NaN;
}

// ---------- 3. Build product documents ----------
function buildProducts(offers) {
    const products = [];
    const brandOf = brandNormalizer(offers);
    let skipped = 0;

    for (const o of offers) {
        const price = Math.round(Number(o.price));
        if (!o.vendor || EXCLUDED_VENDORS.has(o.vendor)) { skipped++; continue; }
        const productId = productIdOf(o.id);
        if (!Number.isFinite(productId) || !o.name || !o.url || !Number.isFinite(price) || price <= 0 || NAME_EXCLUDE.test(o.name)) { skipped++; continue; }

        const category = categoryOf(o);
        products.push({
            product_id: productId,
            name: o.name,
            model: o.vendorCode || o.model || "—",
            price,
            currency: o.currencyId || "KZT",
            description: (o.description || "").trim(),
            url: o.url,
            available: o.available,
            brand: brandOf(o.vendor),
            category,
            group: CATEGORIES.find(c => c.slug === category).group,
            specs: cleanSpecs(category, parseSpecs(category, o)),
            pictures: o.pictures
        });
    }
    console.log(`Built ${products.length} products, skipped ${skipped} offers (no brand / price / accessories)`);
    return products;
}

// ---------- 4. Main entry point ----------
async function importProducts({ file } = {}) {
    const xml = await fetchYML(file);
    const offers = parseOffers(xml);
    console.log(`Offers in our categories: ${offers.length}`);
    if (offers.length === 0) throw new Error("No offers of the configured categories in the feed");

    const products = buildProducts(offers);
    if (products.length === 0) throw new Error("No valid products after filtering");

    // Upsert by product_id: safe to run repeatedly, nothing is deleted before new data is ready.
    // The feed has no stock levels: a new product gets a synthetic stock, an existing one keeps
    // its stock (purchases decrement it), and an unavailable one gets 0.
    const ops = products.map(p => ({
        updateOne: {
            filter: { product_id: p.product_id },
            update: [{
                $set: {
                    ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { $literal: v }])),
                    quantity: p.available
                        ? { $cond: [{ $gt: ["$quantity", 0] }, "$quantity", { $literal: 20 + Math.floor(Math.random() * 181) }] }
                        : 0,
                    rating_sum: { $ifNull: ["$rating_sum", 0] },
                    rating_count: { $ifNull: ["$rating_count", 0] }
                }
            }, { $unset: ["diagonal"] }],      // field of the old TV-only schema (now specs.diagonal)
            upsert: true
        }
    }));
    let upserted = 0, modified = 0;
    for (let i = 0; i < ops.length; i += 1000) {
        const r = await Product.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
        upserted += r.upsertedCount; modified += r.modifiedCount;
    }

    // Remove products that disappeared from the feed (and the old category scheme, if any)
    const removed = await Product.deleteMany({ product_id: { $nin: products.map(p => p.product_id) } });

    const byCategory = await Product.aggregate([{ $group: { _id: "$category", n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
    const total = byCategory.reduce((s, c) => s + c.n, 0);
    console.log(`Upserted: ${upserted}, modified: ${modified}, removed: ${removed.deletedCount}, total in DB: ${total}`);
    console.log("By category: " + byCategory.map(c => `${c._id} ${c.n}`).join(", "));
    return total;
}

module.exports = { importProducts, parseOffers, buildProducts };

// Run standalone with:  node scripts/scraper.js [--file path/to/feed.xml]
if (require.main === module) {
    const mongoose = require("mongoose");
    const i = process.argv.indexOf("--file");
    const file = i > 0 ? process.argv[i + 1] : null;
    mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("Connected to MongoDB"))
        .then(() => importProducts({ file }))
        .then(() => process.exit(0))
        .catch(err => { console.error("Import failed:", err); process.exit(1); });
}
