// "For you" page: personalized recommendations with the reason for each product
const express = require("express");
const router = express.Router();
const reco = require("../../scripts/recommender");

router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId;
        const algorithm = req.query.algorithm === "user" ? "user" : "item";
        const [result, trending] = await Promise.all([
            userId ? reco.recommendForUser(userId, { limit: 24, algorithm }) : null,
            reco.popular({ limit: 8 })
        ]);
        res.render("recommendations", { result, trending, algorithm, back: req.originalUrl });
    } catch (err) {
        console.error("Recommendations page error:", err);
        res.status(500).render("templates/error", { errorMessage: "Could not load recommendations" });
    }
});

// Admin: rebuild the similarity matrix from the page
router.post("/rebuild", async (req, res) => {
    if (req.session.userStatus !== "admin") {
        req.flash("warning", "This action is for administrators only");
        return res.redirect(303, "/recommendations");
    }
    try {
        const s = await reco.buildSimilarities("manual");
        req.flash("success", `Recommendations rebuilt: ${s.items} products, ${s.users} users in ${s.durationMs} ms`);
    } catch (err) {
        req.flash("error", "Rebuild failed: " + err.message);
    }
    res.redirect(303, req.body.back && String(req.body.back).startsWith("/") && !String(req.body.back).startsWith("//") ? req.body.back : "/recommendations");
});

module.exports = router;
