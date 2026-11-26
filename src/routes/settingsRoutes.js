const express = require('express');
const config = require('../config');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb, getSettingsMap } = require('../db/database');
const { ROLES } = require('../constants');
const { maskSecret } = require('../utils/security');
const { listAuditLogs, logAudit } = require('../services/auditService');
const { runBackgroundSweep } = require('../services/jobScheduler');

const router = express.Router();

router.use(requireAuth);

router.get('/', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const db = getDb();
  const settings = getSettingsMap(db);
  res.json({
    settings,
    credentialsSummary: {
      emailProvider: settings.email_provider || config.email.provider,
      smtpHost: config.email.host || '(not configured)',
      smtpUserMasked: maskSecret(config.email.user),
      telephonyProvider: settings.telephony_provider || config.telephony.provider,
      exotelSidMasked: maskSecret(config.telephony.exotel.sid),
      twilioSidMasked: maskSecret(config.telephony.twilio.accountSid),
      callRecordingEnabled: false,
    },
  });
});

router.put('/', requireRole(ROLES.ADMIN), (req, res) => {
  const db = getDb();
  const updates = req.body || {};
  const allowedKeys = new Set([
    'max_attempts',
    'auto_email_on_max_attempts',
    'retry_interval_hours',
    'email_retry_max',
    'official_contact_phone',
    'official_contact_email',
    'official_website_url',
    'telephony_provider',
    'email_provider',
    'channel_email_enabled',
    'channel_in_platform_enabled',
    'channel_sms_enabled',
    'channel_whatsapp_enabled',
    'sms_provider_name',
    'whatsapp_provider_name',
    'data_retention_days',
  ]);

  const stmt = db.prepare(
    `INSERT INTO system_settings (key, value, updated_at, updated_by)
     VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by`
  );

  const applied = {};
  for (const [key, val] of Object.entries(updates)) {
    if (allowedKeys.has(key)) {
      stmt.run(key, String(val), req.user.id);
      applied[key] = String(val);
    }
  }

  logAudit(
    {
      user: req.user,
      action: 'SETTINGS_UPDATED',
      entityType: 'system_settings',
      details: applied,
      ipAddress: req.ip,
    },
    db
  );

  res.json({ settings: getSettingsMap(db) });
});

router.post('/run-jobs', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), async (req, res) => {
  const summary = await runBackgroundSweep(getDb());
  res.json({ summary });
});

router.get('/audit-logs', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const result = listAuditLogs(
    {
      limit: req.query.limit || 100,
      offset: req.query.offset || 0,
      action: req.query.action || '',
      entityType: req.query.entityType || '',
    },
    getDb()
  );
  res.json(result);
});

router.get('/institutions', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM institutions ORDER BY district ASC, name ASC')
    .all();
  res.json({ institutions: rows });
});

module.exports = router;
