const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const methodOverride = require("method-override");
const passport = require('passport');
const connectDB = require("./scripts/db");
const User = require('./models/User');
const Cart = require('./models/Cart');
const Product = require('./models/Product');
const catalog = require('./scripts/catalog');
const categoryConfig = require('./config/categories');

//const adminRouter = require("./routes/admin/adminRoutes");
const adminProductRouter = require("./routes/admin/adminProductRoutes");
const adminUserRouter = require("./routes/admin/adminUsersRoutes");
const mongoRoutes = require("./routes/admin/mongoRoutes");

const authRouter = require('./routes/authRoutes');
const productRouter = require('./routes/user/productRoutes');
const cartRouter = require('./routes/user/cartRoutes');
const categoryRouter = require('./routes/user/categoryRoutes');
const recommendationRouter = require('./routes/user/recommendationRoutes');
const recommendationApi = require('./routes/api/recommendationRoutes');
const reco = require('./scripts/recommender');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Session middleware
app.use(session({
    secret: 'ff63d7fe7d4cb794a5b97a0708e560b9c015fb59a4a0e85dbf1d11a47f14ed32',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 }
}));
app.use(methodOverride("_method"));
app.use((req, res, next) => {
    res.locals.isLoggedIn = req.session.isLoggedIn || false;
    res.locals.userStatus = req.session.userStatus || 'user';
    res.locals.username = req.session.username || 'Guest';
    res.locals.userId = req.session.userId || -1;

    // One-time notification shown as a toast on the next page (set before a redirect)
    req.flash = (type, message) => { req.session.flash = { type, message }; };
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
});

// Number of items in the cart, for the badge in the header (only for HTML pages)
app.use(async (req, res, next) => {
    res.locals.cartCount = 0;
    if (!req.session.userId || req.method !== 'GET' || !req.accepts('html')) return next();
    try {
        const cart = await Cart.findOne({ user_id: req.session.userId }, { 'products.quantity': 1 }).lean();
        res.locals.cartCount = (cart?.products || []).reduce((sum, p) => sum + (p.quantity || 0), 0);
    } catch (err) {
        console.error('Cart badge error:', err.message);
    }
    next();
});
app.use(passport.initialize());
app.use(passport.session());

app.get('/', async (req, res) => {
    try {
        const [featured, groups, user] = await Promise.all([
            Product.find({ quantity: { $gt: 0 } })
                .select(catalog.CARD_FIELDS)
                .sort({ rating_count: -1, price: -1 })
                .limit(8)
                .lean(),
            catalog.categoryStats(),
            req.session.userId ? User.findById(req.session.userId).select('view_history').lean() : null
        ]);
        // Personal recommendations (item-based collaborative filtering); the page still works without them
        const recommended = req.session.userId
            ? await reco.recommendForUser(req.session.userId, { limit: 4 }).catch(err => { console.error('Recommendations error:', err.message); return null; })
            : null;

        featured.forEach(p => { p.rating_avg = p.rating_count ? p.rating_sum / p.rating_count : null; });
        const categories = groups.flatMap(g => g.categories).filter(c => c.count > 0);

        const recentHistory = (user?.view_history || [])
            .sort((a, b) => new Date(b.lastViewed) - new Date(a.lastViewed))
            .slice(0, 4);

        res.render('index', { recentHistory, featured, categories, recommended });
    } catch (err) {
        console.error('Error loading home page:', err);
        res.status(500).render('templates/error', { errorMessage: 'Could not load the home page' });
    }
});

// Routes
app.use('/products/admin', adminProductRouter);
app.use('/users/admin', adminUserRouter);
app.use("/mongo", mongoRoutes);

app.use('/auth', authRouter);
app.use('/cart', cartRouter);
app.use("/products", productRouter);
app.use("/categories", categoryRouter);
app.use("/recommendations", recommendationRouter);
app.use("/api/recommendations", recommendationApi);

app.use((req, res) => {
    res.status(404).render('templates/error', { errorMessage: 'Page not found', status: 404 });
});


connectDB().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
    // Similarity matrix: built at startup if missing/old, then every RECO_REBUILD_MINUTES (default 60)
    if (process.env.RECO_SCHEDULE !== 'off') reco.scheduleBuilds();
}).catch(err => process.exit(1));

function convertData(timestamp) {
    const date = new Date(Date.parse(timestamp));

    const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const day = date.getDate();
    const month = date.toLocaleString('en-GB', { month: 'long' });
    const year = date.getFullYear();

    return `${time}, ${day} ${month}, ${year}`;
}

function capitalizeFirstLetter(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

app.locals.assetVersion = Date.now().toString(36);   // changes on every restart: browsers fetch fresh CSS/JS
app.locals.convertData = convertData;
app.locals.capitalizeFirstLetter = capitalizeFirstLetter;
// Category helpers for the templates (names, icons, spec labels)
app.locals.getCategory = categoryConfig.getCategory;
app.locals.formatSpec = categoryConfig.formatSpec;
app.locals.cardSpecs = categoryConfig.cardSpecs;
app.locals.storeName = 'TechStore';
app.locals.navGroups = categoryConfig.GROUPS.map(g => ({ ...g, categories: categoryConfig.categoriesOfGroup(g.slug) }));
