const User = require('../models/User');

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
    }
  } catch (err) {
    console.error('trackView error:', err.message);
  }
}

// Called when a logged-in user rates a product
async function trackRating(req, product, value) {
  const userId = req.session?.userId;
  if (!userId || req.session.userStatus === 'admin') return;
  try {
    const snap = snapshot(product);
    const result = await User.updateOne(
      { _id: userId, 'view_history.product_id': snap.product_id },
      { $set: { 'view_history.$.rating': value } }
    );
    if (result.matchedCount === 0) {
      await User.updateOne(
        { _id: userId },
        { $push: { view_history: { $each: [{ ...snap, rating: value, views: 0, lastViewed: new Date() }], $slice: -MAX_HISTORY } } }
      );
    }
  } catch (err) {
    console.error('trackRating error:', err.message);
  }
}

module.exports = { trackView, trackRating };