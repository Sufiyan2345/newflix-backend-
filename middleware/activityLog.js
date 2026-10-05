import AdminActivityLog from '../models/AdminActivityLog.js';

// Log every admin action for accountability (SRS §12)
export const logAdminAction = async (req, action, targetTable = '', targetId = '', details = '') => {
  try {
    await AdminActivityLog.create({
      admin: req.user?._id,
      adminEmail: req.user?.email || '',
      action,
      targetTable,
      targetId: String(targetId || ''),
      details: typeof details === 'object' ? JSON.stringify(details).slice(0, 2000) : String(details).slice(0, 2000),
      ip: req.ip || '',
    });
  } catch (err) {
    console.error('Activity log failed:', err.message);
  }
};
