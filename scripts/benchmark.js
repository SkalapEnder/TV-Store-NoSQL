/**
 * Performance benchmark of the recommendation system as the database grows.
 *
 *   npm run bench
 *   npm run bench -- --scales 1000,5000,20000 --queries 100
 *
 * Uses a SEPARATE database (BENCH_MONGO_URI, default mongodb://127.0.0.1:27017/techstore_bench),
 * which is dropped at the start. The database name must contain "bench".
 *
 * For every scale (number of users) it measures:
 *   - similarity-matrix build time and size
 *   - item-based recommendations: no cache (cold), with cache (warm), without the index on item_similarities
 *   - user-based recommendations computed on the fly: with and without the multikey indexes
 *   - popularity list
 *   - explain(): documents/keys examined by the main queries
 * and once (at --eval-scale) the quality of the recommendations on held-out interactions
 * (HitRate@10, Precision@10, Recall@10) against a popularity baseline.
 *
 * Results: docs/perf/results.json, docs/perf/RESULTS.md, docs/perf/charts.html
 */
require("dotenv").config();
const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const User = require("../models/User");
const Product = require("../models/Product");
const ItemSimilarity = require("../models/ItemSimilarity");
const RecoBuild = require("../models/RecoBuild");
const reco = require("./recommender");
const { makeUserGenerator, rng } = require("./lib/synthetic");

const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const URI = process.env.BENCH_MONGO_URI || "mongodb://127.0.0.1:27017/techstore_bench";
const SCALES = arg("scales", "1000,5000,20000,50000").split(",").map(Number);
const PRODUCTS = parseInt(arg("products", "5000"));   // about the size of the real catalog
const QUERIES = parseInt(arg("queries", "100"));
const SLOW_QUERIES = parseInt(arg("slow-queries", "30"));
const EVAL_SCALE = parseInt(arg("eval-scale", "5000"));
const EVAL_USERS = parseInt(arg("eval-users", "300"));
const OUT = path.resolve(__dirname, "..", arg("out", "docs/perf"));

const ms = start => Number(process.hrtime.bigint() - start) / 1e6;
function summary(samples) {
    const s = [...samples].sort((a, b) => a - b);
    const pct = p => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))];
    const round = v => Math.round(v * 1000) / 1000;
    return { n: s.length, avg: round(s.reduce((a, b) => a + b, 0) / s.length), p50: round(pct(50)), p95: round(pct(95)), p99: round(pct(99)), max: round(s[s.length - 1]) };
}
async function timeEach(ids, fn) {
    const samples = [];
    for (const id of ids) { const t = process.hrtime.bigint(); await fn(id); samples.push(ms(t)); }
    return summary(samples);
}
async function collSize(name) {
    try {
        const [s] = await mongoose.connection.db.collection(name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
        return { count: s.storageStats.count, dataMB: +(s.storageStats.size / 1048576).toFixed(2), indexMB: +(s.storageStats.totalIndexSize / 1048576).toFixed(2) };
    } catch { return null; }
}
function explainSummary(plan) {
    const st = plan.executionStats || {};
    const stages = JSON.stringify(plan.queryPlanner?.winningPlan || {}).match(/"stage":"[A-Z_]+"/g) || [];
    return {
        stages: [...new Set(stages.map(s => s.slice(9, -1)))].join(" > "),
        docsExamined: st.totalDocsExamined, keysExamined: st.totalKeysExamined,
        returned: st.nReturned, timeMs: st.executionTimeMillis
    };
}

// ---------- Synthetic catalog ----------
// Category mix, brands and price range (₸) shaped like the real shop.kz import
const SYNTHETIC_CATEGORIES = {
    headphones:  [18, ["A4Tech", "Edifier", "Razer", "Defender", "Xiaomi", "HyperX", "Logitech", "Sony"], 4000, 250000],
    mouse:       [15, ["Defender", "A4Tech", "Logitech", "Genius", "Glorious", "Rapoo", "HP", "Razer"], 2500, 90000],
    monitor:     [13, ["ASUS", "Acer", "AOC", "Lenovo", "Dell", "Philips", "Samsung", "MSI"], 45000, 900000],
    phone:       [11, ["Tecno Mobile", "Xiaomi", "HONOR", "vivo", "Huawei", "Samsung", "Infinix", "POCO"], 40000, 900000],
    keyboard:    [10, ["A4Tech", "Defender", "Varmilo", "Logitech", "Razer", "HP", "Rapoo", "Glorious"], 3000, 120000],
    psu:         [9,  ["Chieftec", "GameMax", "Thermaltake", "DeepCool", "Lian Li", "1Stplayer", "PCCooler", "Aerocool"], 15000, 180000],
    motherboard: [9,  ["Gigabyte", "ASUS", "MSI", "ASRock"], 35000, 450000],
    storage:     [4,  ["Kingston", "Seagate", "Western Digital", "Gigabyte", "Team Group", "Corsair", "Samsung"], 12000, 300000],
    gpu:         [3,  ["Gigabyte", "ASUS", "MSI", "Palit", "Afox", "Sapphire"], 30000, 1200000],
    printer:     [2,  ["HP", "Canon", "Epson", "Xerox"], 40000, 400000],
    tv:          [2,  ["Samsung", "Xiaomi", "Sony", "LG", "Dreame"], 90000, 2500000],
    cpu:         [2,  ["Intel", "AMD"], 25000, 400000],
    ram:         [2,  ["Kingston", "Apacer", "GeIL", "Team Group", "Corsair"], 8000, 150000]
};
const SOCKETS = ["AM4", "AM5", "LGA1700", "LGA1851"];

function makeCatalog(n) {
    const rand = rng(11);
    const entries = Object.entries(SYNTHETIC_CATEGORIES);
    const weights = entries.map(([, [w]]) => w);
    const totalW = weights.reduce((a, b) => a + b, 0);
    return Array.from({ length: n }, (_, i) => {
        let r = rand() * totalW, k = 0;
        while ((r -= weights[k]) > 0) k++;
        const [category, [, brands, minPrice, maxPrice]] = entries[k];
        const brand = brands[Math.floor(rand() * brands.length)];
        // log-uniform price: many cheap items, few expensive ones
        const price = Math.round(minPrice * Math.pow(maxPrice / minPrice, rand()) / 100) * 100;
        const specs = (category === "cpu" || category === "motherboard") ? { socket: SOCKETS[Math.floor(rand() * SOCKETS.length)] } : {};
        return {
            product_id: 100000 + i, name: `${brand} ${category} ${100000 + i}`, model: `${brand.slice(0, 2).toUpperCase()}-${i}`,
            price, quantity: 1000, url: "https://example.com/p/" + i, description: `Synthetic ${category}`,
            brand, category, specs, pictures: []
        };
    });
}

async function sampleUserIds(n, minItems = 1) {
    const docs = await User.aggregate([
        { $match: { [`view_history.${minItems - 1}`]: { $exists: true } } },
        { $sample: { size: n } },
        { $project: { _id: 1 } }
    ]);
    return docs.map(d => d._id.toString());
}

// ---------- Quality: hold out each test user's 3 most recent positive items ----------
async function evaluateQuality(k = 10, holdOut = 3) {
    const ids = await sampleUserIds(EVAL_USERS, 12);
    const saved = [];
    const truth = new Map();
    for (const id of ids) {
        const user = await User.findById(id, { view_history: 1, purchase_history: 1 }).lean();
        const positives = reco.interactionWeights(user).filter(e => e.w >= 2).map(e => e.pid);   // most recent first
        const hidden = new Set(positives.slice(0, holdOut));
        if (hidden.size < holdOut) continue;
        saved.push({ id, view_history: user.view_history, purchase_history: user.purchase_history });
        truth.set(id, hidden);
        await User.updateOne({ _id: id }, { $set: {
            view_history: user.view_history.filter(v => !hidden.has(v.product_id)),
            purchase_history: (user.purchase_history || []).filter(p => !hidden.has(p.product_id))
        } });
    }
    await reco.buildSimilarities("benchmark");

    const metrics = {};
    const algos = {
        "Item-based CF": id => reco.recommendItemBased(id, { limit: k }).then(r => r.items),
        "User-based CF": id => reco.recommendUserBased(id, { limit: k, useCache: false }).then(r => r.items),
        "Popularity": async id => {
            const u = await User.findById(id, { "view_history.product_id": 1 }).lean();
            return reco.popular({ limit: k, excludeIds: new Set(u.view_history.map(v => v.product_id)) });
        }
    };
    for (const [name, fn] of Object.entries(algos)) {
        reco.clearCache();
        let hitUsers = 0, precision = 0, recall = 0, coverage = new Set();
        for (const [id, hidden] of truth) {
            const items = await fn(id);
            items.forEach(i => coverage.add(i.product_id));
            const hits = items.filter(i => hidden.has(i.product_id)).length;
            if (hits) hitUsers++;
            precision += hits / k;
            recall += hits / hidden.size;
        }
        const n = truth.size;
        metrics[name] = {
            users: n,
            hitRate: +(hitUsers / n).toFixed(3),
            precision: +(precision / n).toFixed(4),
            recall: +(recall / n).toFixed(4),
            catalogCoverage: +(coverage.size / PRODUCTS).toFixed(3)
        };
    }

    for (const s of saved) {
        await User.updateOne({ _id: s.id }, { $set: { view_history: s.view_history, purchase_history: s.purchase_history } });
    }
    await reco.buildSimilarities("benchmark");
    return { k, holdOut, metrics };
}

// ---------- Catalog growth: similarity lookup with and without the index ----------
// The lookup cost depends on the number of products (documents in item_similarities), not on
// the number of users, so it is measured separately on a growing synthetic matrix.
async function catalogScaling(sizes, queries = 100, idsPerQuery = 40) {
    const coll = mongoose.connection.db.collection("item_sim_scaling");
    const rand = rng(99);
    const out = [];
    let count = 0;
    await coll.drop().catch(() => {});
    for (const size of sizes) {
        while (count < size) {
            const n = Math.min(5000, size - count);
            await coll.insertMany(Array.from({ length: n }, (_, i) => ({
                product_id: count + i,
                neighbors: Array.from({ length: reco.CONFIG.neighborsPerItem }, () => ({ product_id: Math.floor(rand() * size), score: rand(), co: 2 })),
                popularity: rand() * 100
            })), { ordered: false });
            count += n;
        }
        const queriesIds = Array.from({ length: queries }, () => Array.from({ length: idsPerQuery }, () => Math.floor(rand() * size)));
        const run = () => timeEach(queriesIds, ids => coll.find({ product_id: { $in: ids } }, { projection: { neighbors: 1 } }).toArray());
        const plan = async () => explainSummary(await coll.find({ product_id: { $in: queriesIds[0] } }, { projection: { neighbors: 1 } }).explain("executionStats"));

        await coll.createIndex({ product_id: 1 }, { unique: true });
        const indexed = await run(), indexedPlan = await plan();
        await coll.dropIndex("product_id_1");
        const noIndex = await run(), noIndexPlan = await plan();
        out.push({ products: size, indexed, noIndex, indexedPlan, noIndexPlan });
        console.log(`catalog ${size}: indexed p50 ${indexed.p50} ms, no index p50 ${noIndex.p50} ms`);
    }
    await coll.drop().catch(() => {});
    return out;
}

// ---------- Main ----------
async function main() {
    const dbName = new URL(URI.replace("mongodb+srv://", "http://").replace("mongodb://", "http://")).pathname.slice(1);
    if (!/bench/i.test(dbName) && !args.includes("--force")) {
        throw new Error(`Refusing to drop database "${dbName}": its name must contain "bench" (or pass --force)`);
    }
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 8000 });
    console.log(`Benchmark database: ${dbName}`);
    await mongoose.connection.db.dropDatabase();
    for (const M of [User, Product, ItemSimilarity, RecoBuild]) await M.init();

    const products = makeCatalog(PRODUCTS);
    await Product.insertMany(products, { ordered: false });
    const generate = makeUserGenerator(products, { seed: 7, minItems: 5, maxItems: 45 });
    const PASSWORD = "$2a$10$abcdefghijklmnopqrstuuJp1y3o7zUeD9q1oG7q8sQ5mJxWkS1W6";   // dummy bcrypt-shaped hash

    const build = await mongoose.connection.db.admin().serverInfo();
    const results = {
        startedAt: new Date(),
        environment: {
            mongodb: build.version, node: process.version, cpu: os.cpus()[0]?.model, cores: os.cpus().length,
            ramGB: Math.round(os.totalmem() / 1073741824), platform: `${os.platform()} ${os.release()}`
        },
        settings: { products: PRODUCTS, queries: QUERIES, slowQueries: SLOW_QUERIES, config: reco.CONFIG },
        scales: [],
        quality: null
    };

    let inserted = 0;
    for (const scale of SCALES) {
        console.log(`\n=== ${scale} users ===`);
        let t = process.hrtime.bigint();
        while (inserted < scale) {
            const n = Math.min(2000, scale - inserted);
            const docs = Array.from({ length: n }, (_, i) => ({
                username: `user${inserted + i}`, email: `user${inserted + i}@bench.local`, password: PASSWORD, role: "user",
                ...generate(), createdAt: new Date(), updatedAt: new Date()
            }));
            await User.collection.insertMany(docs, { ordered: false });
            inserted += n;
        }
        const seedMs = ms(t);
        const [agg] = await User.aggregate([{ $group: { _id: null, v: { $avg: { $size: "$view_history" } }, p: { $sum: { $size: "$purchase_history" } } } }]);

        // Build the similarity matrix
        const buildStats = await reco.buildSimilarities("benchmark");
        console.log(`build: ${buildStats.durationMs} ms, ${buildStats.pairs} pairs`);

        const ids = await sampleUserIds(QUERIES);
        const slowIds = ids.slice(0, SLOW_QUERIES);
        const r = {
            users: scale, seedMs: Math.round(seedMs),
            avgItemsPerUser: +agg.v.toFixed(1), purchases: agg.p,
            build: { durationMs: buildStats.durationMs, pairs: buildStats.pairs, items: buildStats.items, neighbors: buildStats.neighbors },
            sizes: { users: await collSize("users"), item_similarities: await collSize("item_similarities") },
            latency: {}, explain: {}
        };

        // Item-based, cold cache (every request computed)
        r.latency.itemCold = await timeEach(ids, id => { reco.clearCache(); return reco.recommendItemBased(id, { limit: 12 }); });
        // Item-based, warm cache (same users again)
        await Promise.all(ids.map(id => reco.recommendItemBased(id, { limit: 12 })));
        r.latency.itemWarm = await timeEach(ids, id => reco.recommendItemBased(id, { limit: 12 }));
        // Popular list, cold
        r.latency.popularCold = await timeEach(ids.slice(0, 30), () => { reco.clearCache(); return reco.popular({ limit: 12 }); });
        // User-based on the fly, with the multikey indexes
        r.latency.userIndexed = await timeEach(slowIds.concat(ids.slice(SLOW_QUERIES, SLOW_QUERIES * 2)), id => reco.recommendUserBased(id, { limit: 12, useCache: false }));

        // explain() of the main queries
        const probe = await User.findById(ids[0], { "view_history.product_id": 1 }).lean();
        const probeItems = probe.view_history.map(v => v.product_id);
        const candidateQuery = () => User.find({
            _id: { $ne: probe._id },
            $or: [{ "view_history.product_id": { $in: probeItems } }, { "purchase_history.product_id": { $in: probeItems } }]
        }, { _id: 1 }).limit(reco.CONFIG.userBasedCandidates);
        r.explain.userCandidatesIndexed = explainSummary(await candidateQuery().explain("executionStats"));
        r.explain.itemSimilarityLookup = explainSummary(await ItemSimilarity.find({ product_id: { $in: probeItems } }, { neighbors: 1 }).explain("executionStats"));

        // Without the indexes: user-based (multikey on users) and item-based (unique on item_similarities)
        await User.collection.dropIndex("view_history.product_id_1");
        await User.collection.dropIndex("purchase_history.product_id_1");
        r.latency.userNoIndex = await timeEach(slowIds, id => reco.recommendUserBased(id, { limit: 12, useCache: false }));
        r.explain.userCandidatesNoIndex = explainSummary(await candidateQuery().explain("executionStats"));
        await User.collection.createIndex({ "view_history.product_id": 1 });
        await User.collection.createIndex({ "purchase_history.product_id": 1 });

        await ItemSimilarity.collection.dropIndex("product_id_1");
        r.latency.itemColdNoIndex = await timeEach(ids, id => { reco.clearCache(); return reco.recommendItemBased(id, { limit: 12 }); });
        r.explain.itemSimilarityLookupNoIndex = explainSummary(await ItemSimilarity.find({ product_id: { $in: probeItems } }, { neighbors: 1 }).explain("executionStats"));
        await ItemSimilarity.collection.createIndex({ product_id: 1 }, { unique: true });

        const L = r.latency;
        console.log(`item cold p50 ${L.itemCold.p50} ms · warm p50 ${L.itemWarm.p50} ms · user idx p50 ${L.userIndexed.p50} ms · user no-idx p50 ${L.userNoIndex.p50} ms`);
        results.scales.push(r);

        if (scale === EVAL_SCALE) {
            console.log("quality evaluation…");
            results.quality = { users: scale, ...(await evaluateQuality()) };
            console.log(results.quality.metrics);
        }
    }

    console.log("\n=== catalog growth (similarity lookup) ===");
    results.catalog = await catalogScaling(arg("catalog-scales", "600,5000,20000,50000").split(",").map(Number));

    results.finishedAt = new Date();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(OUT, "RESULTS.md"), toMarkdown(results));
    fs.writeFileSync(path.join(OUT, "charts.html"), toChartsHtml(results));
    console.log(`\nResults written to ${path.relative(process.cwd(), OUT)}/ (results.json, RESULTS.md, charts.html)`);
}

// ---------- Report output ----------
function toMarkdown(R) {
    const e = R.environment;
    const rows = R.scales;
    const fmt = n => (n == null ? "—" : Number(n).toLocaleString("en-US"));
    let md = `# Benchmark results\n\nGenerated by \`npm run bench\` on ${new Date(R.finishedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.\n\n`;
    md += `Environment: MongoDB ${e.mongodb} (local), Node ${e.node}, ${e.cpu} (${e.cores} threads), ${e.ramGB} GB RAM, ${e.platform}.\n`;
    md += `Catalog: ${R.settings.products} synthetic products. ${R.settings.queries} sampled users per measurement (${R.settings.slowQueries} for the unindexed user-based run).\n\n`;

    md += `## Data volume and offline build\n\n| Users | Avg items / user | Purchases | users collection, MB (data / index) | Item pairs | Build time, ms | item_similarities, MB |\n|---:|---:|---:|---:|---:|---:|---:|\n`;
    rows.forEach(r => {
        md += `| ${fmt(r.users)} | ${r.avgItemsPerUser} | ${fmt(r.purchases)} | ${r.sizes.users ? `${r.sizes.users.dataMB} / ${r.sizes.users.indexMB}` : "—"} | ${fmt(r.build.pairs)} | ${fmt(r.build.durationMs)} | ${r.sizes.item_similarities ? r.sizes.item_similarities.dataMB : "—"} |\n`;
    });

    md += `\n## Online latency per recommendation request, ms (p50 / p95)\n\n| Users | Item-based, cache | Item-based, no cache | Item-based, no index | User-based, indexed | User-based, no index | Popular, no cache |\n|---:|---:|---:|---:|---:|---:|---:|\n`;
    const c = s => `${s.p50} / ${s.p95}`;
    rows.forEach(r => {
        const L = r.latency;
        md += `| ${fmt(r.users)} | ${c(L.itemWarm)} | ${c(L.itemCold)} | ${c(L.itemColdNoIndex)} | ${c(L.userIndexed)} | ${c(L.userNoIndex)} | ${c(L.popularCold)} |\n`;
    });

    md += `\n## Query plans (explain, one sampled user)\n\n| Users | Query | Plan | Keys examined | Docs examined | Returned |\n|---:|---|---|---:|---:|---:|\n`;
    rows.forEach(r => {
        const X = r.explain;
        [["User-based candidates, indexed", X.userCandidatesIndexed], ["User-based candidates, no index", X.userCandidatesNoIndex],
         ["Item similarity lookup, indexed", X.itemSimilarityLookup], ["Item similarity lookup, no index", X.itemSimilarityLookupNoIndex]]
            .forEach(([name, x]) => { md += `| ${fmt(r.users)} | ${name} | ${x.stages} | ${fmt(x.keysExamined)} | ${fmt(x.docsExamined)} | ${fmt(x.returned)} |\n`; });
    });

    if (R.catalog && R.catalog.length) {
        md += `\n## Catalog growth: similarity lookup of ${40} products, ms (p50 / p95)\n\n| Products in item_similarities | With index | Without index | Docs examined, with index | Docs examined, without index |\n|---:|---:|---:|---:|---:|\n`;
        R.catalog.forEach(c => {
            md += `| ${fmt(c.products)} | ${c.indexed.p50} / ${c.indexed.p95} | ${c.noIndex.p50} / ${c.noIndex.p95} | ${fmt(c.indexedPlan.docsExamined)} | ${fmt(c.noIndexPlan.docsExamined)} |\n`;
        });
    }

    if (R.quality) {
        md += `\n## Recommendation quality (${fmt(R.quality.users)} users, ${R.quality.holdOut} most recent positive items held out, top-${R.quality.k})\n\n| Algorithm | Test users | HitRate@${R.quality.k} | Precision@${R.quality.k} | Recall@${R.quality.k} | Catalog coverage |\n|---|---:|---:|---:|---:|---:|\n`;
        Object.entries(R.quality.metrics).forEach(([name, m]) => {
            md += `| ${name} | ${m.users} | ${m.hitRate} | ${m.precision} | ${m.recall} | ${(m.catalogCoverage * 100).toFixed(1)}% |\n`;
        });
    }
    return md;
}

function toChartsHtml(R) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recommendation benchmark</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
 body{font-family:Inter,system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#1b2420}
 h1{font-size:22px;margin:0 0 4px} p{color:#6a7871;margin:0 0 20px;font-size:14px}
 .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:20px}
 .card{border:1px solid #e2e8e4;border-radius:14px;padding:16px} h2{font-size:15px;margin:0 0 10px}
</style></head><body>
<h1>Recommendation system: performance as the database grows</h1>
<p>MongoDB ${R.environment.mongodb} · ${R.settings.products} products · ${R.environment.cpu}</p>
<div class="grid">
 <div class="card"><h2>Latency p95 per request, ms (log scale)</h2><canvas id="lat"></canvas></div>
 <div class="card"><h2>Latency p50 per request, ms (log scale)</h2><canvas id="lat50"></canvas></div>
 <div class="card"><h2>Similarity matrix build time, s</h2><canvas id="build"></canvas></div>
 <div class="card"><h2>Documents examined by the candidate query</h2><canvas id="docs"></canvas></div>
 ${R.catalog ? '<div class="card"><h2>Similarity lookup vs catalog size, p50 ms</h2><canvas id="catalog"></canvas></div>' : ""}
 ${R.quality ? '<div class="card"><h2>Quality on held-out interactions (top-10)</h2><canvas id="quality"></canvas></div>' : ""}
</div>
<script>
const R = ${JSON.stringify(R)};
const users = R.scales.map(s => s.users.toLocaleString("en-US"));
const colors = ["#2f4a3f","#7fa795","#b8964f","#b4443c","#6a7871","#3a7ca5"];
const series = [["Item-based, cache","itemWarm"],["Item-based, no cache","itemCold"],["Item-based, no index","itemColdNoIndex"],["User-based, indexed","userIndexed"],["User-based, no index","userNoIndex"]];
const line = (id, key) => new Chart(document.getElementById(id), { type: "line",
  data: { labels: users, datasets: series.map(([label, k], i) => ({ label, data: R.scales.map(s => Math.max(s.latency[k][key], 0.001)), borderColor: colors[i], backgroundColor: colors[i], tension: .25 })) },
  options: { scales: { y: { type: "logarithmic", min: 0.001, max: 1000, title: { display: true, text: "ms" },
    ticks: { autoSkip: false, callback: v => [0.001, 0.01, 0.1, 1, 10, 100, 1000].includes(v) ? v : "" } },
    x: { title: { display: true, text: "users" } } } } });
line("lat", "p95"); line("lat50", "p50");
new Chart(document.getElementById("build"), { type: "bar", data: { labels: users, datasets: [{ label: "build, s", data: R.scales.map(s => s.build.durationMs / 1000), backgroundColor: "#2f4a3f" }] } });
new Chart(document.getElementById("docs"), { type: "bar", data: { labels: users, datasets: [
  { label: "with multikey index", data: R.scales.map(s => s.explain.userCandidatesIndexed.docsExamined), backgroundColor: "#2f4a3f" },
  { label: "without index (COLLSCAN)", data: R.scales.map(s => s.explain.userCandidatesNoIndex.docsExamined), backgroundColor: "#b4443c" }] } });
if (R.catalog) new Chart(document.getElementById("catalog"), { type: "line", data: { labels: R.catalog.map(c => c.products.toLocaleString("en-US")), datasets: [
  { label: "with index (IXSCAN)", data: R.catalog.map(c => c.indexed.p50), borderColor: "#2f4a3f", backgroundColor: "#2f4a3f" },
  { label: "without index (COLLSCAN)", data: R.catalog.map(c => c.noIndex.p50), borderColor: "#b4443c", backgroundColor: "#b4443c" }] },
  options: { scales: { x: { title: { display: true, text: "products" } }, y: { title: { display: true, text: "ms" } } } } });
if (R.quality) { const m = R.quality.metrics, names = Object.keys(m);
  new Chart(document.getElementById("quality"), { type: "bar", data: { labels: ["HitRate","Precision","Recall"], datasets: names.map((n, i) => ({ label: n, data: [m[n].hitRate, m[n].precision, m[n].recall], backgroundColor: colors[i] })) } }); }
</script></body></html>`;
}

main()
    .then(() => mongoose.disconnect())
    .catch(async err => { console.error("Benchmark failed:", err); await mongoose.disconnect().catch(() => {}); process.exit(1); });
