const express = require('express');
const { getDb, getSettingsMap, withTransaction } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES, EMAIL_SUBJECT_THREE_ATTEMPTS } = require('../constants');
const { buildUnattendedEmailBody, sendGenericEmail } = require('../services/emailService');
const { isValidEmail } = require('../utils/security');
const { logAudit } = require('../services/auditService');

const router = express.Router();
router.use(requireAuth);

const SUCCESS_OUTCOMES = new Set(['Successfully Contacted', 'Follow-up Completed']);

router.get('/', (req, res) => {
  const db = getDb();
  const { search = '', district = '', status = '', staffId = '', limit = 500, offset = 0 } = req.query;

  const where = [];
  const params = [];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('c.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    if (staffId === 'unassigned') {
      where.push('c.assigned_staff_id IS NULL');
    } else {
      where.push('c.assigned_staff_id = ?');
      params.push(Number(staffId));
    }
  }

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      `(c.institution_name LIKE ? OR c.place LIKE ? OR c.district LIKE ? OR c.supervisor_name LIKE ? OR c.supervisor_phone LIKE ? OR c.supervisor_email LIKE ?)`
    );
    params.push(q, q, q, q, q, q);
  }
  if (district) {
    where.push('c.district = ?');
    params.push(district);
  }
  if (status) {
    where.push('c.communication_status = ?');
    params.push(status);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS cnt FROM unuploaded_campuses c ${whereSql}`).get(...params).cnt;

  const rows = db
    .prepare(
      `SELECT c.*, u.full_name AS assigned_staff_name
       FROM unuploaded_campuses c
       LEFT JOIN users u ON u.id = c.assigned_staff_id
       ${whereSql}
       ORDER BY c.serial_no ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, Number(limit) || 500, Number(offset) || 0);

  const districts = db
    .prepare('SELECT DISTINCT district FROM unuploaded_campuses ORDER BY district ASC')
    .all()
    .map((r) => r.district);

  const staffList = db
    .prepare("SELECT id, username, full_name FROM users WHERE role = 'CALLING_STAFF' AND is_active = 1 ORDER BY id ASC")
    .all();

  const staffBreakdown = db
    .prepare(
      `SELECT u.id, u.full_name, COUNT(c.id) AS count
       FROM unuploaded_campuses c
       JOIN users u ON u.id = c.assigned_staff_id
       GROUP BY u.id, u.full_name
       ORDER BY u.id ASC`
    )
    .all();

  const statsWhere = req.user.role === ROLES.CALLING_STAFF ? 'WHERE assigned_staff_id = ?' : '';
  const statsParams = req.user.role === ROLES.CALLING_STAFF ? [req.user.id] : [];
  const statsRow = db
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN communication_status IN ('Pending First Call', 'Pending Second Call', 'Pending Third Call') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS attended,
        SUM(CASE WHEN valid_attempt_count >= 1 AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS unattended,
        SUM(CASE WHEN email_sent = 1 THEN 1 ELSE 0 END) AS emailSent
       FROM unuploaded_campuses
       ${statsWhere}`
    )
    .get(...statsParams);

  res.json({
    rows,
    total,
    districts,
    staffList,
    staffBreakdown,
    stats: {
      total: statsRow.total || 0,
      pending: statsRow.pending || 0,
      attended: statsRow.attended || 0,
      unattended: statsRow.unattended || 0,
      emailSent: statsRow.emailSent || 0,
    },
  });
});

router.post('/:id/calls', async (req, res) => {
  const db = getDb();
  const campusId = Number(req.params.id);
  const { callOutcome, remarks = '' } = req.body || {};

  if (!callOutcome) {
    return res.status(400).json({ error: 'callOutcome is required' });
  }

  const campus = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  if (!campus) {
    return res.status(404).json({ error: 'Campus not found' });
  }

  const settings = getSettingsMap(db);
  const maxAttempts = Number(settings.max_attempts || 2);

  const updated = withTransaction(db, () => {
    const newAttemptCount = campus.valid_attempt_count + 1;

    db.prepare(
      `INSERT INTO campus_call_attempts (campus_id, staff_id, attempt_number, call_outcome, remarks)
       VALUES (?, ?, ?, ?, ?)`
    ).run(campusId, req.user.id, newAttemptCount, callOutcome, remarks || '');

    let newStatus;
    if (SUCCESS_OUTCOMES.has(callOutcome)) {
      newStatus = 'Successfully Contacted';
    } else if (newAttemptCount >= maxAttempts) {
      newStatus = maxAttempts === 2 ? 'Attempt 2 Completed' : 'Attempt 3 Completed';
    } else if (newAttemptCount === 1) {
      newStatus = 'Pending Second Call';
    } else if (newAttemptCount === 2) {
      newStatus = 'Pending Third Call';
    } else {
      newStatus = 'Attempt 3 Completed';
    }

    db.prepare(
      `UPDATE unuploaded_campuses
       SET communication_status = ?,
           valid_attempt_count = ?,
           last_call_outcome = ?,
           last_called_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(newStatus, newAttemptCount, callOutcome, campusId);

    logAudit(
      {
        user: req.user,
        action: 'CAMPUS_CALL_LOGGED',
        entityType: 'unuploaded_campus',
        entityId: campusId,
        details: { callOutcome, newAttemptCount, newStatus },
        ipAddress: req.ip,
      },
      db
    );

    return db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  });

  // Trigger auto-email if unattended and (reached maxAttempts OR immediate auto_email_on_unattended is enabled)
  let emailResult = null;
  const isSuccess = SUCCESS_OUTCOMES.has(callOutcome);
  const shouldEmail =
    !isSuccess &&
    updated.email_sent === 0 &&
    (updated.valid_attempt_count >= maxAttempts || settings.auto_email_on_unattended === 'true');

  if (shouldEmail && isValidEmail(updated.supervisor_email)) {
    try {
      const body = buildUnattendedEmailBody(updated, settings, updated.valid_attempt_count);
      const sendRes = await sendGenericEmail(
        {
          to: updated.supervisor_email,
          subject: EMAIL_SUBJECT_THREE_ATTEMPTS,
          text: body,
        },
        db
      );

      db.prepare(
        `UPDATE unuploaded_campuses
         SET email_sent = 1,
             email_sent_at = datetime('now'),
             communication_status = CASE WHEN valid_attempt_count >= ? THEN 'Email Notification Sent' ELSE communication_status END
         WHERE id = ?`
      ).run(maxAttempts, campusId);

      emailResult = { sent: true, simulated: sendRes.simulated, to: updated.supervisor_email };
    } catch (err) {
      emailResult = { sent: false, error: err.message };
    }
  }

  const finalCampus = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  res.json({ ok: true, campus: finalCampus, emailResult });
});

router.post('/:id/calls/undo', (req, res) => {
  const db = getDb();
  const campusId = Number(req.params.id);
  const campus = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  if (!campus) {
    return res.status(404).json({ error: 'Campus not found' });
  }

  const updated = withTransaction(db, () => {
    const latest = db
      .prepare('SELECT * FROM campus_call_attempts WHERE campus_id = ? ORDER BY id DESC LIMIT 1')
      .get(campusId);

    if (!latest) {
      throw new Error('No call attempt to undo');
    }

    db.prepare('DELETE FROM campus_call_attempts WHERE id = ?').run(latest.id);

    const remaining = db
      .prepare('SELECT * FROM campus_call_attempts WHERE campus_id = ? ORDER BY id DESC')
      .all(campusId);

    const newCount = remaining.length;
    let newStatus;
    let lastOutcome = null;
    let lastCalledAt = null;

    if (newCount === 0) {
      newStatus = 'Pending First Call';
    } else {
      const last = remaining[0];
      lastOutcome = last.call_outcome;
      lastCalledAt = last.called_at;
      if (SUCCESS_OUTCOMES.has(lastOutcome)) {
        newStatus = 'Successfully Contacted';
      } else if (newCount === 1) {
        newStatus = 'Pending Second Call';
      } else if (newCount === 2) {
        newStatus = 'Pending Third Call';
      } else {
        newStatus = 'Attempt 3 Completed';
      }
    }

    db.prepare(
      `UPDATE unuploaded_campuses
       SET communication_status = ?,
           valid_attempt_count = ?,
           last_call_outcome = ?,
           last_called_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(newStatus, newCount, lastOutcome, lastCalledAt, campusId);

    logAudit(
      {
        user: req.user,
        action: 'CAMPUS_CALL_UNDONE',
        entityType: 'unuploaded_campus',
        entityId: campusId,
        details: { deletedAttemptId: latest.id, restoredStatus: newStatus },
        ipAddress: req.ip,
      },
      db
    );

    return db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  });

  res.json({ ok: true, campus: updated });
});

router.post('/assign', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const db = getDb();
  const { campusIds, staffId } = req.body || {};
  if (!Array.isArray(campusIds) || campusIds.length === 0 || !staffId) {
    return res.status(400).json({ error: 'campusIds array and staffId are required' });
  }
  const stmt = db.prepare('UPDATE unuploaded_campuses SET assigned_staff_id = ?, updated_at = datetime(\'now\') WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const id of campusIds) {
      stmt.run(Number(staffId), Number(id));
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true, assignedCount: campusIds.length });
});

router.patch('/:id/submission-status', (req, res) => {
  const db = getDb();
  const campusId = Number(req.params.id);
  const { submissionStatus } = req.body || {};
  const allowed = new Set(['No Enrolled Students', 'Winner Added', 'Canceled Program']);

  if (!allowed.has(submissionStatus)) {
    return res.status(400).json({ error: 'Invalid submissionStatus' });
  }

  const campus = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  if (!campus) {
    return res.status(404).json({ error: 'Campus not found' });
  }
  if (req.user.role === ROLES.CALLING_STAFF && campus.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare(
    `UPDATE unuploaded_campuses
     SET submission_status = ?,
         winners_declared = CASE WHEN ? = 'Winner Added' THEN 1 ELSE 0 END,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(submissionStatus, submissionStatus, campusId);

  logAudit(
    {
      user: req.user,
      action: 'CAMPUS_SUBMISSION_STATUS_UPDATED',
      entityType: 'unuploaded_campus',
      entityId: campusId,
      details: { submissionStatus },
      ipAddress: req.ip,
    },
    db
  );

  const updated = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  res.json({ ok: true, campus: updated });
});

router.patch('/:id', (req, res) => {
  const db = getDb();
  const campusId = Number(req.params.id);
  const campus = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  if (!campus) {
    return res.status(404).json({ error: 'Campus not found' });
  }
  if (req.user.role === ROLES.CALLING_STAFF && campus.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    institution_name,
    place,
    district,
    supervisor_name,
    supervisor_phone,
    supervisor_email,
  } = req.body || {};

  const nextInst = institution_name !== undefined ? String(institution_name).trim() : campus.institution_name;
  const nextPlace = place !== undefined ? String(place).trim() : campus.place;
  const nextDistrict = district !== undefined ? String(district).trim() : campus.district;
  const nextSupName = supervisor_name !== undefined ? String(supervisor_name).trim() : campus.supervisor_name;
  const nextSupPhone = supervisor_phone !== undefined ? String(supervisor_phone).trim() : campus.supervisor_phone;
  const nextSupEmail = supervisor_email !== undefined ? String(supervisor_email).trim() : campus.supervisor_email;

  if (!nextInst || !nextDistrict) {
    return res.status(400).json({ error: 'Institution Name and District are required' });
  }

  db.prepare(
    `UPDATE unuploaded_campuses
     SET institution_name = ?,
         place = ?,
         district = ?,
         supervisor_name = ?,
         supervisor_phone = ?,
         supervisor_email = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextInst, nextPlace, nextDistrict, nextSupName, nextSupPhone, nextSupEmail, campusId);

  logAudit(
    {
      user: req.user,
      action: 'CAMPUS_DETAILS_UPDATED',
      entityType: 'unuploaded_campus',
      entityId: campusId,
      details: { nextInst, nextPlace, nextDistrict, nextSupName, nextSupPhone, nextSupEmail },
      ipAddress: req.ip,
    },
    db
  );

  const updated = db.prepare('SELECT * FROM unuploaded_campuses WHERE id = ?').get(campusId);
  res.json({ ok: true, campus: updated });
});

module.exports = router;
