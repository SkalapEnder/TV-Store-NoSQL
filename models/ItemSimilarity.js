const mongoose = require("mongoose");

// Precomputed item-item similarities (item-based collaborative filtering).
// One document per product: its top-K most similar products, built offline by
// scripts/recommender.js#buildSimilarities from the interactions stored in users.
const itemSimilaritySchema = new mongoose.Schema({
    product_id:   { type: Number, required: true, unique: true },   // lookup by the items a user interacted with
    neighbors: [{
        _id: false,
        product_id: { type: Number, required: true },
        score:      { type: Number, required: true },   // shrunk cosine similarity, 0..1
        co:         { type: Number, required: true }    // number of users who interacted with both items
    }],
    popularity:   { type: Number, default: 0 },          // sum of interaction weights (for cold start / "trending")
    interactions: { type: Number, default: 0 },          // number of users who interacted with the item
    builtAt:      { type: Date, default: Date.now }
}, { collection: "item_similarities", versionKey: false });

itemSimilaritySchema.index({ popularity: -1 });          // "trending" list without a collection scan

module.exports = mongoose.models.ItemSimilarity || mongoose.model("ItemSimilarity", itemSimilaritySchema);
