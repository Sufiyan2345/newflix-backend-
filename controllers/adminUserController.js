import User from '../models/User.js';
import Profile from '../models/Profile.js';
import WatchHistory from '../models/WatchHistory.js';
import AdminActivityLog from '../models/AdminActivityLog.js';
import crypto from 'crypto';
import { logAdminAction } from '../middleware/activityLog.js';

// @route GET /api/admin/users?q=&page= (super-admin only for full list, content-manager read-only)
export const listUsers = async (req, res) => {
  try {
    const { q, page = 1, limit = 20, role } = req.query;
    const filter = {};
    if (q) filter.$or = [
      { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      { email: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
    ];
    if (role) filter.role = role;
    const select = '-password -loginAttempts -lockUntil';
    const [items, total, profileCounts, watchCounts] = await Promise.all([
      User.find(filter).select(select).sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit)),
      User.countDocuments(filter),
      // SRS §6.7 — profile count + watch activity per user
      Profile.aggregate([{ $group: { _id: '$user', count: { $sum: 1 } } }]),
      WatchHistory.aggregate([
        { $lookup: { from: 'profiles', localField: 'profile', foreignField: '_id', as: 'p' } },
        { $unwind: '$p' },
        { $group: { _id: '$p.user', watches: { $sum: 1 } } },
      ]),
    ]);
    const pMap = new Map(profileCounts.map((p) => [String(p._id), p.count]));
    const wMap = new Map(watchCounts.map((w) => [String(w._id), w.watches]));
    const enriched = items.map((u) => ({
      ...u.toObject(),
      profilesCount: pMap.get(String(u._id)) || 0,
      watchActivity: wMap.get(String(u._id)) || 0,
    }));
    res.json({ items: enriched, total, pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    console.error('listUsers:', err);
    res.status(500).json({ message: 'Failed to list users' });
  }
};

// @route POST /api/admin/users/create-admin { name, email, password, role } — SRS §6.8
export const createAdmin = async (req, res) => {
  try {
    const { name, email, password, role = 'content-manager' } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: 'Name, email and password are required' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });
    if (!['content-manager', 'super-admin'].includes(role)) return res.status(400).json({ message: 'Invalid role' });
    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) return res.status(409).json({ message: 'An account with this email already exists' });
    const user = await User.create({ name, email, password, role, isEmailVerified: true });
    await logAdminAction(req, 'CREATE_ADMIN', 'users', user._id, `${user.email} as ${role}`);
    res.status(201).json({ user: { id: user._id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('createAdmin:', err);
    res.status(500).json({ message: 'Failed to create admin account' });
  }
};

// @route GET /api/admin/users/:id — user detail + profiles
export const getUserDetail = async (req, res) => {
  const user = await User.findById(req.params.id).select('-password -loginAttempts -lockUntil');
  if (!user) return res.status(404).json({ message: 'User not found' });
  const profiles = await Profile.find({ user: user._id });
  res.json({ user, profiles });
};

// @route PUT /api/admin/users/:id/suspend { isSuspended, reason } (super-admin)
export const suspendUser = async (req, res) => {
  try {
    const { isSuspended, reason = '' } = req.body;
    if (String(req.params.id) === String(req.user._id))
      return res.status(400).json({ message: 'You cannot suspend your own account' });
    const user = await User.findByIdAndUpdate(req.params.id,
      { isSuspended: !!isSuspended, suspendedReason: isSuspended ? reason : '' },
      { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    await logAdminAction(req, isSuspended ? 'SUSPEND_USER' : 'UNSUSPEND_USER', 'users', user._id, reason);
    res.json({ user });
  } catch {
    res.status(500).json({ message: 'Failed to update user' });
  }
};

// @route PUT /api/admin/users/:id/role { role } (super-admin)
export const changeUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'content-manager', 'super-admin'].includes(role))
      return res.status(400).json({ message: 'Invalid role' });
    if (String(req.params.id) === String(req.user._id))
      return res.status(400).json({ message: 'You cannot change your own role' });
    const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    await logAdminAction(req, 'CHANGE_ROLE', 'users', user._id, `role -> ${role}`);
    res.json({ user });
  } catch {
    res.status(500).json({ message: 'Failed to change role' });
  }
};

// @route DELETE /api/admin/users/:id (super-admin)
export const deleteUser = async (req, res) => {
  try {
    if (String(req.params.id) === String(req.user._id))
      return res.status(400).json({ message: 'You cannot delete your own account' });
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const profiles = await Profile.find({ user: user._id });
    await Profile.deleteMany({ user: user._id });
    await logAdminAction(req, 'DELETE_USER', 'users', user._id, `${user.email} (${profiles.length} profiles)`);
    res.json({ message: 'User deleted' });
  } catch {
    res.status(500).json({ message: 'Failed to delete user' });
  }
};

// @route PUT /api/admin/users/:id/reset-password { } (super-admin) — SRS §6.7
export const adminResetPassword = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    const tempPassword = `Sf-${crypto.randomInt(100000, 999999)}${crypto.randomInt(100000, 999999)}`;
    user.password = tempPassword; // hashed by pre-save hook
    user.loginAttempts = 0;
    user.lockUntil = null;
    await user.save();
    await logAdminAction(req, 'RESET_USER_PASSWORD', 'users', user._id, user.email);
    // Temp password is returned exactly once over HTTPS — never stored in plain text
    res.json({ message: `Password reset for ${user.email}`, tempPassword });
  } catch {
    res.status(500).json({ message: 'Failed to reset password' });
  }
};

// @route GET /api/admin/activity-log (super-admin)
export const activityLog = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const [items, total] = await Promise.all([
      AdminActivityLog.find().sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit)).limit(Number(limit))
        .populate('admin', 'name email role'),
      AdminActivityLog.countDocuments(),
    ]);
    res.json({ items, total, pages: Math.ceil(total / Number(limit)) });
  } catch {
    res.status(500).json({ message: 'Failed to load activity log' });
  }
};
