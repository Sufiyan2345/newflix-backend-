import Rating from '../models/Rating.js';
import Title from '../models/Title.js';

// @route GET /api/titles/:id/rating — current profile's rating status
export const getTitleRating = async (req, res) => {
  try {
    if (!req.profileId) return res.status(400).json({ message: 'Select a profile first' });
    const title = await Title.findById(req.params.id).select('_id status');
    if (!title || title.status !== 'published') return res.status(404).json({ message: 'Title not found' });
    const rating = await Rating.findOne({ title: title._id, profile: req.profileId }).select('rating');
    res.json({ yourRating: rating?.rating ?? null });
  } catch (err) {
    console.error('getTitleRating:', err);
    res.status(500).json({ message: 'Failed to load rating' });
  }
};

// @route POST /api/titles/:id/rate { rating: 1..10 } — user rating (SRS §4.5 / §6.9)
export const rateTitle = async (req, res) => {
  try {
    const r = Number(req.body?.rating);
    if (!Number.isFinite(r) || r < 1 || r > 10) return res.status(400).json({ message: 'Rating must be between 1 and 10' });
    if (!req.profileId) return res.status(400).json({ message: 'Select a profile first' });

    const title = await Title.findById(req.params.id).select('_id status');
    if (!title || title.status !== 'published') return res.status(404).json({ message: 'Title not found' });

    await Rating.findOneAndUpdate(
      { title: title._id, profile: req.profileId },
      { rating: r },
      { upsert: true }
    );
    const agg = await Rating.aggregate([
      { $match: { title: title._id } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const avgRating = Math.round((agg[0]?.avg || 0) * 10) / 10;
    const ratingCount = agg[0]?.count || 0;
    // Real "match" signal derived from community ratings (was a static 96).
    const matchPercentage = avgRating > 0 ? Math.round(avgRating * 10) : 0;
    await Title.updateOne({ _id: title._id }, { avgRating, ratingCount, matchPercentage });

    res.json({ yourRating: r, avgRating, ratingCount });
  } catch (err) {
    console.error('rateTitle:', err);
    res.status(500).json({ message: 'Failed to save rating' });
  }
};

// @route DELETE /api/titles/:id/rate — remove this profile's rating.
// Makes the "I like this" toggle reversible instead of a one-way action.
export const unrateTitle = async (req, res) => {
  try {
    if (!req.profileId) return res.status(400).json({ message: 'Select a profile first' });
    const title = await Title.findById(req.params.id).select('_id status');
    if (!title || title.status !== 'published') return res.status(404).json({ message: 'Title not found' });

    await Rating.deleteOne({ title: title._id, profile: req.profileId });

    const agg = await Rating.aggregate([
      { $match: { title: title._id } },
      { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
    ]);
    const avgRating = Math.round((agg[0]?.avg || 0) * 10) / 10;
    const ratingCount = agg[0]?.count || 0;
    // Real "match" signal derived from community ratings (was a static 96).
    const matchPercentage = avgRating > 0 ? Math.round(avgRating * 10) : 0;
    await Title.updateOne({ _id: title._id }, { avgRating, ratingCount, matchPercentage });

    res.json({ yourRating: null, avgRating, ratingCount });
  } catch (err) {
    console.error('unrateTitle:', err);
    res.status(500).json({ message: 'Failed to remove rating' });
  }
};