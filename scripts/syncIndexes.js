// Brings the indexes in MongoDB in line with the ones declared in the models:
// creates missing indexes, rebuilds changed ones (e.g. brand_id became unique), drops unused ones.
// Run once after changing a schema:  npm run sync-indexes
require("dotenv").config();
const mongoose = require("mongoose");

const models = [
    require("../models/User"),
    require("../models/Product"),
    require("../models/Brand"),
    require("../models/Category"),
    require("../models/Cart"),
    require("../models/ItemSimilarity"),
    require("../models/RecoBuild")
];

async function main() {
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 8000 });
    for (const Model of models) {
        try {
            const dropped = await Model.syncIndexes();
            const indexes = await Model.listIndexes();
            console.log(`${Model.collection.name}: ${indexes.map(i => i.name).join(", ")}` +
                (dropped.length ? `  (dropped: ${dropped.join(", ")})` : ""));
        } catch (err) {
            // Typical cause: duplicates in the data that block a unique index
            console.error(`${Model.collection.name}: index sync failed: ${err.message}`);
            process.exitCode = 1;
        }
    }
    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
