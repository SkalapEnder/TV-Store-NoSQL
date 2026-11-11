const mongoose = require('mongoose');

// One cart per user. Product name/price/picture are copied in, so the cart page
// renders from a single document.
const cartSchema = new mongoose.Schema(
    {
        user_id: { type: String, required: true, unique: true },
        products: [
            {
                _id: false,
                product_id: { type: Number, required: true },
                name:     { type: String, required: true },
                price:    { type: Number, required: true }, // price at the time of adding to cart
                picture:  { type: String },
                quantity: { type: Number, default: 1, min: 1 },
                total:    { type: Number, default: 0 }
            }
        ],
        cart_total: { type: Number, default: 0 }
    },
    { timestamps: true }
);

cartSchema.pre("save", function () {
    this.products.forEach(product => {
        product.total = product.price * product.quantity;
    });
    this.cart_total = this.products.reduce((sum, p) => sum + p.total, 0);
});

const Cart = mongoose.models.cart || mongoose.model('cart', cartSchema);
module.exports = Cart;
