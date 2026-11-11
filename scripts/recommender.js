/**
 * Recommendation engine: collaborative filtering on the interactions embedded in `users`
 * (view_history: views + ratings, purchase_history).
 *
 *  - Item-based CF (main algorithm). An offline job computes, for every product, its top-K most
 *    similar products (cosine similarity of the item vectors over users, with significance
 *    shrinkage) and stores them in `item_similarities`. A recommendation for a user is then:
 *    score(j) = Σ_i sim(i, j) · w(u, i) · decay(i) over the items i the user interacted with.
 *    Online cost: 3 indexed queries + a cache.
 *  - User-based CF (alternative, computed on the fly). Finds users who interacted with the same
 *    products (multikey index on view_history.product_id), takes the most similar ones and
 *    recommends what they liked. No precomputation, but the cost grows with the database;
 *    kept for comparison in the performance report.
 *  - Cold start: popularity ("trending"), preferring the user's favourite categories.
 */
const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const ItemSimilarity = require("../models/ItemSimilarity");
const RecoBuild = require("../models/RecoBuild");

// ---------- Settings ----------
const CONFIG = {
    neighborsPerItem: 40,     // K: similar items kept per product
    minCoUsers: 2,            // pairs seen together by fewer users are ignored (noise)
    shrinkage: 5,             // sim *= co / (co + shrinkage): trusts pairs with more evidence
    maxItemsPerUser: 60,      // most recent interactions used per user (build and query)
    halfLifeDays: 60,         // time decay of a user's interactions at query time
    maxResults: 48,           // recommendations computed and cached per user
    userBasedNeighbors: 50,   // user-based CF: k nearest users
    userBasedCandidates: 3000,// user-based CF: max candidate users read
    cacheTtlMs: 5 * 60 * 1000,
    cacheMaxEntries: 5000
};

const CARD_FIELDS = "product_id name model price quantity diagonal brand category pictures rating_sum rating_count";

// ---------- Interaction weights ----------
// Implicit + explicit feedback mixed into one weight per (user, item), 0..10.
//   view:     1 + ln(views), at most 3      (interest, grows slowly with repeated views)
//   purchase: +4                             (strongest positive signal)
//   rating:   (rating - 3) * 1.5             (5★ = +3, 4★ = +1.5, 2★ = -1.5, 1★ = -3)
// Items whose weight drops to 0 or below (disliked) are not used as positive evidence.
function interactionWeights(user, { withTime = false } = {}) {
    const map = new Map();   // product_id -> { w, at }
    for (const v of user.view_history || []) {
        const pid = Number(v.product_id);
        if (!Number.isFinite(pid)) continue;
        let w = v.views > 0 ? Math.min(1 + Math.log(v.views), 3) : 0;
        if (v.rating) w += (v.rating - 3) * 1.5;
        const at = v.lastViewed || v.ratedAt;
        map.set(pid, { w, at, rating: v.rating || null });
    }
    for (const p of user.purchase_history || []) {
        const pid = Number(p.product_id);
        if (!Number.isFinite(pid)) continue;
        const e = map.get(pid) || { w: 0, at: p.purchasedAt, rating: null };
        if (!e.purchased) e.w += 4;           // several purchases of one item count once
        e.purchased = true;
        if (p.purchasedAt && (!e.at || p.purchasedAt > e.at)) e.at = p.purchasedAt;
        map.set(pid, e);
    }

    let entries = [...map.entries()].map(([pid, e]) => ({ pid, ...e, w: Math.min(e.w, 10) }));
    entries.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));
    entries = entries.slice(0, CONFIG.maxItemsPerUser);
    if (!withTime) return entries;

    const now = Date.now();
    return entries.map(e => {
        const ageDays = e.at ? (now - new Date(e.at).getTime()) / 86400000 : 0;
        return { ...e, decay: Math.pow(0.5, Math.max(ageDays, 0) / CONFIG.halfLifeDays) };
    });
}

// Projection with only the fields the engine needs (keeps documents read small)
const HISTORY_PROJECTION = {
    "view_history.product_id": 1, "view_history.views": 1, "view_history.rating": 1,
    "view_history.lastViewed": 1, "view_history.ratedAt": 1,
    "purchase_history.product_id": 1, "purchase_history.purchasedAt": 1
};

// ---------- Cache (in-memory LRU with TTL) ----------
const cache = new Map();
const cacheStats = { hits: 0, misses: 0 };
function cacheGet(key) {
    const e = cache.get(key);
    if (!e) { cacheStats.misses++; return null; }
    if (e.expires < Date.now()) { cache.delete(key); cacheStats.misses++; return null; }
    cache.delete(key); cache.set(key, e);           // move to the end: most recently used
    cacheStats.hits++;
    return e.value;
}
function cacheSet(key, value) {
    cache.set(key, { value, expires: Date.now() + CONFIG.cacheTtlMs });
    while (cache.size > CONFIG.cacheMaxEntries) cache.delete(cache.keys().next().value);
}
/** Drops a user's cached recommendations (called after a view, rating or purchase) */
function invalidateUser(userId) {
    if (!userId) return;
    for (const algo of ["item", "user"]) cache.delete(`u:${algo}:${userId}`);
}
function clearCache() { cache.clear(); }
function getCacheStats() { return { entries: cache.size, ...cacheStats, ttlMs: CONFIG.cacheTtlMs }; }

// ---------- Offline build: item-item similarity matrix ----------
let building = null;

/**
 * Reads all users' interactions (streamed with a cursor), computes cosine similarities between
 * items and stores the top-K neighbors of each item in `item_similarities`.
 * Concurrent calls share one run.
 */
function buildSimilarities(trigger = "manual") {
    if (!building) {
        building = runBuild(trigger).finally(() => { building = null; });
    }
    return building;
}

async function runBuild(trigger) {
    const startedAt = new Date();
    const t0 = Date.now();

    const index = new Map();       // product_id -> dense index
    const ids = [];                // dense index -> product_id
    const idx = pid => {
        let i = index.get(pid);
        if (i === undefined) { i = ids.length; index.set(pid, i); ids.push(pid); }
        return i;
    };
    let norms = new Float64Array(1024);
    let popularity = new Float64Array(1024);
    let counts = new Uint32Array(1024);
    const grow = n => {
        if (n < norms.length) return;
        const size = Math.max(n + 1, norms.length * 2);
        const nn = new Float64Array(size); nn.set(norms); norms = nn;
        const np = new Float64Array(size); np.set(popularity); popularity = np;
        const nc = new Uint32Array(size); nc.set(counts); counts = nc;
    };
    const pairs = new Map();       // a * 2^21 + b  (a < b)  ->  [dot, co]
    const KEY = 2097152;           // 2^21: supports up to ~2M distinct items
    let users = 0;

    const cursor = User.find({}, HISTORY_PROJECTION).lean().cursor({ batchSize: 1000 });
    for await (const user of cursor) {
        const items = interactionWeights(user).filter(e => e.w > 0);
        if (!items.length) continue;
        users++;
        const vec = items.map(e => [idx(e.pid), e.w]);
        grow(ids.length);
        for (const [i, w] of vec) { norms[i] += w * w; popularity[i] += w; counts[i]++; }
        for (let x = 0; x < vec.length; x++) {
            for (let y = x + 1; y < vec.length; y++) {
                let [a, wa] = vec[x], [b, wb] = vec[y];
                if (a > b) { [a, b] = [b, a]; [wa, wb] = [wb, wa]; }
                const key = a * KEY + b;
                const p = pairs.get(key);
                if (p) { p[0] += wa * wb; p[1]++; } else pairs.set(key, [wa * wb, 1]);
            }
        }
    }

    // Top-K neighbors per item
    const neighbors = Array.from({ length: ids.length }, () => []);
    for (const [key, [dot, co]] of pairs) {
        if (co < CONFIG.minCoUsers) continue;
        const a = Math.floor(key / KEY), b = key % KEY;
        const cos = dot / (Math.sqrt(norms[a]) * Math.sqrt(norms[b]));
        const score = cos * (co / (co + CONFIG.shrinkage));
        if (score <= 0) continue;
        neighbors[a].push({ product_id: ids[b], score, co });
        neighbors[b].push({ product_id: ids[a], score, co });
    }

    const builtAt = new Date();
    let stored = 0;
    const ops = ids.map((pid, i) => {
        const top = neighbors[i].sort((x, y) => y.score - x.score).slice(0, CONFIG.neighborsPerItem)
            .map(n => ({ product_id: n.product_id, score: Math.round(n.score * 1e4) / 1e4, co: n.co }));
        stored += top.length;
        return {
            replaceOne: {
                filter: { product_id: pid },
                replacement: { product_id: pid, neighbors: top, popularity: Math.round(popularity[i] * 100) / 100, interactions: counts[i], builtAt },
                upsert: true
            }
        };
    });
    for (let i = 0; i < ops.length; i += 1000) {
        await ItemSimilarity.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    }
    // Items nobody interacts with any more
    await ItemSimilarity.deleteMany({ builtAt: { $lt: builtAt } });

    const stats = {
        startedAt, durationMs: Date.now() - t0, users, items: ids.length,
        pairs: pairs.size, neighbors: stored, trigger
    };
    await RecoBuild.create(stats);
    clearCache();
    return stats;
}

async function lastBuild() {
    return RecoBuild.findOne().sort({ startedAt: -1 }).lean();
}

// ---------- Helpers ----------
async function loadProducts(ranked, { limit, excludeIds = new Set() } = {}) {
    const wanted = ranked.filter(r => !excludeIds.has(r.product_id)).slice(0, limit * 2);
    if (!wanted.length) return [];
    const docs = await Product.find({ product_id: { $in: wanted.map(r => r.product_id) }, quantity: { $gt: 0 } })
        .select(CARD_FIELDS).lean();
    const byId = new Map(docs.map(d => [d.product_id, d]));
    return wanted
        .filter(r => byId.has(r.product_id))
        .slice(0, limit)
        .map(r => {
            const p = byId.get(r.product_id);
            return { ...p, rating_avg: p.rating_count ? p.rating_sum / p.rating_count : null, score: r.score, reason: r.reason || null };
        });
}

async function names(productIds) {
    if (!productIds.length) return new Map();
    const docs = await Product.find({ product_id: { $in: productIds } }, "product_id name").lean();
    return new Map(docs.map(d => [d.product_id, d.name]));
}

// ---------- Popular / trending (cold start) ----------
async function popular({ limit = 12, categoryIds = null, excludeIds = new Set() } = {}) {
    const key = "p:top200";
    let ranked = cacheGet(key);
    if (!ranked) {
        const top = await ItemSimilarity.find({}, "product_id popularity").sort({ popularity: -1 }).limit(200).lean();
        ranked = top.map(t => ({ product_id: t.product_id, score: t.popularity, reason: { type: "popular" } }));
        if (ranked.length < 200) {
            // No interaction data yet: fall back to the products with most ratings
            const more = await Product.find({ quantity: { $gt: 0 } }, "product_id rating_count").sort({ rating_count: -1 }).limit(200).lean();
            const seen = new Set(ranked.map(r => r.product_id));
            more.forEach(m => { if (!seen.has(m.product_id)) ranked.push({ product_id: m.product_id, score: 0, reason: { type: "popular" } }); });
        }
        cacheSet(key, ranked);
    }
    let list = await loadProducts(ranked, { limit: limit * 3, excludeIds });
    if (categoryIds && categoryIds.length) {
        // Prefer the user's favourite categories, keep popularity order inside each group
        const fav = new Set(categoryIds);
        list = [...list.filter(p => fav.has(p.category?.id)), ...list.filter(p => !fav.has(p.category?.id))];
    }
    return list.slice(0, limit);
}

// ---------- Item-based recommendations ----------
async function recommendItemBased(userId, { limit = 12 } = {}) {
    const t0 = Date.now();
    const key = `u:item:${userId}`;
    const cached = cacheGet(key);
    if (cached) return { ...cached, items: cached.items.slice(0, limit), cached: true, tookMs: Date.now() - t0 };

    const user = await User.findById(userId, HISTORY_PROJECTION).lean();
    if (!user) return null;
    const profile = interactionWeights(user, { withTime: true });
    const seen = new Set(profile.map(e => e.pid));
    const positive = profile.filter(e => e.w > 0);

    let ranked = [];
    if (positive.length) {
        const sims = await ItemSimilarity.find({ product_id: { $in: positive.map(e => e.pid) } }, "product_id neighbors").lean();
        const weightOf = new Map(positive.map(e => [e.pid, e.w * e.decay]));
        const scores = new Map();     // candidate -> { score, best: { pid, contrib } }
        for (const s of sims) {
            const wu = weightOf.get(s.product_id) || 0;
            for (const n of s.neighbors) {
                if (seen.has(n.product_id)) continue;
                const contrib = n.score * wu;
                const e = scores.get(n.product_id) || { score: 0, best: null };
                e.score += contrib;
                if (!e.best || contrib > e.best.contrib) e.best = { pid: s.product_id, contrib };
                scores.set(n.product_id, e);
            }
        }
        ranked = [...scores.entries()]
            .map(([pid, e]) => ({ product_id: pid, score: Math.round(e.score * 1e4) / 1e4, because: e.best.pid }))
            .sort((a, b) => b.score - a.score)
            .slice(0, CONFIG.maxResults * 2);
        const because = await names([...new Set(ranked.slice(0, CONFIG.maxResults).map(r => r.because))]);
        ranked.forEach(r => {
            const viewed = profile.find(e => e.pid === r.because);
            r.reason = { type: viewed?.purchased ? "bought" : (viewed?.rating >= 4 ? "rated" : "viewed"), product_id: r.because, name: because.get(r.because) || null };
        });
    }

    let items = await loadProducts(ranked, { limit: CONFIG.maxResults, excludeIds: seen });
    const personalized = items.length;
    if (items.length < CONFIG.maxResults) {
        // Not enough collaborative signal (new user / rare items): fill with trending items
        // from the categories the user looked at
        const catIds = await favouriteCategories(profile);
        const exclude = new Set([...seen, ...items.map(i => i.product_id)]);
        items = items.concat(await popular({ limit: CONFIG.maxResults - items.length, categoryIds: catIds, excludeIds: exclude }));
    }

    const result = {
        userId: String(userId), algorithm: "item-based", generatedAt: new Date(),
        interactions: profile.length, personalized, items
    };
    cacheSet(key, result);
    return { ...result, items: items.slice(0, limit), cached: false, tookMs: Date.now() - t0 };
}

async function favouriteCategories(profile) {
    const top = profile.filter(e => e.w > 0).slice(0, 20);
    if (!top.length) return [];
    const docs = await Product.find({ product_id: { $in: top.map(e => e.pid) } }, "product_id category.id").lean();
    const score = new Map();
    const w = new Map(top.map(e => [e.pid, e.w]));
    docs.forEach(d => { const c = d.category?.id; if (c != null) score.set(c, (score.get(c) || 0) + (w.get(d.product_id) || 0)); });
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
}

// ---------- User-based recommendations (on the fly) ----------
async function recommendUserBased(userId, { limit = 12, useCache = true } = {}) {
    const t0 = Date.now();
    const key = `u:user:${userId}`;
    if (useCache) {
        const cached = cacheGet(key);
        if (cached) return { ...cached, items: cached.items.slice(0, limit), cached: true, tookMs: Date.now() - t0 };
    }

    const user = await User.findById(userId, HISTORY_PROJECTION).lean();
    if (!user) return null;
    const profile = interactionWeights(user, { withTime: true });
    const seen = new Set(profile.map(e => e.pid));
    const mine = new Map(profile.filter(e => e.w > 0).map(e => [e.pid, e.w * e.decay]));
    let ranked = [];
    let candidatesRead = 0;

    if (mine.size) {
        const itemIds = [...mine.keys()];
        // Users who interacted with at least one of the same products (multikey indexes)
        const candidates = await User.find({
            _id: { $ne: user._id },
            $or: [{ "view_history.product_id": { $in: itemIds } }, { "purchase_history.product_id": { $in: itemIds } }]
        }, HISTORY_PROJECTION).limit(CONFIG.userBasedCandidates).lean();
        candidatesRead = candidates.length;

        const myNorm = Math.sqrt([...mine.values()].reduce((s, w) => s + w * w, 0));
        const neighbours = [];
        for (const c of candidates) {
            const theirs = interactionWeights(c).filter(e => e.w > 0);
            let dot = 0, norm = 0;
            for (const e of theirs) { norm += e.w * e.w; const m = mine.get(e.pid); if (m) dot += m * e.w; }
            if (!dot) continue;
            neighbours.push({ sim: dot / (myNorm * Math.sqrt(norm)), items: theirs });
        }
        neighbours.sort((a, b) => b.sim - a.sim);
        const scores = new Map();
        for (const n of neighbours.slice(0, CONFIG.userBasedNeighbors)) {
            for (const e of n.items) {
                if (seen.has(e.pid)) continue;
                scores.set(e.pid, (scores.get(e.pid) || 0) + n.sim * e.w);
            }
        }
        ranked = [...scores.entries()]
            .map(([pid, s]) => ({ product_id: pid, score: Math.round(s * 1e4) / 1e4, reason: { type: "similar-users" } }))
            .sort((a, b) => b.score - a.score)
            .slice(0, CONFIG.maxResults * 2);
    }

    let items = await loadProducts(ranked, { limit: CONFIG.maxResults, excludeIds: seen });
    const personalized = items.length;
    if (items.length < CONFIG.maxResults) {
        const exclude = new Set([...seen, ...items.map(i => i.product_id)]);
        items = items.concat(await popular({ limit: CONFIG.maxResults - items.length, excludeIds: exclude }));
    }
    const result = {
        userId: String(userId), algorithm: "user-based", generatedAt: new Date(),
        interactions: profile.length, personalized, candidatesRead, items
    };
    if (useCache) cacheSet(key, result);
    return { ...result, items: items.slice(0, limit), cached: false, tookMs: Date.now() - t0 };
}

// ---------- "Customers who viewed this also viewed" ----------
async function similarItems(productId, { limit = 8 } = {}) {
    const pid = Number(productId);
    const key = `s:${pid}`;
    let ranked = cacheGet(key);
    if (!ranked) {
        const doc = await ItemSimilarity.findOne({ product_id: pid }, "neighbors").lean();
        ranked = (doc?.neighbors || []).map(n => ({ product_id: n.product_id, score: n.score, reason: { type: "also-viewed", co: n.co } }));
        cacheSet(key, ranked);
    }
    return loadProducts(ranked, { limit, excludeIds: new Set([pid]) });
}

/** Main entry point used by the pages and the API */
function recommendForUser(userId, { limit = 12, algorithm = "item" } = {}) {
    if (!userId || !mongoose.isValidObjectId(userId)) return Promise.resolve(null);
    return algorithm === "user" ? recommendUserBased(userId, { limit }) : recommendItemBased(userId, { limit });
}

// ---------- Scheduling ----------
/** Builds on startup when the matrix is missing or old, then every `everyMinutes` */
function scheduleBuilds(everyMinutes = Number(process.env.RECO_REBUILD_MINUTES) || 60) {
    const run = trigger => buildSimilarities(trigger)
        .then(s => console.log(`🧠 Recommendations rebuilt (${trigger}): ${s.items} items, ${s.users} users, ${s.durationMs} ms`))
        .catch(err => console.error("Recommendation build failed:", err.message));
    lastBuild().then(last => {
        if (!last || Date.now() - new Date(last.startedAt).getTime() > everyMinutes * 60000) run("startup");
    }).catch(() => run("startup"));
    const timer = setInterval(() => run("schedule"), everyMinutes * 60000);
    timer.unref();
    return timer;
}

module.exports = {
    CONFIG, interactionWeights,
    buildSimilarities, lastBuild, scheduleBuilds,
    recommendForUser, recommendItemBased, recommendUserBased, similarItems, popular,
    invalidateUser, clearCache, getCacheStats
};

// Run standalone:  node scripts/recommender.js   (rebuilds the similarity matrix)
if (require.main === module) {
    require("dotenv").config();
    mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 })
        .then(() => buildSimilarities("script"))
        .then(stats => { console.log("Build finished:", stats); return mongoose.disconnect(); })
        .catch(err => { console.error("Build failed:", err); process.exit(1); });
}
