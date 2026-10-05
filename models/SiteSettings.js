import mongoose from 'mongoose';

const siteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: 'global' },
    siteName: { type: String, default: 'Newflix' },
    logoUrl: { type: String, default: '' },
    faviconUrl: { type: String, default: '' },
    accentColor: { type: String, default: '#E50914' },
    metaTitle: { type: String, default: 'Newflix - Watch Movies, Dramas & Web Series' },
    metaDescription: { type: String, default: 'Unlimited movies, dramas and web series. Stream anywhere. Cancel anytime.' },
    socialLinks: {
      facebook: { type: String, default: '' },
      twitter: { type: String, default: '' },
      instagram: { type: String, default: '' },
      youtube: { type: String, default: '' },
    },
    staticPages: [
      {
        slug: { type: String, required: true }, // 'about', 'contact', 'privacy', 'terms'
        title: { type: String, default: '' },
        content: { type: String, default: '' },
      },
    ],
    guestCanBrowse: { type: Boolean, default: true },
    // §6.5 custom homepage rows with manually pinned titles
    customRows: [{
      title: { type: String, default: '' },
      titleIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Title' }],
    }],
  },
  { timestamps: true }
);

export default mongoose.model('SiteSettings', siteSettingsSchema);
