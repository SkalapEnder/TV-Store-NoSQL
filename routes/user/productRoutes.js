const express = require("express");
const router = express.Router();
const Product = require("../../models/Product");
const Brand = require("../../models/Brand");
const Category = require("../../models/Category");
const { trackView, trackRating, getUserRating } = require("../../scripts/tracker");
const { similarItems } = require("../../scripts/recommender");

// Fields needed by a catalog card (no description / extra pictures: smaller payload)
const CARD_FIELDS = "product_id name model price quantity diagonal brand category pictures rating_sum rating_count";
const MAX_RESULTS = 200;

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNumber = v => (v === undefined || v === null || v === "" ? null : Number(v));
const withAvg = p => ({ ...p, rating_avg: p.rating_count ? p.rating_sum / p.rating_count : null });

async function loadFilters() {
    const [brands, categories] = await Promise.all([
        Brand.find({}, "brand_id brand_name").sort({ brand_name: 1 }).lean(),
        Category.find({}, "category_id category_name").sort({ category_name: 1 }).lean()
    ]);
    return { brands, categories };
}

/**
 * Builds a MongoDB filter from search parameters. Every field is optional:
 *   q            text to find in name / model / description
 *   brand_id     brand id (exact)            category_id   category id (exact)
 *   brand        brand name (exact, any case) category     category name (exact, any case)
 *   min, max     price range                 min_diag, max_diag  diagonal range (inches)
 *   in_stock     "true" -> only products with quantity > 0
 */
function buildFilter(params) {
    const filter = {};

    const brandId = toNumber(params.brand_id);
    const categoryId = toNumber(params.category_id);
    if (Number.isInteger(brandId)) filter["brand.id"] = brandId;
    else if (params.brand && String(params.brand).trim()) {
        filter["brand.name"] = new RegExp(`^${escapeRegex(String(params.brand).trim())}$`, "i");
    }
    if (Number.isInteger(categoryId)) filter["category.id"] = categoryId;
    else if (params.category && String(params.category).trim()) {
        filter["category.name"] = new RegExp(`^${escapeRegex(String(params.category).trim())}$`, "i");
    }

    const range = (min, max) => {
        const r = {};
        if (Number.isFinite(min)) r.$gte = min;
        if (Number.isFinite(max)) r.$lte = max;
        return Object.keys(r).length ? r : null;
    };
    const price = range(toNumber(params.min), toNumber(params.max));
    if (price) filter.price = price;
    const diagonal = range(toNumber(params.min_diag), toNumber(params.max_diag));
    if (diagonal) filter.diagonal = diagonal;

    if (String(params.in_stock) === "true") filter.quantity = { $gt: 0 };
    return filter;
}

const SORTS = {
    price_asc:  { price: 1 },
    price_desc: { price: -1 },
    diagonal:   { diagonal: -1 },
    rating:     { rating_count: -1 },
    name:       { name: 1 }
};

async function searchProducts(params) {
    const filter = buildFilter(params);
    const q = String(params.q ?? params.name ?? "").trim().slice(0, 100);
    const sort = SORTS[params.sort];

    if (q) {
        // 1) Text index: fast, ranked by relevance (whole words: "Samsung", "QLED", "55")
        try {
            const textResults = await Product
                .find({ ...filter, $text: { $search: q } }, { score: { $meta: "textScore" } })
                .select(CARD_FIELDS)
                .sort(sort || { score: { $meta: "textScore" } })
                .limit(MAX_RESULTS)
                .lean();
            if (textResults.length) return textResults;
        } catch (err) {
            // Text index not built yet (run `npm run sync-indexes`): fall through to the substring search
            console.warn("Text search unavailable:", err.message);
        }

        // 2) Fallback for partial words ("sams", "UE55"): case-insensitive substring on name / model
        const rx = new RegExp(escapeRegex(q), "i");
        return Product.find({ ...filter, $or: [{ name: rx }, { model: rx }] })
            .select(CARD_FIELDS).sort(sort || { name: 1 }).limit(MAX_RESULTS).lean();
    }

    return Product.find(filter).select(CARD_FIELDS).sort(sort || { name: 1 }).limit(MAX_RESULTS).lean();
}

// Catalog page. Accepts the same query parameters as the search, e.g. /products?category_id=2&q=samsung
router.get("/", async (req, res) => {
    try {
        const [products, { brands, categories }] = await Promise.all([searchProducts(req.query), loadFilters()]);
        res.render("products/index", { products: products.map(withAvg), brands, categories, query: req.query, back: req.originalUrl });
    } catch (err) {
        res.status(500).render("templates/error", { errorMessage: "Error fetching products: " + err.message });
    }
});

// Search. Returns JSON, or the rendered product grid with ?view=grid (used by the catalog page)
router.post("/filter", async (req, res) => {
    try {
        const products = (await searchProducts(req.body)).map(withAvg);
        if (req.query.view === "grid") {
            const params = new URLSearchParams();
            Object.entries(req.body || {}).forEach(([k, v]) => { if (v !== "" && v != null) params.set(k, String(v)); });
            const back = "/products" + (params.toString() ? "?" + params : "");
            return res.render("products/_grid", { products, back });
        }
        res.json(products);
    } catch (err) {
        console.error("Error fetching filtered products:", err);
        res.status(500).json({ error: "Error fetching products: " + err.message });
    }
});

// Products of one brand (link from the brands page)
router.get("/filter/:brand", async (req, res) => {
    try {
        const brandId = parseInt(req.params.brand);
        const query = { brand_id: brandId };
        const [products, { brands, categories }] = await Promise.all([searchProducts(query), loadFilters()]);
        res.render("products/index", { products: products.map(withAvg), brands, categories, query, back: req.originalUrl });
    } catch (err) {
        console.error("Error fetching filtered products:", err);
        res.status(500).json({ error: "Error fetching products: " + err.message });
    }
});

// Product page
router.get("/:id", async (req, res) => {
    try {
        const productId = parseInt(req.params.id);
        if (Number.isNaN(productId)) return res.status(404).render("templates/error", { errorMessage: "This product does not exist.", status: 404 });

        const product = await Product.findOne({ product_id: productId }).lean();
        if (!product) return res.status(404).render("templates/error", { errorMessage: "This product does not exist or was removed.", status: 404 });
        trackView(req, product);

        const [userRating, related, alsoViewed] = await Promise.all([
            getUserRating(req.session.userId, productId),
            // Same type, closest price first (uses the category.id + price index)
            Product.find({ "category.id": product.category?.id, product_id: { $ne: productId }, quantity: { $gt: 0 } })
                .select(CARD_FIELDS).limit(24).lean()
                .then(list => list
                    .sort((a, b) => Math.abs(a.price - product.price) - Math.abs(b.price - product.price))
                    .slice(0, 4)
                    .map(withAvg)),
            // Collaborative filtering: products that the same users interacted with
            similarItems(productId, { limit: 4 }).catch(err => { console.error("Similar items error:", err.message); return []; })
        ]);
        res.render("products/show", { product: withAvg(product), userRating, related, alsoViewed, back: req.originalUrl });
    } catch (err) {
        res.status(500).render("templates/error", { errorMessage: "Error fetching product: " + err.message });
    }
});

// Rate a product (1..5). Stored in the user's history and in the product's rating totals
router.post("/:id/rate", async (req, res) => {
    try {
        const userId = req.session.userId;
        if (!userId) return res.redirect("/auth/login");

        const productId = parseInt(req.params.id);
        const value = parseInt(req.body.rating);
        if (!Number.isInteger(value) || value < 1 || value > 5) {
            return res.status(400).render("templates/error", { errorMessage: "Rating must be from 1 to 5" });
        }

        const product = await Product.findOne({ product_id: productId }).lean();
        if (!product) return res.status(404).send("Product not found");

        const previous = await trackRating(userId, product, value);
        req.flash("success", previous ? `Your rating was updated to ${value} ★` : `Thank you! You rated this TV ${value} ★`);
        res.redirect(303, `/products/${productId}#reviews`);
    } catch (err) {
        console.error("Error rating product:", err);
        res.status(500).render("templates/error", { errorMessage: "Could not save the rating" });
    }
});

module.exports = router;
