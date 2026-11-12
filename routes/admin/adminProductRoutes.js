const express = require('express');
const Product = require('../../models/Product');
const { importProducts } = require("../../scripts/scraper");
const { invalidateCatalog } = require("../../scripts/catalog");
const { CATEGORIES, GROUPS, getCategory, cleanSpecs } = require("../../config/categories");
const router = express.Router();

const isAdmin = req => req.session.userStatus === "admin";
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", async (req, res) => {
    if (!isAdmin(req)) {
        req.flash("warning", "This page is for administrators only");
        return res.redirect(req.session.userId ? "/" : "/auth/login");
    }

    try {
        // One category at a time: the whole catalog (5k+ products) is too big for one editable table
        const category = getCategory(req.query.category) || CATEGORIES[0];
        const q = String(req.query.q || "").trim().slice(0, 100);
        const filter = { category: category.slug };
        if (q) {
            const rx = new RegExp(escapeRegex(q), "i");
            filter.$or = [{ name: rx }, { model: rx }, { brand: rx }];
            if (/^\d+$/.test(q)) filter.$or.push({ product_id: Number(q) });
        }
        const [products, counts, brands, maxId] = await Promise.all([
            Product.find(filter).sort({ product_id: 1 }).select("-description").lean(),
            Product.aggregate([{ $group: { _id: "$category", n: { $sum: 1 }, out: { $sum: { $cond: [{ $gt: ["$quantity", 0] }, 0, 1] } } } }]),
            Product.distinct("brand", { category: category.slug }),
            Product.findOne().sort({ product_id: -1 }).select("product_id").lean()
        ]);
        res.render("admin/products_admin", {
            products, category, categories: CATEGORIES, groups: GROUPS, q,
            counts: Object.fromEntries(counts.map(c => [c._id, c])),
            brands: brands.sort((a, b) => a.localeCompare(b)),
            nextId: (maxId?.product_id || 0) + 1
        });
    } catch (err) {
        res.render("templates/error", { errorMessage: "Error getting products: " + err });
    }
});

router.post("/", async (req, res) => {
    if (!isAdmin(req)) return res.render("templates/error", { errorMessage: "Unauthorized. Please, login to admin" });
    const back = `/products/admin?category=${encodeURIComponent(req.body.category || "")}`;
    try {
        const { product_id, name, model, description, price, available, brand, category, url, pictures, specs } = req.body;
        const cat = getCategory(category);
        if (!cat) {
            req.flash("error", "Choose a category");
            return res.redirect(303, "/products/admin");
        }
        if (!String(brand || "").trim()) {
            req.flash("error", "Brand is required");
            return res.redirect(303, back);
        }
        if (await Product.exists({ product_id })) {
            req.flash("error", `Product ID ${product_id} is already used`);
            return res.redirect(303, back);
        }

        // Filter out empty picture URLs
        const imageArray = (Array.isArray(pictures) ? pictures : [pictures]).filter(pic => pic && String(pic).trim() !== "");

        await new Product({
            product_id, name, model, description, price,
            quantity: parseInt(available),
            brand: String(brand).trim(),
            category: cat.slug,
            specs: cleanSpecs(cat.slug, specs),          // only the fields this category declares
            url,
            pictures: imageArray
        }).save();
        invalidateCatalog();
        req.flash("success", `Product “${name}” added`);
        res.redirect(303, back);
    } catch (err) {
        console.error("Error creating product:", err);
        req.flash("error", "Could not create the product: " + err.message);
        res.redirect(303, back);
    }
});

// Inline edit from the table. Only these fields can change; specs are validated against the category
router.put("/:id", async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "Administrators only" });
    try {
        const product = await Product.findOne({ product_id: parseInt(req.params.id) });
        if (!product) return res.status(404).json({ error: "Product not found" });

        const { name, model, price, quantity, brand, specs } = req.body;
        if (name !== undefined) product.name = name;
        if (model !== undefined) product.model = model;
        if (price !== undefined) product.price = price;
        if (quantity !== undefined) product.quantity = quantity;
        if (brand !== undefined && String(brand).trim()) product.brand = String(brand).trim();
        if (specs && typeof specs === "object") product.specs = cleanSpecs(product.category, { ...product.specs, ...specs });
        await product.save();
        invalidateCatalog();
        res.json({ success: true, specs: product.specs });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.delete("/:id", async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: "Administrators only" });
    try {
        await Product.findOneAndDelete({ product_id: parseInt(req.params.id) });
        invalidateCatalog();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ message: "Error deleting product" });
    }
});

router.post("/scrape", async (req, res) => {
    if (!isAdmin(req)) {
        req.flash("warning", "This action is for administrators only");
        return res.redirect(303, "/");
    }
    try {
        const total = await importProducts();
        invalidateCatalog();
        req.flash("success", `Import finished: ${total} products in the catalog`);
    } catch (err) {
        console.error("Scraping error:", err);
        req.flash("error", "Import failed: " + err.message);
    }
    res.redirect(303, "/products/admin");
});

module.exports = router;
