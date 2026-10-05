import mongoose from 'mongoose';
import WatchHistory from '../models/WatchHistory.js';
import Title from '../models/Title.js';

const RANGE_DAYS = { today: 1, week: 7, month: 30 };

// @route GET /api/admin/analytics/top-titles?range=today|week|month|all&limit=10 (SRS §6.11)
export const topTitles = async (req, res) => {
  try {
    const { range = 'all', limit = 10 } = req.query;
    const lim = Math.min(Number(limit) || 10, 50);
    const match = RANGE_DAYS[range] ? { lastWatchedAt: { $gte: new Date(Date.now() - RANGE_DAYS[range] * 86400000) } } : {};

    const [agg, totals, devices, browsers] = await Promise.all([
      WatchHistory.aggregate([
        { $match: match },
        { $group: {
          _id: '$title',
          watches: { $sum: 1 },
          watchSeconds: { $sum: '$progressSeconds' },
          durations: { $sum: '$durationSeconds' },
        } },
        { $sort: { watches: -1 } },
        { $limit: lim },
        { $lookup: { from: 'titles', localField: '_id', foreignField: '_id', as: 'title' } },
        { $unwind: '$title' },
        { $project: {
          _id: 0,
          id: '$title._id', title: '$title.title', type: '$title.type', posterUrl: '$title.posterUrl',
          viewCount: '$title.viewCount', watches: 1,
          watchMinutes: { $round: [{ $divide: ['$watchSeconds', 60] }, 0] },
          completionRate: { $cond: [
            { $gt: ['$durations', 0] },
            { $round: [{ $multiply: [{ $divide: ['$watchSeconds', '$durations'] }, 100] }, 0] },
            0,
          ] },
        } },
      ]),
      WatchHistory.aggregate([
        { $match: match },
        { $group: { _id: null, watchSeconds: { $sum: '$progressSeconds' }, sessions: { $sum: 1 }, durations: { $sum: '$durationSeconds' } } },
      ]),
      WatchHistory.aggregate([{ $match: match }, { $group: { _id: '$device', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      WatchHistory.aggregate([{ $match: match }, { $group: { _id: '$browser', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
    ]);

    const t = totals[0] || {};
    res.json({
      range,
      items: agg,
      totals: {
        sessions: t.sessions || 0,
        watchHours: Math.round(((t.watchSeconds || 0) / 3600) * 10) / 10, // total watch-time (SRS §6.11)
        completionRate: t.durations > 0 ? Math.round(((t.watchSeconds || 0) / t.durations) * 100) : 0,
      },
      devices: devices.map((d) => ({ key: d._id || 'unknown', count: d.count })).filter((d) => d.key !== 'unknown'),
      browsers: browsers.map((b) => ({ key: b._id || 'unknown', count: b.count })).filter((b) => b.key !== 'unknown'),
    });
  } catch (err) {
    console.error('analyticsTopTitles:', err);
    res.status(500).json({ message: 'Analytics failed' });
  }
};

// @route GET /api/admin/analytics/export?range=week — CSV report download (SRS §6.11)
export const exportCsv = async (req, res) => {
  try {
    const { range = 'all' } = req.query;
    const match = RANGE_DAYS[range] ? { lastWatchedAt: { $gte: new Date(Date.now() - RANGE_DAYS[range] * 86400000) } } : {};
    const agg = await WatchHistory.aggregate([
      { $match: match },
      { $group: { _id: '$title', watches: { $sum: 1 }, watchSeconds: { $sum: '$progressSeconds' }, durations: { $sum: '$durationSeconds' } } },
      { $sort: { watches: -1 } }, { $limit: 200 },
      { $lookup: { from: 'titles', localField: '_id', foreignField: '_id', as: 'title' } },
      { $unwind: '$title' },
    ]);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['rank', 'title', 'type', 'totalViews', 'watchSessions', 'watchTimeMinutes', 'completionRatePercent'].join(',')];
    agg.forEach((r, i) => {
      lines.push([
        i + 1, esc(r.title.title), esc(r.title.type), esc(r.title.viewCount),
        r.watches, Math.round(r.watchSeconds / 60),
        r.durations > 0 ? Math.round((r.watchSeconds / r.durations) * 100) : 0,
      ].join(','));
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="streamflix-report-${range}.csv"`);
    res.send(lines.join('\n'));
  } catch (err) {
    console.error('exportCsv:', err);
    res.status(500).json({ message: 'Export failed' });
  }
};