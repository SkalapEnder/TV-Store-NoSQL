const express = require('express');
const Brand = require('../../models/Brand');
const Product = require('../../models/Product');
const Category = require('../../models/Category');
const { updateDailyTVProducts } = require("../../scripts/scraper");
const router = express.Router();

router.get("/", async (req, res) => {
    if (req.session.userStatus !== 'admin') {
        req.flash("warning", "This page is for administrators only");
        return res.redirect(req.session.userId ? "/" : "/auth/login");
    }

    try {
        const [products, brands, categories] = await Promise.all([
            Product.find().sort({ product_id: 1 }).lean(),
            Brand.find({}, "brand_id brand_name").sort({ brand_name: 1 }).lean(),
            Category.find({}, "category_id category_name").sort({ category_name: 1 }).lean()
        ]);
        res.render("admin/products_admin", { products, brands, categories });
    } catch (err) {
        res.render("templates/error", { errorMessage: "Error getting products: " + err });
    }
});

router.post("/", async (req, res) => {
    try {
        // Ensure only admins can create a product
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", { errorMessage: "Unauthorized. Please, login to admin" });
        }

        const { product_id, name, model, description, price, available, diagonal, brand, category, url, pictures } = req.body;

        // Filter out empty picture URLs
        const imageArray = Array.isArray(pictures) ? pictures.filter(pic => pic.trim() !== "") : [];

        // Fetch brand details
        const brandData = await Brand.findOne({ brand_id: brand }).select("brand_id brand_name");

        // Fetch category details
        const categoryData = await Category.findOne({ category_id: category }).select("category_id category_name");

        if (!brandData || !categoryData) {
            req.flash("error", "Invalid brand or category");
            return res.redirect(303, "/products/admin");
        }
        if (await Product.exists({ product_id })) {
            req.flash("error", `Product ID ${product_id} is already used`);
            return res.redirect(303, "/products/admin");
        }

        // Create new product with brand & category details
        const newProduct = new Product({
            product_id,
            name,
            model,
            description,
            price,
            quantity: parseInt(available),
            diagonal,
            brand: {
                id: brandData.brand_id,
                name: brandData.brand_name,
            },
            category: {
                id: categoryData.category_id,
                name: categoryData.category_name,
            },
            url,
            pictures: imageArray,
        });

        await newProduct.save();
        req.flash("success", `Product “${name}” added`);
        res.redirect(303, "/products/admin");
    } catch (err) {
        console.error("Error creating product:", err);
        req.flash("error", "Could not create the product: " + err.message);
        res.redirect(303, "/products/admin");
    }
});


router.put("/:id", async (req, res) => {
    try {
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }

        await Product.findOneAndUpdate({product_id: parseInt(req.params.id)}, req.body);
        res.status(200).json({success: true});
    } catch (err) {
        res.status(500).send("Error updating product");
    }
});

router.delete("/:id", async (req, res) => {
    try {
        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }

        await Product.findOneAndDelete({product_id: parseInt(req.params.id)});
        res.status(200).json({success: true});
    } catch (err) {
        res.status(500).json({message: "Error deleting product"});
    }
});

router.post("/scrape", async (req, res) => {
    if (req.session.userStatus !== "admin") {
        req.flash("warning", "This action is for administrators only");
        return res.redirect(303, "/");
    }
    try {
        const total = await updateDailyTVProducts();
        req.flash("success", `Import finished: ${total} products in the catalog`);
    } catch (err) {
        console.error("Scraping error:", err);
        req.flash("error", "Import failed: " + err.message);
    }
    res.redirect(303, "/products/admin");
});

module.exports = router;