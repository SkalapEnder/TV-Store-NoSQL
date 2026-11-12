// Categories page: product types grouped (Phones & TV, PC components, …) with counts and prices.
// Categories are defined in config/categories.js; the numbers come from one aggregation.
const express = require("express");
const router = express.Router();
const { categoryStats } = require("../../scripts/catalog");
const { getCategory, getGroup } = require("../../config/categories");

router.get("/", async (req, res) => {
    try {
        res.render("categories/index", { groups: await categoryStats() });
    } catch (err) {
        console.error("Categories error:", err);
        res.status(500).render("templates/error", { errorMessage: "Could not load categories" });
    }
});

// /categories/gpu -> catalog of that category; /categories/pc-parts -> catalog of the group
router.get("/:slug", (req, res) => {
    if (getCategory(req.params.slug)) return res.redirect(301, `/products?category=${req.params.slug}`);
    if (getGroup(req.params.slug)) return res.redirect(301, `/products?group=${req.params.slug}`);
    res.status(404).render("templates/error", { errorMessage: "Category not found", status: 404 });
});

module.exports = router;
