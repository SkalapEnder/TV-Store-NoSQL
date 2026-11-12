/**
 * Recommendations API (JSON). Mounted at /api/recommendations
 *
 *   GET  /                      personalized recommendations for the logged-in user
 *                               ?limit=1..48  ?algorithm=item|user
 *   GET  /popular               trending products (no login needed)            ?limit
 *   GET  /similar/:productId    "customers who viewed this also viewed"        ?limit
 *   GET  /users/:userId         recommendations for any user (admin)           ?limit ?algorithm
 *   GET  /status                last similarity build, cache statistics (admin)
 *   POST /rebuild               rebuild the similarity matrix now (admin)
 */
const express = require("express");
const router = express.Router();
const reco = require("../../scripts/recommender");

const clampLimit = v => Math.min(Math.max(parseInt(v) || 12, 1), reco.CONFIG.maxResults);
const algorithmOf = v => (v === "user" ? "user" : "item");

// Compact item for the API response
const toApi = p => ({
    product_id: p.product_id,
    name: p.name,
    model: p.model,
    price: p.price,
    brand: p.brand,
    category: p.category,
    specs: p.specs || {},
    picture: (p.pictures || [])[0] || null,
    rating_avg: p.rating_avg ? Math.round(p.rating_avg * 10) / 10 : null,
    score: p.score,
    reason: p.reason,
    url: `/products/${p.product_id}`
});

const requireLogin = (req, res, next) =>
    req.session.userId ? next() : res.status(401).json({ error: "Log in to get personal recommendations" });
const requireAdmin = (req, res, next) =>
    req.session.userStatus === "admin" ? next() : res.status(403).json({ error: "Administrators only" });

async function sendRecommendations(res, userId, query) {
    const result = await reco.recommendForUser(userId, { limit: clampLimit(query.limit), algorithm: algorithmOf(query.algorithm) });
    if (!result) return res.status(404).json({ error: "User not found" });
    // Personal results are cached on the server, which drops them after a new view/rating/purchase;
    // a browser cache would keep showing stale results, so it must revalidate every time
    res.set("Cache-Control", "private, no-cache");
    res.json({ ...result, items: result.items.map(toApi) });
}

router.get("/", requireLogin, async (req, res) => {
    try {
        await sendRecommendations(res, req.session.userId, req.query);
    } catch (err) {
        console.error("Recommendations API error:", err);
        res.status(500).json({ error: "Could not build recommendations" });
    }
});

router.get("/popular", async (req, res) => {
    try {
        const t0 = Date.now();
        const items = await reco.popular({ limit: clampLimit(req.query.limit) });
        res.set("Cache-Control", "public, max-age=300");
        res.json({ algorithm: "popularity", tookMs: Date.now() - t0, items: items.map(toApi) });
    } catch (err) {
        console.error("Popular API error:", err);
        res.status(500).json({ error: "Could not load popular products" });
    }
});

router.get("/similar/:productId", async (req, res) => {
    try {
        const productId = parseInt(req.params.productId);
        if (Number.isNaN(productId)) return res.status(400).json({ error: "Invalid product id" });
        const t0 = Date.now();
        const items = await reco.similarItems(productId, { limit: clampLimit(req.query.limit || 8) });
        res.set("Cache-Control", "public, max-age=300");
        res.json({ product_id: productId, algorithm: "item-based", tookMs: Date.now() - t0, items: items.map(toApi) });
    } catch (err) {
        console.error("Similar API error:", err);
        res.status(500).json({ error: "Could not load similar products" });
    }
});

router.get("/users/:userId", requireAdmin, async (req, res) => {
    try {
        await sendRecommendations(res, req.params.userId, req.query);
    } catch (err) {
        console.error("Recommendations API error:", err);
        res.status(500).json({ error: "Could not build recommendations" });
    }
});

router.get("/status", requireAdmin, async (req, res) => {
    try {
        res.json({ lastBuild: await reco.lastBuild(), cache: reco.getCacheStats(), config: reco.CONFIG });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/rebuild", requireAdmin, async (req, res) => {
    try {
        const stats = await reco.buildSimilarities("manual");
        res.json({ ok: true, ...stats });
    } catch (err) {
        console.error("Rebuild error:", err);
        res.status(500).json({ error: "Rebuild failed: " + err.message });
    }
});

module.exports = router;
