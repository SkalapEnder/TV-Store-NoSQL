const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// User interactions are embedded in the user document: the profile page and the
// "recently viewed" block read one document by _id, with no joins.
// view_history is capped (MAX_HISTORY in scripts/tracker.js), so the document stays small.
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, trim: true },
    password: { type: String, required: true },
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    role:     { type: String, enum: ["admin", "user"], required: true, default: "user" },

    // Basic profile information
    profile: {
        full_name:  { type: String, trim: true, maxlength: 100 },
        phone:      { type: String, trim: true, maxlength: 30 },
        city:       { type: String, trim: true, maxlength: 60 },
        birth_date: { type: Date },
        about:      { type: String, trim: true, maxlength: 500 }
    },

    // One entry per product: repeated views increment `views` instead of adding entries
    view_history: [{
        _id: false,
        product_id: { type: Number, required: true },
        name:       String,
        price:      Number,
        url:        String,
        pictures:   [String],
        views:      { type: Number, default: 0 },
        rating:     { type: Number, min: 1, max: 5 },
        review:     { type: String, trim: true, maxlength: 1000 },   // optional text written with the rating
        ratedAt:    Date,
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
}, { timestamps: true });   // createdAt / updatedAt are managed by Mongoose

// Multikey indexes for "which users interacted with product X" (item-based recommendations)
userSchema.index({ "view_history.product_id": 1 });
userSchema.index({ "purchase_history.product_id": 1 });

userSchema.pre('save', async function () {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, 10);
    }
});

userSchema.methods.comparePassword = function (password) {
    return bcrypt.compare(password, this.password);
};

const User = mongoose.models.user || mongoose.model('user', userSchema);
module.exports = User;
