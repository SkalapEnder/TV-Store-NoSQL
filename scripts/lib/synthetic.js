/**
 * Synthetic users with realistic interaction patterns, for the demo and the benchmark.
 * Each user has a hidden "taste":
 *   - a persona that decides which categories they shop in (a PC builder looks at GPUs, CPUs,
 *     motherboards, RAM, storage and PSUs; a gamer at GPUs, monitors, keyboards, mice, headsets…),
 *   - one or two favourite brands, a price band (budget / mid / premium inside each category),
 *   - for PC builders, a platform (CPU socket): an AM5 CPU goes with an AM5 motherboard.
 * Products matching the taste are viewed more often, rated higher and bought more often, so
 * collaborative filtering has real (also cross-category) structure to find. Product popularity
 * follows a Zipf-like curve (a few hits, a long tail). A seeded PRNG makes runs reproducible.
 */

function rng(seed = 42) {            // mulberry32
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Index drawn with probability proportional to its weight (prefix sums + binary search)
function pickIndex(rand, cumulative) {
    const r = rand() * cumulative[cumulative.length - 1];
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < r) lo = mid + 1; else hi = mid;
    }
    return lo;
}

/** Price band of each product inside its category: 0 budget, 1 mid, 2 premium (price terciles) */
function priceBands(products) {
    const byCat = new Map();
    products.forEach(p => { const l = byCat.get(p.category) || []; l.push(p.price); byCat.set(p.category, l); });
    const cuts = new Map([...byCat].map(([c, prices]) => {
        prices.sort((a, b) => a - b);
        return [c, [prices[Math.floor(prices.length / 3)] || 0, prices[Math.floor(2 * prices.length / 3)] || 0]];
    }));
    return new Map(products.map(p => {
        const [t1, t2] = cuts.get(p.category);
        return [p.product_id, p.price <= t1 ? 0 : p.price <= t2 ? 1 : 2];
    }));
}

// Which categories each kind of shopper looks at (weights = how often a persona occurs)
const PERSONAS = [
    { name: "pc-builder", weight: 3, categories: ["gpu", "cpu", "motherboard", "ram", "storage", "psu"] },
    { name: "gamer",      weight: 3, categories: ["gpu", "monitor", "keyboard", "mouse", "headphones"] },
    { name: "office",     weight: 2, categories: ["printer", "monitor", "keyboard", "mouse"] },
    { name: "mobile",     weight: 2, categories: ["phone", "headphones"] },
    { name: "home",       weight: 2, categories: ["tv", "phone", "headphones"] }
];

/**
 * products: [{ product_id, name, price, pictures?, brand, category, specs? }]
 * returns a generator function () -> { view_history, purchase_history }
 */
function makeUserGenerator(products, { seed = 42, minItems = 6, maxItems = 40, days = 120, withPictures = false } = {}) {
    const rand = rng(seed);
    const bands = priceBands(products);
    const present = new Set(products.map(p => p.category));
    const personas = PERSONAS.map(p => ({ ...p, categories: new Set(p.categories.filter(c => present.has(c))) }))
        .filter(p => p.categories.size);
    const personaWeights = personas.map(p => p.weight);
    const sockets = [...new Set(products.filter(p => p.category === "cpu" && p.specs?.socket).map(p => p.specs.socket))];
    const pickWeighted = weights => { let r = rand() * weights.reduce((a, b) => a + b, 0); return weights.findIndex(w => (r -= w) < 0); };
    // Zipf-like base popularity (shuffled, so it does not follow product_id order)
    const order = products.map((_, i) => i).sort(() => rand() - 0.5);
    const basePop = new Float64Array(products.length);
    order.forEach((pi, rank) => { basePop[pi] = 1 / Math.pow(rank + 1, 0.8); });

    return function generate() {
        const persona = personas.length ? personas[Math.max(0, pickWeighted(personaWeights))] : { categories: new Set() };
        // Favourite brands: drawn from products of the persona's categories, so popular brands are picked more
        const own = products.filter(p => persona.categories.has(p.category));
        const pool = own.length ? own : products;
        const favBrands = new Set([pool[Math.floor(rand() * pool.length)].brand, rand() < 0.5 ? pool[Math.floor(rand() * pool.length)].brand : null]);
        const band = Math.floor(rand() * 3);
        const socket = sockets.length ? sockets[Math.floor(rand() * sockets.length)] : null;

        const affinity = products.map(p => 1
            + (persona.categories.has(p.category) ? 3 : 0)
            + (favBrands.has(p.brand) ? 1.5 : 0)
            + (bands.get(p.product_id) === band ? 1 : 0)
            + (socket && p.specs?.socket === socket ? 1.5 : 0));
        const cumulative = new Float64Array(products.length);
        let acc = 0;
        affinity.forEach((a, i) => { acc += a * a * basePop[i]; cumulative[i] = acc; });

        const n = Math.min(products.length, minItems + Math.floor(Math.pow(rand(), 1.6) * (maxItems - minItems)));
        const chosen = new Map();
        for (let guard = 0; chosen.size < n && guard < n * 10; guard++) {
            const i = pickIndex(rand, cumulative);
            if (!chosen.has(i)) chosen.set(i, affinity[i]);
        }

        const now = Date.now();
        const view_history = [];
        const purchase_history = [];
        for (const [i, aff] of chosen) {
            const p = products[i];
            const lastViewed = new Date(now - rand() * days * 86400000);
            const views = 1 + Math.floor(-Math.log(1 - rand()) * (aff / 2));   // more views when it matches the taste
            const entry = { product_id: p.product_id, name: p.name, price: p.price, views, lastViewed };
            if (withPictures && p.pictures?.length) entry.pictures = [p.pictures[0]];
            if (rand() < 0.3) {
                entry.rating = Math.max(1, Math.min(5, Math.round(1.2 + aff * 0.65 + (rand() - 0.5) * 1.6)));
                entry.ratedAt = lastViewed;
            }
            view_history.push(entry);
            if (rand() < 0.03 + aff * 0.025) {
                purchase_history.push({
                    order_id: `syn-${Math.floor(rand() * 1e12).toString(36)}`,
                    product_id: p.product_id, name: p.name, price: p.price, quantity: 1,
                    picture: withPictures ? (p.pictures || [])[0] : undefined,
                    purchasedAt: new Date(lastViewed.getTime() + rand() * 86400000)
                });
            }
        }
        return { view_history, purchase_history };
    };
}

module.exports = { rng, makeUserGenerator, PERSONAS };
