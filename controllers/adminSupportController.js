import PlaybackReport from '../models/PlaybackReport.js';
import { ticketId } from './userSupportController.js';

// Support-ticket queue for the reports the player's "Report a problem" form creates
// (SRS §24 "Admin 32 - Support Tickets": queue, priority, status, resolution).
const shape = (r) => ({
  id: r._id,
  ticketId: ticketId(r._id),
  user: r.user ? { id: r.user._id, name: r.user.name, email: r.user.email } : null,
  profile: r.profile ? { id: r.profile._id, name: r.profile.name } : null,
  title: r.title ? { id: r.title._id, title: r.title.title, slug: r.title.slug } : null,
  episode: r.episode ? { id: r.episode._id, episodeNumber: r.episode.episodeNumber, title: r.episode.title } : null,
  category: r.category,
  message: r.message,
  positionSeconds: r.progressSeconds,
  durationSeconds: r.durationSeconds,
  device: r.device,
  browser: r.browser,
  status: r.status,
  createdAt: r.createdAt,
});

// @route GET /api/admin/reports?status=open&category=playback&limit=50
export const listPlaybackReports = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.category) filter.category = req.query.category;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

    const [items, total, open] = await Promise.all([
      PlaybackReport.find(filter).sort({ createdAt: -1 }).limit(limit)
        .populate('user', 'name email').populate('profile', 'name')
        .populate('title', 'title slug').populate('episode', 'episodeNumber title'),
      PlaybackReport.countDocuments(filter),
      PlaybackReport.countDocuments({ status: 'open' }),
    ]);
    res.json({ items: items.map(shape), total, open });
  } catch (err) {
    console.error('listPlaybackReports:', err);
    res.status(500).json({ message: 'Failed to load reports' });
  }
};

// @route PUT /api/admin/reports/:id/status { status }
export const updatePlaybackReportStatus = async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['open', 'reviewing', 'resolved'].includes(status)) {
      return res.status(400).json({ message: 'status must be open, reviewing or resolved' });
    }
    const report = await PlaybackReport.findByIdAndUpdate(req.params.id, { status }, { new: true });
    if (!report) return res.status(404).json({ message: 'Report not found' });
    res.json({ id: report._id, ticketId: ticketId(report._id), status: report.status });
  } catch (err) {
    console.error('updatePlaybackReportStatus:', err);
    res.status(500).json({ message: 'Failed to update the report' });
  }
};