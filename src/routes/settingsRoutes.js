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
  const provider = settings.email_provider || config.email.provider || 'dev-json';
  const effectiveHost = settings.smtp_host || config.email.host || '';
  const effectiveUser = settings.smtp_user || config.email.user || '';
  const hasPass = Boolean(settings.smtp_pass || config.email.pass);

  res.json({
    settings: {
      ...settings,
      smtp_pass: hasPass ? '••••••••' : '',
    },
    credentialsSummary: {
      emailProvider: provider,
      smtpHost: effectiveHost || (provider === 'gmail' ? 'smtp.gmail.com' : '(not configured)'),
      smtpUserMasked: maskSecret(effectiveUser),
      hasSmtpPass: hasPass,
      isRealSmtpReady: (provider === 'gmail' && effectiveUser && hasPass) || (provider === 'smtp' && effectiveHost && effectiveUser && hasPass),
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
    'establishment_name',
    'establishment_calling_hours',
    'establishment_start_hour',
    'establishment_end_hour',
    'max_attempts',
    'auto_email_on_max_attempts',
    'auto_email_on_unattended',
    'retry_interval_hours',
    'email_retry_max',
    'official_contact_phone',
    'official_contact_email',
    'official_website_url',
    'email_from',
    'email_provider',
    'smtp_host',
    'smtp_port',
    'smtp_secure',
    'smtp_user',
    'smtp_pass',
    'telephony_provider',
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
      if (key === 'smtp_pass' && (val === '••••••••' || !val)) {
        continue;
      }
      stmt.run(key, String(val), req.user.id);
      applied[key] = key === 'smtp_pass' ? '[MASKED]' : String(val);
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

router.post('/test-email', requireRole(ROLES.ADMIN), async (req, res) => {
  const db = getDb();
  const settings = getSettingsMap(db);
  const targetEmail = req.body?.to || req.user.email || settings.official_contact_email;
  const { isValidEmail } = require('../utils/security');

  if (!isValidEmail(targetEmail)) {
    return res.status(400).json({ error: 'Please enter a valid recipient email address for testing.' });
  }

  const { getTransporter, sendGenericEmail } = require('../services/emailService');
  const transporter = getTransporter(settings);

  if (transporter.isSimulated) {
    const isGmail = (settings.smtp_user || '').includes('@gmail.com');
    const msg = isGmail
      ? `Cannot deliver real email: Google App Password for ${settings.smtp_user} is missing. Please enter your 16-character Google App Password in the Password field below, click "Save Configuration", and test again.`
      : 'Cannot deliver real email: SMTP Password is missing. Please enter your SMTP Password in the field below, click "Save Configuration", and test again.';
    return res.status(400).json({
      error: msg,
      simulated: true,
    });
  }

  try {
    const result = await sendGenericEmail(
      {
        to: targetEmail,
        subject: 'Test Verification Email – India Holy Quran Award',
        text: `Greetings,\n\nThis is a verified test email sent from the India Holy Quran Award Call Management portal.\n\nSender: ${settings.email_from || 'info@indiaquranaward.com'}\nDelivered To: ${targetEmail}\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST\n\nYour SMTP email delivery configuration is working!`,
      },
      db
    );
    res.json({ ok: true, message: `Real test email successfully sent to ${targetEmail}!`, result });
  } catch (err) {
    console.error('SMTP test email failed:', err);
    let help = err.message || 'Could not send test email';
    if (help.includes('535') || help.toLowerCase().includes('badcredentials') || help.toLowerCase().includes('username and password not accepted')) {
      help = 'Authentication failed (Invalid Username or Password). If using Gmail, Google requires a 16-character App Password (not your Gmail login password). Generate it at: Google Account > Security > 2-Step Verification > App passwords.';
    }
    res.status(500).json({
      error: `SMTP connection failed: ${help}`,
    });
  }
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
