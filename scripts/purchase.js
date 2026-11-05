const mongoose = require("mongoose");
const Product = require("../models/Product");
const User = require("../models/User");

async function recordPurchase(userId, items) {
    if (!Array.isArray(items) || items.length === 0) throw new Error("Cart is empty");

    const orderId = new mongoose.Types.ObjectId().toString();
    const purchasedAt = new Date();
    const reserved = [];   // stock we have already taken (for rollback)
    const lines = [];

    try {
        for (const item of items) {
            const productId = Number(item.product_id);
            const qty = parseInt(item.quantity);
            if (!Number.isInteger(productId) || !Number.isInteger(qty) || qty < 1) {
                throw new Error("Invalid cart item");
            }

            // Atomic: decrements stock only if enough is left, so two buyers can't oversell
            const product = await Product.findOneAndUpdate(
                { product_id: productId, quantity: { $gte: qty } },
                { $inc: { quantity: -qty } },
                { new: true }
            ).lean();
            if (!product) throw new Error(`Product ${productId} is unavailable or out of stock`);
            reserved.push({ productId, qty });

            lines.push({
                order_id: orderId,
                product_id: productId,
                name: product.name,
                price: product.price,              // unit price at purchase time
                quantity: qty,
                url: product.url,
                picture: (product.pictures || [])[0],
                purchasedAt
            });
        }

        await User.updateOne({ _id: userId }, { $push: { purchase_history: { $each: lines } } });
    } catch (err) {
        // Give back any stock taken before the failure
        await Promise.all(
            reserved.map(r => Product.updateOne({ product_id: r.product_id }, { $inc: { quantity: r.qty } }))
        );
        throw err;
    }

    const total = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
    return { orderId, total, items: lines };
}

module.exports = { recordPurchase };
