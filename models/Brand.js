const mongoose = require("mongoose");

const brandSchema = new mongoose.Schema({
    brand_id: { type: Number, required: true, unique: true },     // products reference brands by this id
    brand_name: { type: String, required: true, unique: true, trim: true },   // the scraper looks brands up by name
    brand_description: { type: String },
    headquarters: { type: String },
    founded_year: { type: Number },
    website: { type: String }
});

const Brand = mongoose.models.Brand || mongoose.model("Brand", brandSchema);

module.exports = Brand;