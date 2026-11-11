const express = require('express');
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const LocalStrategy = require('passport-local');

const User = require('../models/User');
const Cart = require('../models/Cart');
const router = express.Router();
const adminCode = 'admin1243'

passport.use(new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
    try {
        const user = await User.findOne({ email: String(email).toLowerCase().trim() });
        if (user === null) return done(null, false, { message: 'Invalid email or password' });

        const isMatch = await user.comparePassword(password);
        if (!isMatch) return done(null, false, { message: 'Invalid email or password' });

        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

passport.serializeUser((user, done) => done(null, user._id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err);
    }
});

const requireLogin = (req, res, next) => {
    if (req.session.userId) return next();
    return res.redirect('/auth/login');
};

// ---------- Profile fields: shared by registration and update ----------
const profileValidators = [
    body("username").trim().isLength({ min: 2, max: 50 }).withMessage("Name must be 2-50 characters"),
    body("email").trim().toLowerCase().isEmail().withMessage("Invalid email address"),
    body("full_name").optional({ values: "falsy" }).trim().isLength({ max: 100 }).withMessage("Full name is too long"),
    body("phone").optional({ values: "falsy" }).trim()
        .matches(/^\+?[0-9\s\-()]{7,20}$/).withMessage("Invalid phone number"),
    body("city").optional({ values: "falsy" }).trim().isLength({ max: 60 }).withMessage("City name is too long"),
    body("birth_date").optional({ values: "falsy" }).isISO8601().withMessage("Invalid birth date")
        .custom(value => new Date(value) < new Date()).withMessage("Birth date must be in the past"),
    body("about").optional({ values: "falsy" }).trim().isLength({ max: 500 }).withMessage("About must be at most 500 characters"),
];

function pickProfile(reqBody) {
    const { full_name, phone, city, birth_date, about } = reqBody;
    return {
        full_name: full_name || undefined,
        phone: phone || undefined,
        city: city || undefined,
        birth_date: birth_date ? new Date(birth_date) : undefined,
        about: about || undefined
    };
}

// REGISTER
router.get('/register', (req, res) => res.render('auth/registration', { role: 'user' }));

router.post(
    "/register",
    [
        ...profileValidators,
        body("password")
            .isLength({ min: 6 }).withMessage("Password must be at least 6 characters")
            .matches(/[A-Z]/).withMessage("Password must contain an uppercase letter")
            .matches(/[a-z]/).withMessage("Password must contain a lowercase letter")
            .matches(/[0-9]/).withMessage("Password must contain a number"),
        body("role").optional().isIn(["user", "admin"]).withMessage("Invalid role"),
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errorMessage: errors.array()[0]["msg"] });
            }

            const { username, email, password, secretCode } = req.body;
            const role = req.body.role || "user";

            if (role === "admin" && secretCode !== adminCode) {
                return res.status(400).json({ errorMessage: "Invalid secret code" });
            }

            const existingUser = await User.exists({ email });
            if (existingUser) {
                return res.status(400).json({ errorMessage: "User with this email already exists" });
            }

            const newUser = await User.create({ username, email, password, role, profile: pickProfile(req.body) });
            await Cart.create({ user_id: newUser._id.toString(), products: [] });

            res.json({ success: true, redirectUrl: "/auth/login" });
        } catch (error) {
            if (error.code === 11000) {   // unique email index: two registrations at the same moment
                return res.status(400).json({ errorMessage: "User with this email already exists" });
            }
            console.error("Registration error:", error);
            res.status(500).json({ errorMessage: "Server error: " + error.message });
        }
    }
);

// LOGIN
router.get('/login', (req, res) => {
    res.render('auth/login');
});

router.post('/login', async (req, res) => {
    try {
        const email = String(req.body.email || "").toLowerCase().trim();
        const password = String(req.body.password || "");

        const user = await User.findOne({ email }).select('password role username');
        if (user === null || !(await user.comparePassword(password))) {
            return res.status(400).json({ errorMessage: 'Invalid email or password' });
        }

        req.session.userId = user._id.toString();
        req.session.userStatus = user.role;
        req.session.username = user.username;
        req.session.isLoggedIn = true;
        res.json({ success: true, redirectUrl: '/' });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ errorMessage: 'Server error' });
    }
});

// UPDATE PROFILE
router.get('/update', requireLogin, async (req, res) => {
    const user = await User.findById(req.session.userId).select('-password -view_history -purchase_history').lean();
    if (user === null) {
        return res.render('templates/error', { errorMessage: 'User not found' });
    }
    res.render('profile/update', { user });
})

router.post('/update', requireLogin, profileValidators, async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.render('templates/error', { errorMessage: errors.array()[0].msg });
    }

    const { username, email, role, secret_code } = req.body;
    if (!["user", "admin"].includes(role)) {
        return res.render('templates/error', { errorMessage: 'Invalid role' });
    }
    if (role === 'admin' && req.session.userStatus !== 'admin' && secret_code !== adminCode) {
        return res.render('templates/error', { errorMessage: 'Invalid secret code' });
    }

    try {
        const updatedUser = await User.findByIdAndUpdate(
            req.session.userId,
            { $set: { username, email, role, profile: pickProfile(req.body) } },
            { runValidators: true }
        );
        if (updatedUser === null) {
            return res.render('templates/error', { errorMessage: 'Error updating user' });
        }
        req.session.userStatus = role;
        req.session.username = username;
        req.flash('success', 'Your profile was updated');
        res.redirect('/auth/profile');
    } catch (err) {
        if (err.code === 11000) {
            return res.render('templates/error', { errorMessage: 'This email is already used by another account' });
        }
        console.error(err);
        res.status(500).send('Error updating user.');
    }
});

// LOG OUT
router.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.render('templates/error', { errorMessage: 'Error logging out' });
        }
        res.redirect('/');
    });
});

router.post('/delete-account', requireLogin, async (req, res) => {
    const userId = req.session.userId;
    try {
        await Cart.deleteMany({ user_id: userId });

        const deletedUser = await User.findByIdAndDelete(userId);
        if (deletedUser === null) {
            return res.render('templates/error', { errorMessage: 'User not found or not deleted' });
        }

        req.session.destroy(() => res.redirect('/'));
    } catch (err) {
        return res.render('templates/error', { errorMessage: err.message });
    }
});

router.get('/profile', requireLogin, async (req, res) => {
    const user = await User.findById(req.session.userId).select('-password').lean();
    if (user === null) {
        return res.render('templates/error', { errorMessage: 'User not found' });
    }
    // Most recent first; the arrays are bounded, so sorting in the app is cheap
    user.view_history = (user.view_history || []).sort((a, b) => new Date(b.lastViewed) - new Date(a.lastViewed));

    // Purchase lines grouped into orders, newest first
    const byOrder = new Map();
    for (const line of user.purchase_history || []) {
        if (!byOrder.has(line.order_id)) {
            byOrder.set(line.order_id, { order_id: line.order_id, purchasedAt: line.purchasedAt, items: [], total: 0, count: 0 });
        }
        const order = byOrder.get(line.order_id);
        order.items.push(line);
        order.total += line.price * line.quantity;
        order.count += line.quantity;
    }
    const orders = [...byOrder.values()].sort((a, b) => new Date(b.purchasedAt) - new Date(a.purchasedAt));

    const stats = {
        orders: orders.length,
        items: orders.reduce((s, o) => s + o.count, 0),
        spent: orders.reduce((s, o) => s + o.total, 0),
        viewed: user.view_history.length,
        rated: user.view_history.filter(v => v.rating).length
    };
    return res.render('profile/profile', { user, orders, stats });
})

module.exports = router;
