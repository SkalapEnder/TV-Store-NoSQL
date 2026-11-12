/**
 * Catalog queries shared by the product pages, the categories page and the home page:
 * search with filters, facets (brands / spec values available in a category, with counts)
 * and category statistics.
 */
const Product = require("../models/Product");
const { CATEGORIES, GROUPS, getCategory, getGroup } = require("../config/categories");

// Fields needed by a catalog card (no description / extra pictures: smaller payload)
const CARD_FIELDS = "product_id name model price quantity brand category group specs pictures rating_sum rating_count";
const PAGE_SIZE = 48;

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toNumber = v => (v === undefined || v === null || v === "" ? null : Number(v));
const asList = v => (v === undefined || v === null || v === "" ? [] : (Array.isArray(v) ? v : [v]))
    .map(x => String(x).trim()).filter(Boolean).slice(0, 50);
const withAvg = p => ({ ...p, rating_avg: p.rating_count ? p.rating_sum / p.rating_count : null });

function range(min, max) {
    const r = {};
    if (Number.isFinite(min)) r.$gte = min;
    if (Number.isFinite(max)) r.$lte = max;
    return Object.keys(r).length ? r : null;
}

/**
 * Builds a MongoDB filter from query parameters. Every field is optional:
 *   category          category slug (gpu, phone, tv…)      group     group slug (pc-parts…)
 *   brand             brand name, may repeat (brand=ASUS&brand=MSI)
 *   min, max          price range                          in_stock  "true" -> quantity > 0
 *   spec_<key>        value of a "select" spec, may repeat (spec_socket=AM5&spec_socket=AM4)
 *   spec_<key>_min/_max   range of a "range" spec         spec_<key>=true for a "bool" spec
 * Spec parameters are read only for the keys the category declares (no arbitrary field names).
 */
function buildFilter(params = {}) {
    const filter = {};
    const cat = getCategory(params.category);
    if (cat) filter.category = cat.slug;
    else if (getGroup(params.group)) filter.group = params.group;

    const brands = asList(params.brand);
    if (brands.length === 1) filter.brand = brands[0];
    else if (brands.length > 1) filter.brand = { $in: brands };

    const price = range(toNumber(params.min), toNumber(params.max));
    if (price) filter.price = price;
    if (String(params.in_stock) === "true") filter.quantity = { $gt: 0 };

    if (cat) {
        for (const s of cat.specs) {
            const field = `specs.${s.key}`;
            if (s.filter === "select") {
                let values = asList(params[`spec_${s.key}`]);
                if (s.type === "number") values = values.map(Number).filter(Number.isFinite);
                if (values.length) filter[field] = values.length === 1 ? values[0] : { $in: values };
            } else if (s.filter === "range") {
                const r = range(toNumber(params[`spec_${s.key}_min`]), toNumber(params[`spec_${s.key}_max`]));
                if (r) filter[field] = r;
            } else if (s.filter === "bool" && String(params[`spec_${s.key}`]) === "true") {
                filter[field] = true;
            }
        }
    }
    return filter;
}

const SORTS = {
    price_asc:  { price: 1, product_id: 1 },
    price_desc: { price: -1, product_id: 1 },
    rating:     { rating_count: -1, product_id: 1 },
    name:       { name: 1, product_id: 1 }
};

/** Returns { products, total, page, pages } */
async function searchProducts(params = {}) {
    const filter = buildFilter(params);
    const q = String(params.q ?? params.name ?? "").trim().slice(0, 100);
    const sort = SORTS[params.sort];
    const limit = Math.min(Math.max(parseInt(params.limit) || PAGE_SIZE, 1), 200);
    const page = Math.max(parseInt(params.page) || 1, 1);
    const skip = (page - 1) * limit;

    const run = async (query, defaultSort, projection = {}) => {
        const [products, total] = await Promise.all([
            Product.find(query, projection).select(CARD_FIELDS).sort(sort || defaultSort).skip(skip).limit(limit).lean(),
            Product.countDocuments(query)
        ]);
        return { products: products.map(withAvg), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
    };

    if (q) {
        // 1) Text index: fast, ranked by relevance (whole words: "Samsung", "RTX", "5070")
        try {
            const result = await run({ ...filter, $text: { $search: q } }, { score: { $meta: "textScore" } }, { score: { $meta: "textScore" } });
            if (result.total) return result;
        } catch (err) {
            // Text index not built yet (run `npm run sync-indexes`): fall through to the substring search
            console.warn("Text search unavailable:", err.message);
        }
        // 2) Fallback for partial words ("sams", "rtx50"): case-insensitive substring on name / model / brand
        const rx = new RegExp(escapeRegex(q), "i");
        return run({ ...filter, $or: [{ name: rx }, { model: rx }, { brand: rx }] }, { name: 1 });
    }
    return run(filter, { price: 1, product_id: 1 });
}

// ---------- Facets ----------
// The values a shopper can filter by in a category: brands, spec values (with product counts) and
// the min / max of range specs. One $facet aggregation over the category ({category, …} index),
// cached for a few minutes because the catalog changes only on import / admin edits.
const facetCache = new Map();
const FACET_TTL_MS = 5 * 60 * 1000;

async function facets(categorySlug, groupSlug) {
    const cat = getCategory(categorySlug);
    const group = !cat && getGroup(groupSlug) ? groupSlug : null;
    const key = cat ? cat.slug : group ? `g:${group}` : "*";
    const hit = facetCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;

    const count = path => [{ $match: { [path]: { $ne: null } } }, { $group: { _id: `$${path}`, n: { $sum: 1 } } }];
    const stages = {
        brands: [{ $group: { _id: "$brand", n: { $sum: 1 } } }, { $sort: { _id: 1 } }],
        price: [{ $group: { _id: null, min: { $min: "$price" }, max: { $max: "$price" } } }]
    };
    if (cat) {
        for (const s of cat.specs) {
            if (s.filter === "select") stages[`s_${s.key}`] = [...count(`specs.${s.key}`), { $sort: { _id: 1 } }];
            if (s.filter === "range") stages[`s_${s.key}`] = [{ $group: { _id: null, min: { $min: `$specs.${s.key}` }, max: { $max: `$specs.${s.key}` } } }];
            if (s.filter === "bool") stages[`s_${s.key}`] = [{ $match: { [`specs.${s.key}`]: true } }, { $count: "n" }];
        }
    } else {
        stages.categories = [{ $group: { _id: "$category", n: { $sum: 1 } } }];
    }

    const match = cat ? { category: cat.slug } : group ? { group } : {};
    const [r] = await Product.aggregate([{ $match: match }, { $facet: stages }]);
    const value = {
        brands: r.brands.map(b => ({ name: b._id, n: b.n })),
        price: r.price[0] || { min: 0, max: 0 },
        specs: {},
        categories: r.categories ? Object.fromEntries(r.categories.map(c => [c._id, c.n])) : null
    };
    if (cat) {
        for (const s of cat.specs) {
            const v = r[`s_${s.key}`];
            if (!v) continue;
            if (s.filter === "select") value.specs[s.key] = v.map(x => ({ value: x._id, n: x.n }));
            if (s.filter === "range") value.specs[s.key] = v[0] || null;
            if (s.filter === "bool") value.specs[s.key] = v[0]?.n || 0;
        }
    }
    facetCache.set(key, { value, expires: Date.now() + FACET_TTL_MS });
    return value;
}
const clearFacets = () => facetCache.clear();

/** Product count, lowest price and a picture per category (categories page, home page) */
let statsCache = null;
async function categoryStats() {
    if (statsCache && statsCache.expires > Date.now()) return statsCache.value;
    const rows = await Product.aggregate([
        { $sort: { rating_count: -1, price: -1 } },
        { $group: {
            _id: "$category", count: { $sum: 1 },
            inStock: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, 1, 0] } },
            minPrice: { $min: "$price" },
            picture: { $first: { $arrayElemAt: ["$pictures", 0] } }
        } }
    ]);
    const byCat = Object.fromEntries(rows.map(r => [r._id, r]));
    const value = GROUPS.map(g => ({
        ...g,
        categories: CATEGORIES.filter(c => c.group === g.slug).map(c => ({
            ...c,
            count: byCat[c.slug]?.count || 0,
            inStock: byCat[c.slug]?.inStock || 0,
            minPrice: byCat[c.slug]?.minPrice || null,
            picture: byCat[c.slug]?.picture || null
        }))
    }));
    statsCache = { value, expires: Date.now() + FACET_TTL_MS };
    return value;
}

/** Products of the same category closest in price (two index range scans on {category, price}) */
async function relatedProducts(product, limit = 4) {
    const base = { category: product.category, product_id: { $ne: product.product_id }, quantity: { $gt: 0 } };
    const [above, below] = await Promise.all([
        Product.find({ ...base, price: { $gte: product.price } }).select(CARD_FIELDS).sort({ price: 1 }).limit(limit).lean(),
        Product.find({ ...base, price: { $lt: product.price } }).select(CARD_FIELDS).sort({ price: -1 }).limit(limit).lean()
    ]);
    return [...above, ...below]
        .sort((a, b) => Math.abs(a.price - product.price) - Math.abs(b.price - product.price))
        .slice(0, limit)
        .map(withAvg);
}

function invalidateCatalog() {
    facetCache.clear();
    statsCache = null;
}

module.exports = {
    CARD_FIELDS, PAGE_SIZE, withAvg, buildFilter, searchProducts, facets, categoryStats, relatedProducts,
    invalidateCatalog, clearFacets
};
