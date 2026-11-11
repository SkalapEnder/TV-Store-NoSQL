const express = require('express');
const User = require('../../models/User');
const Cart = require('../../models/Cart');
const router = express.Router();
const adminCode = 'admin1243'

router.get("/", async (req, res) => {
    if (req.session.userStatus !== 'admin') {
        req.flash("warning", "This page is for administrators only");
        return res.redirect(req.session.userId ? "/" : "/auth/login");
    }

    try{
        const users = await User.find({}, 'username email role createdAt purchase_history.order_id').sort({ createdAt: -1 }).lean();
        res.render("admin/users_admin", { users: users });
    } catch(err) {
        return res.render("templates/error", {errorMessage: "Error getting users: " + err});
    }
});

router.post("/", async (req, res) => {
    try {
        const { username, email, password, role, secretCode } = req.body;

        if (!req.session.userStatus || req.session.userStatus !== "admin") {
            return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
        }

        if (!username || !email || !password || !role) {
            req.flash("error", "All fields are required");
            return res.redirect(303, "/users/admin");
        }

        const newUser = await User.create({ username, email, password, role });
        await Cart.create({ user_id: newUser._id.toString(), products: [] });
        req.flash("success", `User ${username} created`);
        res.redirect(303, "/users/admin");

    } catch (err) {
        console.error("Error creating user:", err);
        req.flash("error", err.code === 11000 ? "This email is already registered" : "Could not create the user: " + err.message);
        res.redirect(303, "/users/admin");
    }
});

router.put('/:id', async (req, res) => {
    const { username, email, role, secretCode } = req.body;

    if (!req.session.userStatus || req.session.userStatus !== "admin") {
        return res.render("templates/error", {errorMessage: "Unauthorized. Please, login to admin" });
    }

    if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ errorMessage: 'Invalid role' });
    }

    try {
        const current = await User.findById(req.params.id, 'role').lean();
        if (!current) return res.status(404).json({ errorMessage: 'User not found' });

        // The secret code is needed only to grant the admin role, not to edit an existing admin
        if (role === 'admin' && current.role !== 'admin' && secretCode !== adminCode) {
            return res.status(400).json({ errorMessage: 'Invalid admin code' });
        }

        await User.findByIdAndUpdate(req.params.id, { username, email, role }, { runValidators: true });

        // Only when admins edit their own account does their session change
        if (String(req.params.id) === String(req.session.userId)) {
            req.session.userStatus = role;
            req.session.username = username;
        }
        res.status(200).json({ message: 'User updated' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ errorMessage: err.code === 11000 ? 'This email is already used' : 'Error updating user.' });
    }
});

router.delete('/:id', async (req, res) => {
    const userId = req.params.id;

    if (!req.session.userStatus || req.session.userStatus !== "admin") {
        return res.status(401).json({errorMessage: "Unauthorized. Please, login to admin" });
    }

    try {
        const response = await Cart.deleteMany({ user_id: userId });

        if (!response.acknowledged) {
            return res.status(402).json({ errorMessage: 'Cannot delete cart'});
        }

        const deletedUser = await User.findByIdAndDelete(userId);
        if (deletedUser === null) {
            return res.status(403).json({errorMessage: 'User not found or not deleted'});
        }

        res.status(200).json({ message: 'Successfully deleted' });
    } catch (err) {
        return res.status(500).json({errorMessage: err});
    }
});

module.exports = router;