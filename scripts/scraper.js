require("dotenv").config();
const axios = require("axios");
const sax = require("sax");
const iconv = require("iconv-lite");
const cheerio = require("cheerio");
const Product = require("../models/Product");
const Brand = require("../models/Brand");
const Category = require("../models/Category");

// ---------- Settings ----------
const YML_URL = "https://shop.kz/bitrix/catalog_export/yandex.php";
const TV_CATEGORY_ID = "274";                 // TV category in the shop.kz feed
const EXCLUDED_VENDORS = new Set(["Rombica"]);
const TV_TYPES = ["OLED", "QLED", "Direct LED", "LED"];   // order matters: specific before generic
const FETCH_TYPE_FROM_PAGE = false;           // true = open every product page (slow, 1 request per TV)
const PAGE_CONCURRENCY = 5;

// ---------- 1. Download the feed ----------
async function fetchYML() {
    const response = await axios.get(YML_URL, {
        responseType: "arraybuffer",
        timeout: 180000,                       // the feed is large and slow to generate
        maxContentLength: Infinity,
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });

    const buf = Buffer.from(response.data);
    // Read the real encoding from the XML declaration instead of assuming win1251
    const declared = buf.subarray(0, 200).toString("ascii").match(/encoding=["']([^"']+)["']/i);
    const encoding = declared && iconv.encodingExists(declared[1]) ? declared[1] : "utf-8";
    console.log(`Feed downloaded: ${(buf.length / 1048576).toFixed(1)} MB, encoding: ${encoding}`);
    return iconv.decode(buf, encoding);
}

// ---------- 2. Parse: keep only TV offers (SAX: no giant object tree) ----------
function parseTVOffers(xml) {
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
                if (offer.categoryId === TV_CATEGORY_ID) offers.push(offer);
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

// ---------- 3. Brands and categories: created automatically if missing ----------
const brandCache = new Map();
const categoryCache = new Map();

async function nextId(Model, field) {
    const last = await Model.findOne().sort({ [field]: -1 }).select(field).lean();
    return last ? last[field] + 1 : 1;
}

async function ensureBrand(name) {
    if (brandCache.has(name)) return brandCache.get(name);
    let doc = await Brand.findOne({ brand_name: name });
    if (!doc) doc = await Brand.create({ brand_id: await nextId(Brand, "brand_id"), brand_name: name });
    const value = { id: doc.brand_id, name: doc.brand_name };
    brandCache.set(name, value);
    return value;
}

async function ensureCategory(name) {
    if (categoryCache.has(name)) return categoryCache.get(name);
    let doc = await Category.findOne({ category_name: name });
    if (!doc) doc = await Category.create({ category_id: await nextId(Category, "category_id"), category_name: name });
    const value = { id: doc.category_id, name: doc.category_name };
    categoryCache.set(name, value);
    return value;
}

// ---------- 4. Field helpers ----------
function detectTVType(offer) {
    const head = [offer.name, ...Object.values(offer.params)].join(" ").toUpperCase();
    const body = (offer.description || "").toUpperCase();
    for (const source of [head, body]) {
        for (const type of TV_TYPES) if (source.includes(type.toUpperCase())) return type;
    }
    return "Other";
}

function extractDiagonal(offer) {
    const param = Object.entries(offer.params).find(([key]) => /диагональ/i.test(key));
    const candidates = [param && param[1], offer.name, offer.vendorCode];
    const patterns = [/(\d{2,3})(?:[.,]\d)?\s*(?:"|”|″|''|дюйм)/i, /(\d{2,3})/];
    for (const text of candidates) {
        if (!text) continue;
        for (const pattern of patterns) {
            const match = text.match(pattern);
            const size = match && parseInt(match[1]);
            if (size >= 19 && size <= 120) return size;
        }
    }
    return null;
}

// Optional: read the TV type from the product page (original behaviour), a few pages at a time
async function getTVTypeFromPage(url) {
    try {
        const { data } = await axios.get(url, { timeout: 15000 });
        const $ = cheerio.load(data);
        let found = null;
        $("div").each((i, el) => {
            const text = $(el).text();
            if (!found && text.includes("Тип телевизора")) {
                found = TV_TYPES.find(type => text.includes(type)) || null;
            }
        });
        return found;
    } catch {
        return null;
    }
}

async function enrichTypesFromPages(offers) {
    for (let i = 0; i < offers.length; i += PAGE_CONCURRENCY) {
        const chunk = offers.slice(i, i + PAGE_CONCURRENCY);
        await Promise.all(chunk.map(async o => { o.tvType = await getTVTypeFromPage(o.url); }));
        console.log(`Page types: ${Math.min(i + PAGE_CONCURRENCY, offers.length)}/${offers.length}`);
    }
}

// ---------- 5. Build product documents ----------
async function buildProducts(offers) {
    const products = [];
    let skipped = 0;

    for (const o of offers) {
        const price = Math.round(Number(o.price));
        if (!o.vendor || EXCLUDED_VENDORS.has(o.vendor)) continue;
        if (!o.id || !o.name || !o.url || !Number.isFinite(price)) { skipped++; continue; }

        const brand = await ensureBrand(o.vendor);
        const category = await ensureCategory(o.tvType || detectTVType(o));

        products.push({
            product_id: parseInt(o.id),
            name: o.name,
            model: o.vendorCode || o.model || "Unknown Model",
            price,
            currency: o.currencyId,
            quantity: o.available ? Math.floor(Math.random() * 181) + 20 : 0,   // synthetic stock (feed has none)
            diagonal: extractDiagonal(o),
            description: (o.description || "").trim(),
            url: o.url,
            available: o.available,
            brand,
            category,
            pictures: o.pictures
        });
    }
    console.log(`Built ${products.length} products, skipped ${skipped} invalid offers`);
    return products;
}

// ---------- 6. Main entry point ----------
async function updateDailyTVProducts() {
    console.log("Fetching TV feed...");
    const xml = await fetchYML();

    const offers = parseTVOffers(xml);
    console.log(`TV offers found in feed (category ${TV_CATEGORY_ID}): ${offers.length}`);
    if (offers.length === 0) throw new Error(`No offers with categoryId ${TV_CATEGORY_ID} in the feed`);

    if (FETCH_TYPE_FROM_PAGE) await enrichTypesFromPages(offers);

    const products = await buildProducts(offers);
    if (products.length === 0) throw new Error("No valid products after filtering");

    // Upsert by product_id: safe to run repeatedly, nothing is deleted before new data is ready
    const result = await Product.bulkWrite(
        products.map(p => ({
            updateOne: { filter: { product_id: p.product_id }, update: { $set: p }, upsert: true }
        })),
        { ordered: false }
    );

    // Remove TVs that disappeared from the feed
    await Product.deleteMany({ product_id: { $nin: products.map(p => p.product_id) } });

    const total = await Product.countDocuments();
    console.log(`Upserted: ${result.upsertedCount}, modified: ${result.modifiedCount}, total in DB: ${total}`);
    return total;
}

module.exports = { updateDailyTVProducts };

// Run standalone with:  node scripts/scraper.js
if (require.main === module) {
    const mongoose = require("mongoose");
    mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => console.log("Connected to MongoDB"))
        .then(updateDailyTVProducts)
        .then(() => process.exit(0))
        .catch(err => { console.error("Scraper failed:", err); process.exit(1); });
}