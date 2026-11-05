const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
    username: { type: String, required: true},
    password: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, enum: ["admin", "user"], required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    view_history: [{
        _id: false,
        product_id: { type: Number, required: true },
        name:       String,
        price:      Number,
        url:        String,
        pictures:   [String],
        views:      { type: Number, default: 0 },
        lastViewed: { type: Date, default: Date.now }
    }],
    purchase_history: [{
        _id: false,
        order_id:    { type: String, required: true },
        product_id:  { type: Number, required: true },
        name:        String,
        price:       { type: Number, required: true },   // unit price at purchase time
        quantity:    { type: Number, required: true, min: 1 },
        url:         String,
        picture:     String,                              
        purchasedAt: { type: Date, default: Date.now }
    }]
}, { timestamps: true });

userSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    //next();
});

userSchema.methods.comparePassword = async function (password) {
    password = await bcrypt.hash(password, 10);
    return bcrypt.compare(password, this.password);
};

const User = mongoose.model('user', userSchema);
module.exports = User;

