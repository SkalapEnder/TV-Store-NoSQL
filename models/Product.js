const mongoose = require("mongoose");

// Brand and category are embedded as {id, name} snapshots (extended reference pattern):
// the catalog list and the product page render without $lookup. Admin brand/category
// updates propagate the new name with Product.updateMany.
const productSchema = new mongoose.Schema({
    product_id:  { type: Number, required: true, unique: true },
    name:        { type: String, required: true, trim: true },
    model:       { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    price:       { type: Number, required: true, min: 0 },
    currency:    { type: String, default: "KZT" },
    quantity:    { type: Number, required: true, min: 0 },
    available:   { type: Boolean, default: true },
    url:         { type: String, required: true },
    diagonal:    { type: Number, min: 0 },
    brand: {
        id:   { type: Number, required: true },
        name: { type: String, required: true }
    },
    category: {
        id:   { type: Number, required: true },
        name: { type: String, required: true }
    },
    pictures: [{ type: String }],
    // Pre-aggregated rating, so the catalog shows it without scanning user histories
    rating_sum:   { type: Number, default: 0 },
    rating_count: { type: Number, default: 0 }
});

productSchema.virtual("rating_avg").get(function () {
    return this.rating_count ? this.rating_sum / this.rating_count : null;
});

// ---------- Indexes (each one backs a concrete query, see docs/DATA_MODEL.md) ----------
// Full-text search by name / model / description, name is the most important field
productSchema.index(
    { name: "text", model: "text", description: "text" },
    { weights: { name: 10, model: 5, description: 1 }, name: "product_text_search", default_language: "none" }
);
// Filter by category or brand and sort / range by price (equality first, then range: ESR rule)
productSchema.index({ "category.id": 1, price: 1 });
productSchema.index({ "brand.id": 1, price: 1 });
// Price-only and diagonal range filters
productSchema.index({ price: 1 });
productSchema.index({ diagonal: 1 });

const Product = mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
