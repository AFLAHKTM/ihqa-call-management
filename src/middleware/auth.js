const config = require('../config');
const { getDb } = require('../db/database');
const { parseCookies, verifySessionToken } = require('../utils/security');

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : null;
  const token = bearer || cookies[config.sessionCookieName];
  const payload = verifySessionToken(token);

  if (!payload || !payload.userId) {
    return res.status(401).json({ error: 'Authentication required. Student contact records are restricted to authorised staff.' });
  }

  const db = getDb();
  let user = db
    .prepare('SELECT id, username, full_name, email, phone, role, daily_target, is_active FROM users WHERE id = ?')
    .get(payload.userId);
  if (!user && payload.username) {
    user = db
      .prepare('SELECT id, username, full_name, email, phone, role, daily_target, is_active FROM users WHERE username = ?')
      .get(payload.username);
  }

  if (!user || !user.is_active) {
    return res.status(401).json({ error: 'Account inactive or invalid session' });
  }

  req.user = user;
  next();
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}`,
      });
    }
    next();
  };
}

module.exports = {
  requireAuth,
  requireRole,
};
