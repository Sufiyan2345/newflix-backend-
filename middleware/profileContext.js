import Profile from '../models/Profile.js';

// Resolves the active profile. `profileId` can come from the header (the SPA
// sends `x-profile-id`) or the query/body.
//
// The whole profile document is attached as `req.profile`, not just its id:
// maturity filtering (see utils/maturity.js) needs `isKidsProfile` and
// `maturityLimit`, and re-querying per controller was how the Kids profile ended
// up unenforced.
export const profileContext = async (req, res, next) => {
  try {
    if (!req.user) return next();
    const pid = req.headers['x-profile-id'] || req.query.profileId || req.body?.profileId;
    if (pid) {
      const profile = await Profile.findOne({ _id: pid, user: req.user._id })
        .select('name isKidsProfile maturityLimit language avatarUrl avatarColor autoplayNext')
        .lean();
      if (profile) {
        req.profile = profile;
        req.profileId = profile._id;
      }
    }
  } catch { /* ignore */ }
  next();
};
