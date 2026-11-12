// Brings the indexes in MongoDB in line with the ones declared in the models:
// creates missing indexes, rebuilds changed ones, drops unused ones.
// Run once after changing a schema:  npm run sync-indexes
// With --drop-obsolete it also drops the collections of the old TV-store model (`brands`,
// `categories`): brand and category are now fields of the product.
require("dotenv").config();
const mongoose = require("mongoose");

const models = [
    require("../models/User"),
    require("../models/Product"),
    require("../models/Cart"),
    require("../models/ItemSimilarity"),
    require("../models/RecoBuild")
];
const OBSOLETE_COLLECTIONS = ["brands", "categories"];

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

    const existing = (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    const obsolete = OBSOLETE_COLLECTIONS.filter(name => existing.includes(name));
    if (obsolete.length && process.argv.includes("--drop-obsolete")) {
        for (const name of obsolete) await mongoose.connection.db.dropCollection(name);
        console.log(`Dropped obsolete collections: ${obsolete.join(", ")}`);
    } else if (obsolete.length) {
        console.log(`Obsolete collections still present: ${obsolete.join(", ")} (run with --drop-obsolete to remove them)`);
    }
    await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
