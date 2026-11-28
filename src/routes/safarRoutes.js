const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { ROLES } = require('../constants');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDb();
  const { search = '', safarDay = '', status = '', staffId = '' } = req.query;

  const where = [];
  const params = [];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('k.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    where.push('k.assigned_staff_id = ?');
    params.push(Number(staffId));
  }

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      '(k.campus_name LIKE ? OR k.place LIKE ? OR k.safar_day LIKE ? OR k.contact_person LIKE ? OR k.contact_number LIKE ? OR k.contact_person_2 LIKE ? OR k.contact_number_2 LIKE ?)'
    );
    params.push(q, q, q, q, q, q, q);
  }

  if (safarDay) {
    where.push('k.safar_day = ?');
    params.push(safarDay);
  }

  if (status) {
    if (status === 'PENDING_ALL') {
      where.push("k.communication_status IN ('Pending First Call', 'Not Connected / Retrying', 'Callback Scheduled')");
    } else if (status === 'UNATTENDED') {
      where.push("k.valid_attempt_count > 0 AND k.communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')");
    } else if (status === 'CALLS_MADE') {
      where.push("(k.valid_attempt_count > 0 OR k.communication_status IN ('Successfully Contacted', 'Follow-up Completed'))");
    } else {
      where.push('k.communication_status = ?');
      params.push(status);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT k.*, u.full_name AS assigned_staff_name, u.username AS assigned_staff_username
       FROM kerala_safar_campuses k
       LEFT JOIN users u ON u.id = k.assigned_staff_id
       ${whereSql}
       ORDER BY k.serial_no ASC`
    )
    .all(...params);

  const scopeWhere = req.user.role === ROLES.CALLING_STAFF ? 'WHERE assigned_staff_id = ?' : '';
  const scopeParams = req.user.role === ROLES.CALLING_STAFF ? [req.user.id] : [];

  const stats = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN communication_status IN ('Pending First Call', 'Not Connected / Retrying', 'Callback Scheduled') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS attended,
        SUM(CASE WHEN valid_attempt_count > 0 AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS unattended,
        SUM(CASE WHEN valid_attempt_count > 0 OR communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS callsMade
       FROM kerala_safar_campuses
       ${scopeWhere}`
    )
    .get(...scopeParams);

  const safarDays = db
    .prepare(`SELECT safar_day FROM kerala_safar_campuses ${scopeWhere} GROUP BY safar_day ORDER BY MIN(serial_no) ASC`)
    .all(...scopeParams)
    .map((r) => r.safar_day);

  const orderRank = { kashif: 1, salman: 2, suhail: 3 };
  const staffBreakdown =
    req.user.role === ROLES.CALLING_STAFF
      ? []
      : db
          .prepare(
            `SELECT u.id, u.username, u.full_name, COUNT(k.id) AS count
             FROM kerala_safar_campuses k
             JOIN users u ON u.id = k.assigned_staff_id
             GROUP BY u.id, u.username, u.full_name`
          )
          .all()
          .sort((a, b) => (orderRank[a.username] || 99) - (orderRank[b.username] || 99));

  res.json({
    rows,
    total: rows.length,
    overallTotal: stats.total || 0,
    safarDays,
    staffBreakdown,
    stats,
  });
});

router.post('/:id/calls', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const { callOutcome = 'Successfully Contacted', remarks = '' } = req.body || {};

  const campus = db.prepare('SELECT * FROM kerala_safar_campuses WHERE id = ?').get(id);
  if (!campus) {
    return res.status(404).json({ error: 'Kerala Safar campus not found' });
  }
  if (req.user.role === ROLES.CALLING_STAFF && campus.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const isAttended = callOutcome === 'Successfully Contacted';
  const nextStatus = isAttended ? 'Successfully Contacted' : 'Not Connected / Retrying';
  const nextAttempts = isAttended ? campus.valid_attempt_count : Number(campus.valid_attempt_count || 0) + 1;

  db.prepare(
    `UPDATE kerala_safar_campuses
     SET communication_status = ?,
         valid_attempt_count = ?,
         last_call_outcome = ?,
         last_called_at = datetime('now'),
         notes_summary = CASE WHEN ? != '' THEN ? ELSE notes_summary END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextStatus, nextAttempts, callOutcome, remarks, remarks, id);

  logAudit(
    {
      user: req.user,
      action: 'SAFAR_CALL_LOGGED',
      entityType: 'kerala_safar_campus',
      entityId: id,
      details: { campusName: campus.campus_name, callOutcome },
    },
    db
  );

  const updated = db.prepare('SELECT * FROM kerala_safar_campuses WHERE id = ?').get(id);
  res.json({ ok: true, campus: updated });
});

router.post('/:id/calls/undo', (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const campus = db.prepare('SELECT * FROM kerala_safar_campuses WHERE id = ?').get(id);
  if (!campus) {
    return res.status(404).json({ error: 'Kerala Safar campus not found' });
  }
  if (req.user.role === ROLES.CALLING_STAFF && campus.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const revertedStatus = Number(campus.valid_attempt_count || 0) > 0 ? 'Not Connected / Retrying' : 'Pending First Call';
  db.prepare(
    `UPDATE kerala_safar_campuses
     SET communication_status = ?,
         last_call_outcome = NULL,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(revertedStatus, id);

  logAudit(
    {
      user: req.user,
      action: 'SAFAR_CALL_UNDONE',
      entityType: 'kerala_safar_campus',
      entityId: id,
      details: { campusName: campus.campus_name },
    },
    db
  );

  const updated = db.prepare('SELECT * FROM kerala_safar_campuses WHERE id = ?').get(id);
  res.json({ ok: true, campus: updated });
});

module.exports = router;
