import jwt from 'jsonwebtoken';
import User from '../models/User.js';

// Verifies JWT from Authorization header OR httpOnly cookie
export const protect = async (req, res, next) => {
  try {
    let token;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) token = header.split(' ')[1];
    else if (req.cookies && req.cookies.sf_access) token = req.cookies.sf_access;

    if (!token) return res.status(401).json({ message: 'Not authorized, no token' });

    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    const user = await User.findById(decoded.id);
    if (!user) return res.status(401).json({ message: 'User no longer exists' });
    if (user.isSuspended) return res.status(403).json({ message: 'Account suspended' });

    // Any valid protected request is proof the member is currently using the app.
    // Logout explicitly flips this back to false.
    if (!user.isOnline) {
      user.isOnline = true;
      await User.updateOne({ _id: user._id }, { $set: { isOnline: true } });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Not authorized, token failed or expired' });
  }
};

// RBAC: roles allowed to access the route
export const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Not authorized' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: `Role '${req.user.role}' is not allowed to access this resource` });
    }
    next();
  };
};

// Admin = super-admin or content-manager
export const isAdmin = authorize('super-admin', 'content-manager');
// Super admin only
export const isSuperAdmin = authorize('super-admin');

// Optional auth: attaches user if token valid, continues as guest otherwise
export const optionalAuth = async (req, res, next) => {
  try {
    let token;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) token = header.split(' ')[1];
    else if (req.cookies && req.cookies.sf_access) token = req.cookies.sf_access;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      const user = await User.findById(decoded.id);
      if (user && !user.isSuspended) req.user = user;
    }
  } catch (_) { /* guest */ }
  next();
};
