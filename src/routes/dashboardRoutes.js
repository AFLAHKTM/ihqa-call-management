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
  const institutions = db
    .prepare('SELECT DISTINCT institution_name FROM students ORDER BY institution_name ASC')
    .all()
    .map((r) => r.institution_name);
  const districts = db
    .prepare('SELECT DISTINCT district FROM students ORDER BY district ASC')
    .all()
    .map((r) => r.district);
  const staffList =
    req.user.role === 'CALLING_STAFF'
      ? [{ id: req.user.id, full_name: req.user.full_name, role: req.user.role }]
      : db
          .prepare("SELECT id, full_name, role FROM users WHERE role IN ('CALLING_STAFF', 'SUPERVISOR') AND is_active = 1 ORDER BY full_name ASC")
          .all();

  const settings = getSettingsMap(db);

  const staffWhere = req.user.role === 'CALLING_STAFF' ? 'WHERE assigned_staff_id = ?' : '';
  const staffParams = req.user.role === 'CALLING_STAFF' ? [req.user.id] : [];
  const sectionCountsRows = db
    .prepare(`SELECT exam_category, COUNT(*) as c FROM students ${staffWhere} GROUP BY exam_category`)
    .all(...staffParams);
  const sectionCounts = { all: 0, qirath: 0, tafseer: 0 };
  for (const row of sectionCountsRows) {
    sectionCounts.all += row.c;
    if (row.exam_category === 'Holy Quran Recitation') sectionCounts.qirath = row.c;
    if (row.exam_category === 'Complete Memorization of the Holy Quran with Tafsir') sectionCounts.tafseer = row.c;
  }

  res.json({
    stats,
    sectionCounts,
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
