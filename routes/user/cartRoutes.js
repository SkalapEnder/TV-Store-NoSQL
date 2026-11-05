const express = require("express");
const router = express.Router();
const Cart = require("../../models/Cart");
const Product = require("../../models/Product");
const { recordPurchase } = require("../../scripts/purchase");

// Add product to cart
router.post("/add", async (req, res) => {
    try {
        const user_id = req.session.userId;
        if (!user_id) return res.status(401).json({ error: "Please log in" });

        const productId = parseInt(req.body.product_id);
        const qty = Math.max(parseInt(req.body.quantity) || 1, 1);
        if (Number.isNaN(productId)) return res.status(400).json({ error: "product_id is required" });

        const product = await Product.findOne({ product_id: productId });
        if (!product) return res.status(404).json({ error: "Product not found" });

        let cart = await Cart.findOne({ user_id });
        if (!cart) cart = new Cart({ user_id, products: [] });

        const existing = cart.products.find(p => Number(p.product_id) === productId);
        const newQty = (existing ? existing.quantity : 0) + qty;
        if (newQty > product.quantity) {
            return res.status(400).json({ error: `Only ${product.quantity} in stock` });
        }

        if (existing) {
            existing.quantity = newQty;
            existing.price = product.price;
            existing.total = newQty * product.price;
        } else {
            cart.products.push({
                product_id: product.product_id,
                name: product.name,
                price: product.price,
                picture: (product.pictures || [])[0] || "",
                quantity: qty,
                total: qty * product.price
            });
        }

        cart.cart_total = cart.products.reduce((sum, p) => sum + p.total, 0);
        await cart.save();
        res.redirect(303, `/products/${productId}`);
    } catch (error) {
        console.error("Error adding product to cart:", error);
        res.status(500).json({ error: "Failed to add product to cart: " + error.message });
    }
});

// Remove product from cart
router.post("/remove", async (req, res) => {
    try {
        const { product_id } = req.body;
        const user_id = req.session.userId;
        const productId = Number(product_id);
        if (!user_id || !Number.isInteger(productId)) return res.status(400).json({ error: "User ID and Product ID required" });

        let cart = await Cart.findOne({ user_id });
        if (!cart) return res.status(404).json({ error: "Cart not found" });

        cart.products = cart.products.filter(p => Number(p.product_id) !== productId);
        await cart.save();

        res.redirect(303, `/cart`);
    } catch (err) {
        console.error("Error removing product from cart:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Perform purchase (Clears cart)
router.post("/purchase", async (req, res) => {
    const user_id = req.session.userId;
    if (!user_id) return res.status(401).json({ error: "Please log in" });

    let cart = null;
    try {
        // Atomically take the cart's contents and empty it. A double click can't buy the same cart twice,
        // because only one request gets a non-empty cart back.
        cart = await Cart.findOneAndUpdate(
            { user_id, "products.0": { $exists: true } },
            { $set: { products: [], cart_total: 0 } },
            { new: false }                      // returns the cart as it was before emptying
        );
        if (!cart) return res.status(400).json({ error: "Cart is empty" });

        const order = await recordPurchase(
            user_id,
            cart.products.map(p => ({ product_id: p.product_id, quantity: p.quantity }))
        );

        res.redirect(303, `/cart`);
    } catch (err) {
        // Put the cart back, so a failed purchase loses nothing
        if (cart) {
            await Cart.updateOne({ user_id }, { $set: { products: cart.products, cart_total: cart.cart_total } });
        }
        if (err.userFacing) return res.status(400).json({ error: err.message });   // e.g. out of stock
        console.error("Error processing purchase:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// 🛍️ Get cart details
router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId;
        if (!userId) return res.redirect("/auth/login");
        
        const cart = await Cart.findOne({ user_id: userId });
        res.render("cart", { cart: cart || { products: [], cart_total: 0 } });
    } catch (error) {
        console.error("Error fetching cart:", error);
        res.status(500).json({ error: "Failed to fetch cart" + error });
    }
});



module.exports = router;
