const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb, getSettingsMap } = require('../db/database');
const { getDashboardStats } = require('../services/reportService');
const {
  CALL_OUTCOMES,
  COMMUNICATION_STATUSES,
  EXAM_CATEGORIES,
  KERALA_DISTRICTS,
} = require('../constants');

const router = express.Router();

router.use(requireAuth);

router.get('/summary', (req, res) => {
  const db = getDb();
  const stats = getDashboardStats(req.query, req.user, db);
  const selectedStaffId =
    req.user.role === 'CALLING_STAFF'
      ? req.user.id
      : req.query.assignedStaffId && req.query.assignedStaffId !== 'unassigned'
        ? Number(req.query.assignedStaffId)
        : null;
  const instWhere = selectedStaffId ? 'WHERE assigned_staff_id = ?' : '';
  const instParams = selectedStaffId ? [selectedStaffId] : [];
  const institutions = db
    .prepare(`SELECT DISTINCT institution_name FROM students ${instWhere} ORDER BY institution_name ASC`)
    .all(...instParams)
    .map((r) => r.institution_name);
  const districts = db
    .prepare(`SELECT DISTINCT district FROM students ${instWhere} ORDER BY district ASC`)
    .all(...instParams)
    .map((r) => r.district);
  const staffList =
    req.user.role === 'CALLING_STAFF'
      ? [{ id: req.user.id, full_name: req.user.full_name, role: req.user.role }]
      : db
          .prepare("SELECT id, full_name, role FROM users WHERE role IN ('CALLING_STAFF', 'SUPERVISOR') AND is_active = 1 ORDER BY full_name ASC")
          .all();

  const settings = getSettingsMap(db);

  const staffWhere = selectedStaffId ? 'WHERE assigned_staff_id = ?' : '';
  const staffParams = selectedStaffId ? [selectedStaffId] : [];
  const sectionCountsRows = db
    .prepare(`SELECT exam_category, COUNT(*) as c FROM students ${staffWhere} GROUP BY exam_category`)
    .all(...staffParams);
  const sectionCounts = { all: 0, qirath: 0, tafseer: 0 };
  for (const row of sectionCountsRows) {
    sectionCounts.all += row.c;
    if (row.exam_category === 'Holy Quran Recitation') sectionCounts.qirath = row.c;
    if (row.exam_category === 'Complete Memorization of the Holy Quran with Tafsir') sectionCounts.tafseer = row.c;
  }

  const orderRank = { shahid_adany: 1, usman_adany: 2, saeed_adany: 3 };
  const staffBreakdown =
    req.user.role === 'CALLING_STAFF'
      ? []
      : db
          .prepare(
            `SELECT u.id, u.username, u.full_name, COUNT(s.id) AS count
             FROM students s
             JOIN users u ON u.id = s.assigned_staff_id
             GROUP BY u.id, u.username, u.full_name`
          )
          .all()
          .sort((a, b) => (orderRank[a.username] || 99) - (orderRank[b.username] || 99));

  const overallTotal =
    req.user.role === 'CALLING_STAFF'
      ? sectionCounts.all
      : db.prepare('SELECT COUNT(*) AS c FROM students').get().c;

  const isStaff = req.user.role === 'CALLING_STAFF';
  const unuploadedTotal = isStaff
    ? db.prepare('SELECT COUNT(*) AS c FROM unuploaded_campuses WHERE assigned_staff_id = ?').get(req.user.id).c
    : db.prepare('SELECT COUNT(*) AS c FROM unuploaded_campuses').get().c;
  const approvedTotal = isStaff
    ? db
        .prepare(
          "SELECT COUNT(*) AS c FROM students WHERE communication_status IN ('Successfully Contacted', 'Follow-up Completed') AND assigned_staff_id = ?"
        )
        .get(req.user.id).c
    : db
        .prepare(
          `SELECT COUNT(*) AS c
           FROM students s
           JOIN users u ON u.id = s.assigned_staff_id
           WHERE s.communication_status IN ('Successfully Contacted', 'Follow-up Completed')
             AND u.username IN ('shahid_adany', 'usman_adany', 'saeed_adany')`
        )
        .get().c;
  const mondayTotal = isStaff
    ? db.prepare("SELECT COUNT(*) AS c FROM students WHERE scheduled_call_day = 'Monday' AND assigned_staff_id = ?").get(req.user.id).c
    : db.prepare("SELECT COUNT(*) AS c FROM students WHERE scheduled_call_day = 'Monday'").get().c;
  const tuesdayTotal = isStaff
    ? db.prepare("SELECT COUNT(*) AS c FROM students WHERE scheduled_call_day = 'Tuesday' AND assigned_staff_id = ?").get(req.user.id).c
    : db.prepare("SELECT COUNT(*) AS c FROM students WHERE scheduled_call_day = 'Tuesday'").get().c;
  const safarTotal = db.prepare('SELECT COUNT(*) AS c FROM kerala_safar_campuses').get().c;

  res.json({
    stats,
    sectionCounts,
    staffBreakdown,
    overallTotal,
    navBadges: {
      unuploadedTotal,
      approvedTotal,
      mondayTotal,
      tuesdayTotal,
      safarTotal,
    },
    filtersMeta: {
      districts: districts.length ? districts : KERALA_DISTRICTS,
      institutions,
      staffList,
      callOutcomes: CALL_OUTCOMES,
      communicationStatuses: COMMUNICATION_STATUSES,
      examCategories: EXAM_CATEGORIES,
    },
    workflowConfig: {
      maxAttempts: Number(settings.max_attempts || 3),
      autoEmailOnMaxAttempts: settings.auto_email_on_max_attempts !== 'false',
      telephonyProvider: settings.telephony_provider || 'simulated',
      callRecordingEnabled: false,
    },
  });
});

module.exports = router;
