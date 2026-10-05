import Rating from '../models/Rating.js';
import Title from '../models/Title.js';
import { logAdminAction } from '../middleware/activityLog.js';

// ---------- RATINGS MODERATION (SRS §6.9) ----------
// @route GET /api/admin/ratings?page=
export const listRatings = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const [items, total] = await Promise.all([
      Rating.find().sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit))
        .populate('title', 'title posterUrl avgRating ratingCount')
        .populate('profile', 'name'),
      Rating.countDocuments(),
    ]);
    res.json({ items: items.filter((r) => r.title && r.profile), total, pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error('listRatings:', err);
    res.status(500).json({ message: 'Failed to load ratings' });
  }
};

// @route DELETE /api/admin/ratings/:id — remove an abusive/incorrect rating
export const deleteRating = async (req, res) => {
  try {
    const rating = await Rating.findByIdAndDelete(req.params.id);
    if (!rating) return res.status(404).json({ message: 'Rating not found' });
    // Recompute the title average after removal
    const agg = await Rating.aggregate([{ $match: { title: rating.title } }, { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }]);
    const avgRating = Math.round((agg[0]?.avg || 0) * 10) / 10;
    const matchPercentage = avgRating > 0 ? Math.round(avgRating * 10) : 0;
    await Title.updateOne({ _id: rating.title }, { avgRating, ratingCount: agg[0]?.count || 0, matchPercentage });
    await logAdminAction(req, 'DELETE_RATING', 'ratings', rating._id, `rating ${rating.rating}/10 removed`);
    res.json({ message: 'Rating removed', avgRating, ratingCount: agg[0]?.count || 0 });
  } catch (err) {
    console.error('deleteRating:', err);
    res.status(500).json({ message: 'Failed to remove rating' });
  }
};