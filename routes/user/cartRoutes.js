const express = require("express");
const router = express.Router();
const Cart = require("../../models/Cart");
const Product = require("../../models/Product");
const { recordPurchase } = require("../../scripts/purchase");

// Only local paths are accepted as a return address (no open redirect)
const safeBack = (value, fallback) =>
    typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : fallback;

const fmt = n => Number(n).toLocaleString("ru-RU");

// Add product to cart
router.post("/add", async (req, res) => {
    const productId = parseInt(req.body.product_id);
    const back = safeBack(req.body.back, Number.isNaN(productId) ? "/products" : `/products/${productId}`);
    try {
        const user_id = req.session.userId;
        if (!user_id) {
            req.flash("warning", "Please log in to add products to your cart");
            return res.redirect(303, "/auth/login");
        }

        const qty = Math.max(parseInt(req.body.quantity) || 1, 1);
        if (Number.isNaN(productId)) {
            req.flash("error", "Unknown product");
            return res.redirect(303, back);
        }

        const product = await Product.findOne({ product_id: productId });
        if (!product) {
            req.flash("error", "This product is no longer available");
            return res.redirect(303, back);
        }

        let cart = await Cart.findOne({ user_id });
        if (!cart) cart = new Cart({ user_id, products: [] });

        const existing = cart.products.find(p => Number(p.product_id) === productId);
        const newQty = (existing ? existing.quantity : 0) + qty;
        if (newQty > product.quantity) {
            req.flash("warning", product.quantity > 0 ? `Only ${product.quantity} in stock` : "This product is out of stock");
            return res.redirect(303, back);
        }

        if (existing) {
            existing.quantity = newQty;
            existing.price = product.price;
        } else {
            cart.products.push({
                product_id: product.product_id,
                name: product.name,
                price: product.price,
                picture: (product.pictures || [])[0] || "",
                quantity: qty
            });
        }
        await cart.save();   // the pre-save hook recalculates line totals and cart_total

        req.flash("success", `${qty > 1 ? qty + " × " : ""}${product.name} added to your cart`);
        res.redirect(303, back);
    } catch (error) {
        console.error("Error adding product to cart:", error);
        req.flash("error", "Could not add the product to your cart");
        res.redirect(303, back);
    }
});

// Change quantity of one line
router.post("/update", async (req, res) => {
    try {
        const user_id = req.session.userId;
        if (!user_id) return res.redirect(303, "/auth/login");

        const productId = Number(req.body.product_id);
        const qty = parseInt(req.body.quantity);
        if (!Number.isInteger(productId) || !Number.isInteger(qty)) return res.redirect(303, "/cart");

        const cart = await Cart.findOne({ user_id });
        const line = cart?.products.find(p => Number(p.product_id) === productId);
        if (!line) return res.redirect(303, "/cart");

        if (qty < 1) {
            cart.products = cart.products.filter(p => Number(p.product_id) !== productId);
            req.flash("info", `${line.name} removed from your cart`);
        } else {
            const product = await Product.findOne({ product_id: productId }, "quantity price").lean();
            const max = product ? product.quantity : 0;
            line.quantity = Math.min(qty, Math.max(max, 1));
            if (product) line.price = product.price;
            if (qty > max) req.flash("warning", `Only ${max} in stock`);
        }
        await cart.save();
        res.redirect(303, "/cart");
    } catch (err) {
        console.error("Error updating cart:", err);
        req.flash("error", "Could not update your cart");
        res.redirect(303, "/cart");
    }
});

// Remove product from cart
router.post("/remove", async (req, res) => {
    try {
        const user_id = req.session.userId;
        const productId = Number(req.body.product_id);
        if (!user_id) return res.redirect(303, "/auth/login");
        if (!Number.isInteger(productId)) return res.redirect(303, "/cart");

        const cart = await Cart.findOne({ user_id });
        if (cart) {
            const line = cart.products.find(p => Number(p.product_id) === productId);
            cart.products = cart.products.filter(p => Number(p.product_id) !== productId);
            await cart.save();
            if (line) req.flash("info", `${line.name} removed from your cart`);
        }
        res.redirect(303, "/cart");
    } catch (err) {
        console.error("Error removing product from cart:", err);
        req.flash("error", "Could not remove the product");
        res.redirect(303, "/cart");
    }
});

// Perform purchase (clears cart)
router.post("/purchase", async (req, res) => {
    const user_id = req.session.userId;
    if (!user_id) return res.redirect(303, "/auth/login");

    let cart = null;
    try {
        // Atomically take the cart's contents and empty it. A double click can't buy the same cart twice,
        // because only one request gets a non-empty cart back.
        cart = await Cart.findOneAndUpdate(
            { user_id, "products.0": { $exists: true } },
            { $set: { products: [], cart_total: 0 } },
            { new: false }                      // returns the cart as it was before emptying
        );
        if (!cart) {
            req.flash("warning", "Your cart is empty");
            return res.redirect(303, "/cart");
        }

        const order = await recordPurchase(
            user_id,
            cart.products.map(p => ({ product_id: p.product_id, quantity: p.quantity }))
        );

        const items = order.items.reduce((s, l) => s + l.quantity, 0);
        req.flash("success", `Thank you! Order placed: ${items} ${items === 1 ? "item" : "items"} for ${fmt(order.total)} ₸`);
        res.redirect(303, "/auth/profile#orders");
    } catch (err) {
        // Put the cart back, so a failed purchase loses nothing
        if (cart) {
            await Cart.updateOne({ user_id }, { $set: { products: cart.products, cart_total: cart.cart_total } });
        }
        if (!err.userFacing) console.error("Error processing purchase:", err);
        req.flash("error", err.message && /stock|unavailable/i.test(err.message) ? err.message : "Payment failed. Your cart was kept.");
        res.redirect(303, "/cart");
    }
});

// Cart page
router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId;
        if (!userId) return res.redirect("/auth/login");

        const cart = await Cart.findOne({ user_id: userId }).lean();
        const productIds = (cart?.products || []).map(p => p.product_id);
        // Current stock, to limit the quantity inputs and flag lines that can't be bought
        const stock = productIds.length
            ? Object.fromEntries((await Product.find({ product_id: { $in: productIds } }, "product_id quantity brand").lean())
                .map(p => [p.product_id, p]))
            : {};
        res.render("cart", { cart: cart || { products: [], cart_total: 0 }, stock });
    } catch (error) {
        console.error("Error fetching cart:", error);
        res.status(500).render("templates/error", { errorMessage: "Failed to load your cart" });
    }
});

module.exports = router;
