const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const db = getDb();
  const { search = '', safarDay = '', status = '' } = req.query;

  const where = [];
  const params = [];

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      '(campus_name LIKE ? OR place LIKE ? OR safar_day LIKE ? OR contact_person LIKE ? OR contact_number LIKE ? OR contact_person_2 LIKE ? OR contact_number_2 LIKE ?)'
    );
    params.push(q, q, q, q, q, q, q);
  }

  if (safarDay) {
    where.push('safar_day = ?');
    params.push(safarDay);
  }

  if (status) {
    if (status === 'PENDING_ALL') {
      where.push("communication_status IN ('Pending First Call', 'Not Connected / Retrying', 'Callback Scheduled')");
    } else if (status === 'UNATTENDED') {
      where.push("valid_attempt_count > 0 AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')");
    } else if (status === 'CALLS_MADE') {
      where.push("(valid_attempt_count > 0 OR communication_status IN ('Successfully Contacted', 'Follow-up Completed'))");
    } else {
      where.push('communication_status = ?');
      params.push(status);
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM kerala_safar_campuses ${whereSql} ORDER BY serial_no ASC`)
    .all(...params);

  const stats = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN communication_status IN ('Pending First Call', 'Not Connected / Retrying', 'Callback Scheduled') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS attended,
        SUM(CASE WHEN valid_attempt_count > 0 AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS unattended,
        SUM(CASE WHEN valid_attempt_count > 0 OR communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS callsMade
       FROM kerala_safar_campuses`
    )
    .get();

  const safarDays = db
    .prepare('SELECT safar_day FROM kerala_safar_campuses GROUP BY safar_day ORDER BY MIN(serial_no) ASC')
    .all()
    .map((r) => r.safar_day);

  res.json({
    rows,
    total: rows.length,
    overallTotal: stats.total || 0,
    safarDays,
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
