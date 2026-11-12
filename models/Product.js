const mongoose = require("mongoose");
const { CATEGORIES, getCategory, cleanSpecs } = require("../config/categories");

// One collection for every kind of product (polymorphic pattern). Common fields are typed;
// the category-specific characteristics live in `specs`, whose shape depends on `category`
// (defined in config/categories.js): a GPU has { chip, memory_gb }, a PSU { wattage, form_factor }.
// Brand and category are plain values on the product: no lookups, and the brand list of a
// category is a DISTINCT_SCAN of the { category, brand } index.
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
    brand:       { type: String, required: true, trim: true },
    category:    { type: String, required: true, enum: CATEGORIES.map(c => c.slug) },
    group:       { type: String, required: true },     // copied from the category config (filter by group)
    specs:       { type: mongoose.Schema.Types.Mixed, default: {} },
    pictures:    [{ type: String }],
    // Pre-aggregated rating, so the catalog shows it without scanning user histories
    rating_sum:   { type: Number, default: 0 },
    rating_count: { type: Number, default: 0 }
}, { minimize: false });

// Keep `group` and the types inside `specs` consistent with the category definition
productSchema.pre("validate", function () {
    const cat = getCategory(this.category);
    if (!cat) return;
    this.group = cat.group;
    if (this.isModified("specs") || this.isModified("category") || this.isNew) {
        this.specs = cleanSpecs(this.category, this.specs);
    }
});

productSchema.virtual("rating_avg").get(function () {
    return this.rating_count ? this.rating_sum / this.rating_count : null;
});

// ---------- Indexes (each one backs a concrete query, see docs/DATA_MODEL.md) ----------
// Full-text search by name / model / brand / description, name is the most important field
productSchema.index(
    { name: "text", model: "text", brand: "text", description: "text" },
    { weights: { name: 10, model: 5, brand: 5, description: 1 }, name: "product_text_search", default_language: "none" }
);
// Category page: filter by category, sort / range by price (equality first, then range: ESR rule)
productSchema.index({ category: 1, price: 1 });
// Brand list of a category (DISTINCT_SCAN) and "category + brand" filter
productSchema.index({ category: 1, brand: 1, price: 1 });
// Group pages ("PC components") and brand pages across categories
productSchema.index({ group: 1, price: 1 });
productSchema.index({ brand: 1, price: 1 });
productSchema.index({ price: 1 });

const Product = mongoose.models.Product || mongoose.model("Product", productSchema);

module.exports = Product;
