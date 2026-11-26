const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { ROLES } = require('../constants');
const {
  listEmailNotifications,
  resendEmailNotification,
  processPendingEmailRetries,
  sendAutoEmailToUnattendedStudents,
} = require('../services/emailService');

const router = express.Router();

router.use(requireAuth, requireRole(ROLES.ADMIN, ROLES.SUPERVISOR));

router.get('/', (req, res) => {
  const rows = listEmailNotifications({ status: req.query.status || '' }, getDb());
  res.json({ emails: rows });
});

router.post('/send-unattended', async (req, res) => {
  try {
    const summary = await sendAutoEmailToUnattendedStudents(req.user, getDb());
    res.json({ summary });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/resend', requireRole(ROLES.ADMIN), async (req, res) => {
  try {
    const emailRecord = await resendEmailNotification(Number(req.params.id), req.user, getDb());
    res.json({ emailRecord });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/process-retries', requireRole(ROLES.ADMIN), async (req, res) => {
  const processed = await processPendingEmailRetries(getDb());
  res.json({ processedCount: processed.length, processed });
});

module.exports = router;
