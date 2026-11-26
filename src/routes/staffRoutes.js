const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { ROLES } = require('../constants');
const { hashPassword } = require('../utils/security');
const { getStaffPerformance } = require('../services/reportService');
const { assignStudents } = require('../services/callWorkflowService');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.use(requireAuth);

router.get('/performance', (req, res) => {
  const rows = getStaffPerformance(req.user, getDb());
  res.json({ staff: rows });
});

router.post('/', requireRole(ROLES.ADMIN), (req, res) => {
  const { username, password, fullName, email, phone, role = ROLES.CALLING_STAFF, dailyTarget = 30 } = req.body || {};
  if (!username || !password || !fullName || !email) {
    return res.status(400).json({ error: 'username, password, fullName, and email are required' });
  }
  if (!Object.values(ROLES).includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const db = getDb();
  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, full_name, email, phone, role, daily_target)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(username).trim(),
        hashPassword(String(password)),
        String(fullName).trim(),
        String(email).trim(),
        phone || null,
        role,
        Number(dailyTarget || 30)
      );

    logAudit(
      {
        user: req.user,
        action: 'STAFF_CREATED',
        entityType: 'user',
        entityId: Number(info.lastInsertRowid),
        details: { username, role, dailyTarget },
      },
      db
    );
    res.status(201).json({ id: Number(info.lastInsertRowid) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/target', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const { dailyTarget, isActive } = req.body || {};
  const db = getDb();
  const targetId = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!existing) return res.status(404).json({ error: 'Staff member not found' });

  db.prepare(
    `UPDATE users
     SET daily_target = COALESCE(?, daily_target),
         is_active = COALESCE(?, is_active),
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    dailyTarget !== undefined ? Number(dailyTarget) : null,
    isActive !== undefined ? (isActive ? 1 : 0) : null,
    targetId
  );

  logAudit(
    {
      user: req.user,
      action: 'STAFF_TARGET_UPDATED',
      entityType: 'user',
      entityId: targetId,
      details: { dailyTarget, isActive },
    },
    db
  );

  res.json({ ok: true });
});

router.post('/reassign-pending', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const { fromStaffId, toStaffId } = req.body || {};
  if (!fromStaffId || !toStaffId) {
    return res.status(400).json({ error: 'fromStaffId and toStaffId are required' });
  }
  const db = getDb();
  const pendingIds = db
    .prepare(
      `SELECT id FROM students
       WHERE assigned_staff_id = ?
         AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')`
    )
    .all(Number(fromStaffId))
    .map((r) => r.id);

  if (pendingIds.length === 0) {
    return res.json({ updatedCount: 0, message: 'No pending students to reassign' });
  }

  const result = assignStudents({ studentIds: pendingIds, staffId: Number(toStaffId), assignedByUser: req.user }, db);
  res.json(result);
});

module.exports = router;
