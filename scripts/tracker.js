const User = require('../models/User');
const Product = require('../models/Product');
// Loaded lazily: recommender requires models only, but this keeps the dependency one-way at load time
const invalidateRecommendations = userId => require('./recommender').invalidateUser(userId);

const MAX_HISTORY = 100;

const snapshot = p => ({
  product_id: p.product_id,
  name: p.name,
  price: p.price,
  url: p.url,
  pictures: p.pictures || []     // use p.pictures.slice(0, 1) to store only the first image
});

// Called when a logged-in user opens a product page
async function trackView(req, product) {
  const userId = req.session?.userId;
  if (!userId) return;
  try {
    const snap = snapshot(product);
    const now = new Date();
    // 1) Entry exists: increment views and refresh the snapshot (price may have changed)
    const result = await User.updateOne(
      { _id: userId, 'view_history.product_id': snap.product_id },
      {
        $inc: { 'view_history.$.views': 1 },
        $set: {
          'view_history.$.name': snap.name,
          'view_history.$.price': snap.price,
          'view_history.$.url': snap.url,
          'view_history.$.pictures': snap.pictures,
          'view_history.$.lastViewed': now
        }
      }
    );

    // 2) No entry yet: add one (keeps only the latest MAX_HISTORY products)
    if (result.matchedCount === 0) {
      await User.updateOne(
        { _id: userId },
        { $push: { view_history: { $each: [{ ...snap, views: 1, lastViewed: now }], $slice: -MAX_HISTORY } } }
      );
      // A new product in the history changes the recommendations; a repeated view barely does,
      // so the cache is kept in that case
      invalidateRecommendations(userId);
    }
  } catch (err) {
    console.error('trackView error:', err.message);
  }
}

// Called when a logged-in user rates a product (value: integer 1..5).
// Stores the rating in the user's history and keeps the product's rating_sum / rating_count
// in step, so the average is read from the product without scanning users.
// Returns the user's previous rating (or null).
async function trackRating(userId, product, value) {
  const snap = snapshot(product);
  const now = new Date();
  const pid = snap.product_id;

  const current = await User.findOne(
    { _id: userId, 'view_history.product_id': pid },
    { 'view_history.$': 1 }
  ).lean();
  const entry = current?.view_history?.[0];
  const previous = entry?.rating ?? null;

  let result;
  if (entry) {
    // Conditional on the old value: of two simultaneous requests only one is counted
    result = await User.updateOne(
      { _id: userId, view_history: { $elemMatch: { product_id: pid, rating: previous ?? { $exists: false } } } },
      { $set: { 'view_history.$.rating': value, 'view_history.$.ratedAt': now } }
    );
  } else {
    result = await User.updateOne(
      { _id: userId, 'view_history.product_id': { $ne: pid } },
      { $push: { view_history: { $each: [{ ...snap, rating: value, ratedAt: now, views: 0, lastViewed: now }], $slice: -MAX_HISTORY } } }
    );
  }
  if (result.modifiedCount === 0) return previous;   // lost a race with another request, nothing to count

  const inc = previous === null
    ? { rating_sum: value, rating_count: 1 }
    : { rating_sum: value - previous };
  await Product.updateOne({ product_id: pid }, { $inc: inc });
  invalidateRecommendations(userId);
  return previous;
}

// The current user's rating of one product (or null)
async function getUserRating(userId, productId) {
  if (!userId) return null;
  const doc = await User.findOne(
    { _id: userId, 'view_history.product_id': productId },
    { 'view_history.$': 1 }
  ).lean();
  return doc?.view_history?.[0]?.rating ?? null;
}

module.exports = { trackView, trackRating, getUserRating };