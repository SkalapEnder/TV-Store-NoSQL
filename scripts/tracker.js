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

// Called when a logged-in user rates a product (value: integer 1..5, review: optional text).
// Stores the rating and the review in the user's history entry of that product and keeps the
// product's rating_sum / rating_count in step, so the average is read from the product without
// scanning users. An empty review removes the previous text. Returns the previous rating (or null).
async function trackRating(userId, product, value, review = "") {
  const snap = snapshot(product);
  const now = new Date();
  const pid = snap.product_id;
  const text = String(review || "").trim().slice(0, 1000);
  const reviewUpdate = text ? { $set: { 'view_history.$.review': text } } : { $unset: { 'view_history.$.review': "" } };

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
      { $set: { 'view_history.$.rating': value, 'view_history.$.ratedAt': now, ...reviewUpdate.$set }, ...(reviewUpdate.$unset ? { $unset: reviewUpdate.$unset } : {}) }
    );
  } else {
    result = await User.updateOne(
      { _id: userId, 'view_history.product_id': { $ne: pid } },
      { $push: { view_history: { $each: [{ ...snap, rating: value, ...(text ? { review: text } : {}), ratedAt: now, views: 0, lastViewed: now }], $slice: -MAX_HISTORY } } }
    );
  }
  if (result.modifiedCount === 0) return previous;   // lost a race (or nothing changed), nothing to count

  if (previous === value) { invalidateRecommendations(userId); return previous; }   // only the text changed
  const inc = previous === null
    ? { rating_sum: value, rating_count: 1 }
    : { rating_sum: value - previous };
  await Product.updateOne({ product_id: pid }, { $inc: inc });
  invalidateRecommendations(userId);
  return previous;
}

// The current user's rating and review of one product: { rating, review } (rating null if none)
async function getUserRating(userId, productId) {
  if (!userId) return { rating: null, review: "" };
  const doc = await User.findOne(
    { _id: userId, 'view_history.product_id': productId },
    { 'view_history.$': 1 }
  ).lean();
  const entry = doc?.view_history?.[0];
  return { rating: entry?.rating ?? null, review: entry?.review || "" };
}

// Reviews of a product, newest first: the rating entries with text from all users' histories.
// The $elemMatch on view_history.product_id uses the multikey index; "verified" = the reviewer
// also has the product in purchase_history.
async function getProductReviews(productId, { limit = 10 } = {}) {
  const match = { view_history: { $elemMatch: { product_id: productId, review: { $exists: true, $ne: "" } } } };
  const [items, total] = await Promise.all([
    User.aggregate([
      { $match: match },
      { $project: {
          username: 1,
          entry: { $first: { $filter: { input: "$view_history", cond: { $eq: ["$$this.product_id", productId] } } } },
          verified: { $in: [productId, { $ifNull: ["$purchase_history.product_id", []] }] }
      } },
      { $sort: { "entry.ratedAt": -1 } },
      { $limit: limit },
      { $project: { _id: 0, username: 1, verified: 1, rating: "$entry.rating", review: "$entry.review", date: "$entry.ratedAt" } }
    ]),
    User.countDocuments(match)
  ]);
  return { items, total };
}

module.exports = { trackView, trackRating, getUserRating, getProductReviews };