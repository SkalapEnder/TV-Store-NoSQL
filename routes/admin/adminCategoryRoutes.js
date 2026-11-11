const express = require('express');
const Category = require('../../models/Category');
const Product = require('../../models/Product');
const router = express.Router();

// Only administrators may use this router
router.use((req, res, next) => {
    if (req.session.userStatus === "admin") return next();
    if (req.method === "GET") {
        req.flash("warning", "This page is for administrators only");
        return res.redirect(req.session.userId ? "/" : "/auth/login");
    }
    return res.status(403).json({ error: "Unauthorized. Please, login to admin" });
});

// GET all categories and render the categories_admin.ejs page
router.get("/", async (req, res) => {
    try {
        const categories = await Category.find().sort({ category_id: 1 }).lean();
        res.render("admin/categories_admin", { categories });
    } catch (err) {
        console.error("Error fetching categories:", err);
        res.status(500).render("templates/error", { errorMessage: "Error fetching categories" });
    }
});

// Create a new category
router.post("/", async (req, res) => {
    try {
        const { category_id, category_name, category_description } = req.body;

        const existingCategory = await Category.findOne({ $or: [{ category_id }, { category_name }] });
        if (existingCategory) {
            req.flash("error", "A category with this ID or name already exists");
            return res.redirect(303, "/categories/admin");
        }

        await Category.create({ category_id, category_name, category_description });
        req.flash("success", `Category “${category_name}” created`);
        res.redirect(303, "/categories/admin");
    } catch (err) {
        console.error("Error creating category:", err);
        req.flash("error", "Could not create the category: " + err.message);
        res.redirect(303, "/categories/admin");
    }
});

// Update Category
router.put("/:id", async (req, res) => {
    try {
        const { name, description } = req.body;

        // Find and update the category
        const updatedCategory = await Category.findOneAndUpdate(
            { category_id: req.params.id },
            { category_name: name, category_description: description },
            { new: true }
        );

        if (!updatedCategory) {
            return res.status(404).json({ error: "Category not found" });
        }

        // Update all products associated with this category
        await Product.updateMany(
            { "category.id": req.params.id },
            { "category.name": name }
        );

        res.status(200).json({ message: "Category and related products updated successfully" });
    } catch (err) {
        console.error("Error updating category:", err);
        res.status(500).json({ error: "Failed to update category and related products" });
    }
});


// Delete Category
router.delete("/:id", async (req, res) => {
    try {
        // First, delete all products associated with this category
        const deleteProducts = await Product.deleteMany({ "category.id": req.params.id });

        if (!deleteProducts.acknowledged) {
            return res.status(404).json({ error: "Related Products not deleted" });
        }

        // Then, delete the category itself
        const deletedCategory = await Category.findOneAndDelete({ category_id: req.params.id });

        if (!deletedCategory) {
            return res.status(404).json({ error: "Category not found" });
        }

        res.status(200).json({ message: "Category and related products deleted successfully" });
    } catch (err) {
        console.error("Error deleting category:", err);
        res.status(500).json({ error: "Failed to delete category and related products" });
    }
});

module.exports = router;