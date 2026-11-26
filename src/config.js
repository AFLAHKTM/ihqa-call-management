require('dotenv').config();

const path = require('node:path');

module.exports = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'ihqa_call_management.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || 'ihqa-kerala-2026-dev-session-secret-change-prod',
  sessionCookieName: 'ihqa_session',
  sessionTtlMs: 12 * 60 * 60 * 1000, // 12 hours
  email: {
    provider: process.env.EMAIL_PROVIDER || 'dev-json', // 'smtp' | 'ses' | 'dev-json'
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'India Holy Quran Award Kerala <coordination@ihqakerala.org>',
  },
  telephony: {
    provider: process.env.TELEPHONY_PROVIDER || 'simulated', // 'exotel' | 'twilio' | 'simulated'
    webhookSecret: process.env.TELEPHONY_WEBHOOK_SECRET || 'ihqa-webhook-secret',
    exotel: {
      sid: process.env.EXOTEL_SID || '',
      apiKey: process.env.EXOTEL_API_KEY || '',
      apiToken: process.env.EXOTEL_API_TOKEN || '',
      callerId: process.env.EXOTEL_CALLER_ID || '',
      subdomain: process.env.EXOTEL_SUBDOMAIN || 'api.exotel.com',
    },
    twilio: {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      fromNumber: process.env.TWILIO_FROM_NUMBER || '',
    },
    callRecordingEnabled: false, // Locked off by default per Section M Privacy & Security
  },
  retentionDays: Number(process.env.DATA_RETENTION_DAYS || 365),
};
