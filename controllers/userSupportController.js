import PlaybackReport from '../models/PlaybackReport.js';
import Title from '../models/Title.js';

// Categories the player's "Report a problem" form offers. Mirrors the enum on the
// model so an invalid value can never reach Mongo.
const CATEGORIES = ['playback', 'video', 'audio', 'subtitles', 'buffering', 'other'];

// Short, human-readable ticket id derived from the Mongo _id — shown back to the
// viewer ("PB-4F19A2") so support can pull up the exact report.
export const ticketId = (id) => `PB-${String(id).slice(-6).toUpperCase()}`;

// Same lightweight UA sniffing the watch-history endpoint uses (SRS §6.11 breakdown)
const requestMeta = (req) => {
  const ua = req.headers['user-agent'] || '';
  const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobile|android|iphone/i.test(ua) ? 'Mobile' : 'Desktop';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : 'Other';
  return { device, browser };
};

// @route POST /api/user/report-problem
// { titleId, episodeId?, category, message, progressSeconds, durationSeconds }
export const reportProblem = async (req, res) => {
  try {
    const {
      titleId, episodeId = null, category = 'playback', message = '',
      progressSeconds = 0, durationSeconds = 0,
    } = req.body || {};

    const text = String(message).trim();
    if (!titleId) return res.status(400).json({ message: 'titleId is required' });
    if (text.length < 5) return res.status(400).json({ message: 'Please describe the problem (at least 5 characters).' });

    const title = await Title.findById(titleId).select('title');
    if (!title) return res.status(404).json({ message: 'Title not found' });

    const report = await PlaybackReport.create({
      user: req.user._id,
      profile: req.profileId || null,
      title: title._id,
      episode: episodeId || null,
      category: CATEGORIES.includes(category) ? category : 'other',
      message: text.slice(0, 1000),
      progressSeconds: Math.max(0, Math.floor(Number(progressSeconds) || 0)),
      durationSeconds: Math.max(0, Math.floor(Number(durationSeconds) || 0)),
      ...requestMeta(req),
    });

    res.status(201).json({
      ticketId: ticketId(report._id),
      message: 'Thanks — our team will look into it.',
      report: { id: report._id, status: report.status, category: report.category, createdAt: report.createdAt },
    });
  } catch (err) {
    console.error('reportProblem:', err);
    res.status(500).json({ message: 'Could not send your report. Please try again.' });
  }
};

// @route GET /api/user/reports — reports this account filed (shown in account/help)
export const myReports = async (req, res) => {
  try {
    const items = await PlaybackReport.find({ user: req.user._id })
      .sort({ createdAt: -1 }).limit(50).populate('title', 'title slug');
    res.json({
      items: items.map((r) => ({
        id: r._id,
        ticketId: ticketId(r._id),
        title: r.title?.title || 'Unknown title',
        category: r.category,
        message: r.message,
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error('myReports:', err);
    res.status(500).json({ message: 'Failed to load your reports' });
  }
};