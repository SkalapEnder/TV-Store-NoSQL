const express = require('express');
const Brand = require('../../models/Brand');
const Product = require('../../models/Product');
const router = express.Router();

// Route to get all brands and render brands_admin.ejs
router.get("/", async (req, res) => {
    if (req.session.userStatus !== "admin") {
        req.flash("warning", "This page is for administrators only");
        return res.redirect(req.session.userId ? "/" : "/auth/login");
    }
    try {
        const brands = await Brand.find().sort({ brand_name: 1 }).lean();
        res.render("admin/brands_admin", { brands });
    } catch (err) {
        res.status(500).render("templates/error", { errorMessage: "Failed to fetch brands" });
    }
});

// Route to create a new brand (POST)
router.post("/", async (req, res) => {
    try {
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }

        const { brand_id, name, description, headquarters, website, founded_year } = req.body;
        if (!brand_id || !name) {
            req.flash("error", "Brand name and ID are required");
            return res.redirect(303, "/brands/admin");
        }

        const existingBrand = await Brand.findOne({ $or: [{ brand_id }, { brand_name: name }] });
        if (existingBrand) {
            req.flash("error", "A brand with this ID or name already exists");
            return res.redirect(303, "/brands/admin");
        }

        const newBrand = new Brand({
            brand_id,
            brand_name: name,
            brand_description: description,
            headquarters: headquarters,
            website: website,
            founded_year
        });
        await newBrand.save();

        req.flash("success", `Brand “${name}” created`);
        res.redirect(303, "/brands/admin");
    } catch (err) {
        req.flash("error", "Failed to create brand: " + err.message);
        res.redirect(303, "/brands/admin");
    }
});

// Update Category
router.put("/:id", async (req, res) => {
    try {
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }

        const { brand_id, name, description, headquarters, founded_year, website } = req.body;

        if (!brand_id || !name) {
            return res.status(400).json({ error: "Brand name is required" });
        }

        // Find and update the brand
        const updatedBrand = await Brand.findOneAndUpdate(
            { brand_id: brand_id },
            {
                brand_name: name,
                brand_description: description,
                headquarters,
                founded_year: founded_year || undefined,
                website,
            },
            {new: true}
        );

        if (!updatedBrand) {
            return res.status(404).json({ error: "Brand not found" });
        }

        // Update brand name in all relevant products
        await Product.updateMany(
            { "brand.id": parseInt(req.params.id) },
            { $set: { "brand.name": name } }
        );
        res.status(200).json({ message: "Brand updated successfully" });
    } catch (err) {
        console.error("Error updating brand:", err);
        res.status(500).json({ error: "Failed to update brand" });
    }
});

// Delete Category
router.delete("/:id", async (req, res) => {
    try {
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }
        // Delete all products associated with the brand
        const resp = await Product.deleteMany({ "brand.id": parseInt(req.params.id) });

        if (!resp.acknowledged) {
            return res.status(501).json({ error: "Failed to delete products for this brand" });
        }

        // Delete the brand itself
        const deletedBrand = await Brand.findOneAndDelete({brand_id: parseInt(req.params.id)});

        if (!deletedBrand) {
            return res.status(503).json({ error: "Brand not found" });
        }

        return res.status(200).json({ message: "Brand and related products deleted successfully" });
    } catch (err) {
        console.error("Error deleting brand:", err);
        return res.status(500).json({ error: "Failed to delete brand" });
    }
});


module.exports = router;