import mongoose from 'mongoose';
import SiteSettings from '../models/SiteSettings.js';
import { logAdminAction } from '../middleware/activityLog.js';

// @route GET /api/admin/settings
export const getSettings = async (req, res) => {
  try {
    let s = await SiteSettings.findOne();
    if (!s) s = await SiteSettings.create({});
    res.json({ settings: s });
  } catch (err) {
    console.error('getSettings:', err);
    res.status(500).json({ message: 'Failed to load settings' });
  }
};

const CLEAN = (v) => (typeof v === 'string' ? v.trim() : '');
const HEX = /^#[0-9a-fA-F]{3,8}$/;

// @route PUT /api/admin/settings — super-admin only (SRS §3 role table)
export const updateSettings = async (req, res) => {
  try {
    const s = (await SiteSettings.findOne()) || (await SiteSettings.create({}));
    const b = req.body || {};
    if (b.siteName !== undefined) s.siteName = (CLEAN(b.siteName).slice(0, 60) || 'Newflix');
    if (b.logoUrl !== undefined) s.logoUrl = CLEAN(b.logoUrl).slice(0, 500);
    if (b.faviconUrl !== undefined) s.faviconUrl = CLEAN(b.faviconUrl).slice(0, 500);
    if (b.accentColor !== undefined && HEX.test(String(b.accentColor).trim())) s.accentColor = String(b.accentColor).trim();
    if (b.metaTitle !== undefined) s.metaTitle = CLEAN(b.metaTitle).slice(0, 120);
    if (b.metaDescription !== undefined) s.metaDescription = CLEAN(b.metaDescription).slice(0, 300);
    if (b.guestCanBrowse !== undefined) s.guestCanBrowse = !!b.guestCanBrowse;
    if (b.socialLinks && typeof b.socialLinks === 'object') {
      for (const k of ['facebook', 'twitter', 'instagram', 'youtube']) {
        if (b.socialLinks[k] !== undefined) s.socialLinks[k] = CLEAN(b.socialLinks[k]).slice(0, 300);
      }
    }
    if (Array.isArray(b.staticPages)) {
      s.staticPages = b.staticPages
        .filter((p) => p && typeof p.slug === 'string' && p.slug.trim())
        .slice(0, 20)
        .map((p) => ({
          slug: p.slug.toLowerCase().trim().replace(/[^a-z0-9-]/g, ''),
          title: CLEAN(p.title).slice(0, 120),
          content: typeof p.content === 'string' ? p.content.slice(0, 20000) : '',
        }));
    }
    if (Array.isArray(b.customRows)) {
      s.customRows = b.customRows
        .filter((r) => r && typeof r.title === 'string' && r.title.trim())
        .slice(0, 10)
        .map((r) => ({
          title: CLEAN(r.title).slice(0, 60),
          titleIds: Array.isArray(r.titleIds)
            ? r.titleIds.filter((x) => mongoose.Types.ObjectId.isValid(String(x))).slice(0, 30)
            : [],
        }));
    }
    await s.save();
    await logAdminAction(req, 'UPDATE_SETTINGS', 'settings', s._id, 'Site settings updated');
    res.json({ settings: s });
  } catch (err) {
    console.error('updateSettings:', err);
    res.status(500).json({ message: 'Failed to update settings' });
  }
};

// @route GET /api/settings — public: powers the user frontend (branding, socials, static pages)
export const getPublicSettings = async (req, res) => {
  try {
    const s = await SiteSettings.findOne().select(
      'siteName logoUrl faviconUrl accentColor metaTitle metaDescription socialLinks staticPages guestCanBrowse'
    );
    res.json({ settings: s || {} });
  } catch (err) {
    console.error('getPublicSettings:', err);
    res.status(500).json({ message: 'Failed to load settings' });
  }
};