import Genre from '../models/Genre.js';
import Season from '../models/Season.js';
import Episode from '../models/Episode.js';
import Title from '../models/Title.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import AdminActivityLog from '../models/AdminActivityLog.js';
import { logAdminAction } from '../middleware/activityLog.js';

// ---------- GENRES ----------
// @route GET /api/admin/genres
export const adminListGenres = async (req, res) => {
  const items = await Genre.find().sort({ order: 1 });
  res.json({ items });
};

// @route POST /api/admin/genres { name, order }
export const createGenre = async (req, res) => {
  try {
    const { name, order = 0 } = req.body;
    if (!name) return res.status(400).json({ message: 'Genre name required' });
    const slug = name.toString().toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-');
    const genre = await Genre.create({ name, slug, order, createdBy: req.user?._id, updatedBy: req.user?._id });
    await logAdminAction(req, 'CREATE_GENRE', 'genres', genre._id, name);
    res.status(201).json({ genre });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Genre already exists' });
    res.status(500).json({ message: 'Failed to create genre' });
  }
};

// Editable fields only — never copy the whole loaded document back over the live one
// (that would re-write stale createdAt/updatedAt/__v and any future server-managed key).
const GENRE_EDITABLE = ['name', 'order', 'isActive'];

const slugifyGenre = (s) => s.toString().toLowerCase().trim()
  .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

// @route PUT /api/admin/genres/:id
export const updateGenre = async (req, res) => {
  try {
    const src = req.body || {};
    const update = {};
    for (const key of GENRE_EDITABLE) {
      if (src[key] !== undefined) update[key] = src[key];
    }
    if (!Object.keys(update).length) return res.status(400).json({ message: 'No valid fields to update' });

    // Renaming must refresh the public slug too (Genre.slug is unique + required)
    if (update.name !== undefined) {
      const slug = slugifyGenre(update.name);
      if (slug) update.slug = slug;
    }

    update.updatedBy = req.user?._id; // governance: record who last edited this genre
    const genre = await Genre.findByIdAndUpdate(req.params.id, { $set: update }, { new: true, runValidators: true });
    if (!genre) return res.status(404).json({ message: 'Genre not found' });
    await logAdminAction(req, 'UPDATE_GENRE', 'genres', genre._id, genre.name);
    res.json({ genre });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Another genre already uses that name' });
    console.error('updateGenre:', err);
    res.status(500).json({ message: 'Failed to update genre', detail: err.message });
  }
};

// @route PUT /api/admin/genres/reorder { order: [genreId, ...] } — SRS §6.4 homepage row order
export const reorderGenres = async (req, res) => {
  try {
    const { order } = req.body || {};
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ message: 'order array of genre ids is required' });
    if (order.length > 200) return res.status(400).json({ message: 'Too many genres in one reorder' });
    const ops = order.map((id, i) => ({
      updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } },
    }));
    await Genre.bulkWrite(ops);
    const items = await Genre.find().sort({ order: 1 });
    await logAdminAction(req, 'REORDER_GENRES', 'genres', '', `${order.length} genres reordered`);
    res.json({ items });
  } catch (err) {
    console.error('reorderGenres:', err);
    res.status(500).json({ message: 'Reorder failed' });
  }
};

// @route DELETE /api/admin/genres/:id
export const deleteGenre = async (req, res) => {
  try {
    const genre = await Genre.findByIdAndDelete(req.params.id);
    if (!genre) return res.status(404).json({ message: 'Genre not found' });
    await Title.updateMany({ genres: genre._id }, { $pull: { genres: genre._id } });
    await logAdminAction(req, 'DELETE_GENRE', 'genres', genre._id, genre.name);
    res.json({ message: 'Genre deleted and removed from titles' });
  } catch {
    res.status(500).json({ message: 'Failed to delete genre' });
  }
};
