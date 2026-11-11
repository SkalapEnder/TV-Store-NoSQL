const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
    category_id: { type: Number, required: true, unique: true },   // products reference categories by this id
    category_name: { type: String, required: true, unique: true, trim: true },
    category_description: { type: String }
});

const Category = mongoose.models.Category || mongoose.model("Category", categorySchema);

module.exports = Category;