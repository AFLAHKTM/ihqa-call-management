const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { ROLES } = require('../constants');
const {
  listStudents,
  getStudentById,
  getStudentCallHistory,
  getStudentEmails,
  assignStudents,
  shuffleBySection,
  logCallAttempt,
  updateStudentContactAndStatus,
} = require('../services/callWorkflowService');
const { initiateClickToCall } = require('../services/telephonyService');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const result = listStudents(req.query, req.user, getDb());
  res.json(result);
});

router.post('/', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const {
    registrationNumber,
    studentName,
    parentName,
    studentMobile,
    parentMobile,
    email,
    district,
    institutionName,
    coordinatorName,
    coordinatorMobile,
    coordinatorEmail,
    examCategory,
    assignedStaffId,
  } = req.body || {};

  if (!registrationNumber || !studentName || !parentName || !district || !institutionName || !examCategory) {
    return res.status(400).json({
      error: 'registrationNumber, studentName, parentName, district, institutionName, and examCategory are required',
    });
  }

  const db = getDb();
  const status = assignedStaffId ? 'Pending First Call' : 'Not Assigned';
  try {
    const info = db
      .prepare(
        `INSERT INTO students (
          registration_number, student_name, parent_name, student_mobile, parent_mobile, email,
          district, institution_name, coordinator_name, coordinator_mobile, coordinator_email,
          exam_category, assigned_staff_id, assigned_at, communication_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END, ?)`
      )
      .run(
        String(registrationNumber).trim(),
        String(studentName).trim(),
        String(parentName).trim(),
        studentMobile || null,
        parentMobile || null,
        email || null,
        district,
        institutionName,
        coordinatorName || null,
        coordinatorMobile || null,
        coordinatorEmail || null,
        examCategory,
        assignedStaffId ? Number(assignedStaffId) : null,
        assignedStaffId ? Number(assignedStaffId) : null,
        status
      );

    const created = getStudentById(Number(info.lastInsertRowid), db);
    logAudit(
      {
        user: req.user,
        action: 'STUDENT_CREATED',
        entityType: 'student',
        entityId: created.id,
        details: { registrationNumber: created.registration_number },
        ipAddress: req.ip,
      },
      db
    );
    res.status(201).json({ student: created });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Registration number already exists' });
    }
    return res.status(400).json({ error: err.message });
  }
});

router.post('/assign', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  try {
    const { studentIds, staffId } = req.body || {};
    const result = assignStudents({ studentIds, staffId, assignedByUser: req.user }, getDb());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/shuffle-by-section', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  try {
    const { section = 'both', staffIds = [], onlyPending = true } = req.body || {};
    const result = shuffleBySection(
      { section, staffIds, onlyPending, assignedByUser: req.user },
      getDb()
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: you can only view students assigned to you' });
  }

  const history = getStudentCallHistory(student.id, db);
  const emails = getStudentEmails(student.id, db);

  logAudit(
    {
      user: req.user,
      action: 'STUDENT_RECORD_VIEWED',
      entityType: 'student',
      entityId: student.id,
      ipAddress: req.ip,
    },
    db
  );

  res.json({ student, history, emails });
});

router.patch('/:id', (req, res) => {
  try {
    const updated = updateStudentContactAndStatus(Number(req.params.id), req.body || {}, req.user, getDb());
    res.json({ student: updated });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/:id/click-to-call', async (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: you can only initiate calls for students assigned to you' });
  }

  try {
    const { contactType = 'student', mode = 'telephony_api' } = req.body || {};
    const result = await initiateClickToCall(
      { studentId: student.id, contactType, mode, staffUser: req.user },
      db
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/calls', async (req, res) => {
  try {
    const result = await logCallAttempt(
      {
        studentId: Number(req.params.id),
        staffUser: req.user,
        callSessionId: req.body?.callSessionId || null,
        contactType: req.body?.contactType || 'student',
        contactNumberCalled: req.body?.contactNumberCalled || null,
        callOutcome: req.body?.callOutcome,
        callDurationSeconds: req.body?.callDurationSeconds ?? null,
        followupDate: req.body?.followupDate || null,
        remarks: req.body?.remarks || '',
        isValidAttempt: req.body?.isValidAttempt !== false,
        markFollowupCompleted: Boolean(req.body?.markFollowupCompleted),
        initiationMode: req.body?.initiationMode || 'manual',
      },
      getDb()
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

module.exports = router;
