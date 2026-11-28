const express = require('express');
const config = require('../config');
const { getDb } = require('../db/database');
const { verifyPassword, signSessionToken } = require('../utils/security');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const db = getDb();
  const user = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(String(username).trim());

  if (!user || !user.is_active || !verifyPassword(String(password), user.password_hash)) {
    logAudit(
      {
        action: 'LOGIN_FAILED',
        entityType: 'auth',
        entityId: String(username).trim(),
        ipAddress: req.ip,
      },
      db
    );
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signSessionToken({ userId: user.id, role: user.role });
  res.cookie(config.sessionCookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionTtlMs,
    path: '/',
  });

  logAudit(
    {
      user: { id: user.id, username: user.username },
      action: 'LOGIN_SUCCESS',
      entityType: 'auth',
      entityId: user.id,
      ipAddress: req.ip,
    },
    db
  );

  return res.json({
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      daily_target: user.daily_target,
    },
  });
});

router.post('/logout', (req, res) => {
  if (req.user) {
    logAudit(
      {
        user: req.user,
        action: 'LOGOUT',
        entityType: 'auth',
        entityId: req.user.id,
        ipAddress: req.ip,
      },
      getDb()
    );
  }
  res.clearCookie(config.sessionCookieName, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
