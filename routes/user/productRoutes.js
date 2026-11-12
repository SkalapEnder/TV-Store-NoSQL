const express = require("express");
const router = express.Router();
const Product = require("../../models/Product");
const { trackView, trackRating, getUserRating } = require("../../scripts/tracker");
const { similarItems } = require("../../scripts/recommender");
const catalog = require("../../scripts/catalog");
const { getCategory, getGroup, GROUPS, CATEGORIES } = require("../../config/categories");

// Catalog page. Query parameters: see scripts/catalog.js#buildFilter,
// e.g. /products?category=gpu&brand=ASUS&spec_memory_gb=12&sort=price_asc
router.get("/", async (req, res) => {
    try {
        const category = getCategory(req.query.category);
        const group = !category ? getGroup(req.query.group) : null;
        const [result, facets] = await Promise.all([
            catalog.searchProducts(req.query),
            catalog.facets(category?.slug, group?.slug)
        ]);
        res.render("products/index", {
            ...result, facets, category, group, groups: GROUPS, categories: CATEGORIES,
            query: req.query, back: req.originalUrl
        });
    } catch (err) {
        console.error("Catalog error:", err);
        res.status(500).render("templates/error", { errorMessage: "Error fetching products: " + err.message });
    }
});

// Search. Returns JSON, or the rendered product grid with ?view=grid (used by the catalog page)
router.post("/filter", async (req, res) => {
    try {
        const result = await catalog.searchProducts(req.body || {});
        if (req.query.view === "grid") {
            const params = new URLSearchParams();
            Object.entries(req.body || {}).forEach(([k, v]) => {
                (Array.isArray(v) ? v : [v]).forEach(x => { if (x !== "" && x != null) params.append(k, String(x)); });
            });
            const back = "/products" + (params.toString() ? "?" + params : "");
            return res.render("products/_grid", { ...result, back, query: req.body || {} });
        }
        res.json(result);
    } catch (err) {
        console.error("Error fetching filtered products:", err);
        res.status(500).json({ error: "Error fetching products: " + err.message });
    }
});

// Brands available in a category (JSON), e.g. GET /products/brands?category=gpu
router.get("/brands", async (req, res) => {
    try {
        const { brands } = await catalog.facets(getCategory(req.query.category)?.slug);
        res.set("Cache-Control", "public, max-age=300");
        res.json(brands);
    } catch (err) {
        res.status(500).json({ error: err.message });
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
            catalog.relatedProducts(product, 4),
            // Collaborative filtering: products that the same users interacted with
            similarItems(productId, { limit: 4 }).catch(err => { console.error("Similar items error:", err.message); return []; })
        ]);
        res.render("products/show", {
            product: catalog.withAvg(product), category: getCategory(product.category),
            userRating, related, alsoViewed, back: req.originalUrl
        });
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
        req.flash("success", previous ? `Your rating was updated to ${value} ★` : `Thank you! You rated this product ${value} ★`);
        res.redirect(303, `/products/${productId}#reviews`);
    } catch (err) {
        console.error("Error rating product:", err);
        res.status(500).render("templates/error", { errorMessage: "Could not save the rating" });
    }
});

module.exports = router;
