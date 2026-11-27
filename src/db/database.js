const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let dbInstance = null;

const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'SUPERVISOR', 'CALLING_STAFF')),
  daily_target INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS institutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE,
  name TEXT NOT NULL,
  place TEXT,
  district TEXT NOT NULL,
  supervisor_name TEXT,
  supervisor_phone TEXT,
  supervisor_email TEXT,
  registered_students_count INTEGER NOT NULL DEFAULT 0,
  winner_status TEXT,
  category_scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_number TEXT NOT NULL UNIQUE,
  student_name TEXT NOT NULL,
  parent_name TEXT NOT NULL,
  student_mobile TEXT,
  parent_mobile TEXT,
  email TEXT,
  district TEXT NOT NULL,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  institution_name TEXT NOT NULL,
  coordinator_name TEXT,
  coordinator_mobile TEXT,
  coordinator_email TEXT,
  exam_category TEXT NOT NULL,
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TEXT,
  communication_status TEXT NOT NULL DEFAULT 'Not Assigned',
  valid_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_call_outcome TEXT,
  last_called_at TEXT,
  next_followup_at TEXT,
  manual_followup_required INTEGER NOT NULL DEFAULT 0,
  invalid_number_flagged INTEGER NOT NULL DEFAULT 0,
  three_attempt_sequence_id INTEGER NOT NULL DEFAULT 0,
  email_notified_sequence INTEGER NOT NULL DEFAULT 0,
  notes_summary TEXT,
  is_anonymized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_number INTEGER,
  is_valid_attempt INTEGER NOT NULL DEFAULT 1,
  initiation_mode TEXT NOT NULL DEFAULT 'manual' CHECK (initiation_mode IN ('manual', 'telephony_api', 'device_tel')),
  telephony_provider TEXT,
  external_call_id TEXT,
  telephony_status TEXT DEFAULT 'logged',
  contact_type TEXT NOT NULL DEFAULT 'student' CHECK (contact_type IN ('student', 'parent', 'coordinator')),
  contact_number_called TEXT NOT NULL,
  call_outcome TEXT,
  call_duration_seconds INTEGER,
  followup_date TEXT,
  remarks TEXT,
  called_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL DEFAULT 1,
  recipient_email TEXT,
  recipient_name TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('PENDING', 'SENT', 'RETRYING', 'FAILED', 'SKIPPED_NO_EMAIL')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  provider_message_id TEXT,
  sent_at TEXT,
  next_retry_at TEXT,
  triggered_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unique_seq
  ON email_notifications(student_id, sequence_number)
  WHERE delivery_status != 'SKIPPED_NO_EMAIL';

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'success')),
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_role TEXT,
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  channels_json TEXT NOT NULL DEFAULT '["in_platform"]',
  delivery_results_json TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details_json TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS unuploaded_campuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no INTEGER NOT NULL,
  institution_name TEXT NOT NULL,
  place TEXT,
  district TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'Kerala',
  supervisor_name TEXT,
  supervisor_phone TEXT,
  supervisor_email TEXT,
  enrolled_students INTEGER NOT NULL DEFAULT 0,
  winners_declared INTEGER NOT NULL DEFAULT 0,
  submission_status TEXT NOT NULL DEFAULT 'No Enrolled Students',
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  communication_status TEXT NOT NULL DEFAULT 'Pending First Call',
  valid_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_call_outcome TEXT,
  last_called_at TEXT,
  email_sent INTEGER NOT NULL DEFAULT 0,
  email_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campus_call_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id INTEGER NOT NULL REFERENCES unuploaded_campuses(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL,
  call_outcome TEXT NOT NULL,
  remarks TEXT,
  called_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_students_district ON students(district);
CREATE INDEX IF NOT EXISTS idx_students_institution ON students(institution_name);
CREATE INDEX IF NOT EXISTS idx_students_staff ON students(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(communication_status);
CREATE INDEX IF NOT EXISTS idx_students_regno ON students(registration_number);
CREATE INDEX IF NOT EXISTS idx_call_attempts_student ON call_attempts(student_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_attempts_staff ON call_attempts(staff_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(target_user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_unuploaded_district ON unuploaded_campuses(district);
CREATE INDEX IF NOT EXISTS idx_unuploaded_status ON unuploaded_campuses(communication_status);
`;

const DEFAULT_SETTINGS = {
  establishment_name: 'India Holy Quran Award — Kerala Coordination Office',
  establishment_calling_hours: '09:00 AM - 06:00 PM IST',
  establishment_start_hour: '9',
  establishment_end_hour: '18',
  max_attempts: '3',
  auto_email_on_max_attempts: 'true',
  auto_email_on_unattended: 'true',
  retry_interval_hours: '4',
  email_retry_max: '3',
  official_contact_phone: '+91 483 273 4500',
  official_contact_email: 'info@indiaquranaward.com',
  official_website_url: 'https://indiaquranaward.com',
  email_from: 'India Holy Quran Award <info@indiaquranaward.com>',
  telephony_provider: 'device_phone', // device_phone | simulated | exotel | twilio
  email_provider: 'gmail', // dev-json | gmail | smtp | ses
  smtp_host: 'smtp.gmail.com',
  smtp_port: '587',
  smtp_user: 'muhammedaflah295@gmail.com',
  channel_email_enabled: 'true',
  channel_in_platform_enabled: 'true',
  channel_sms_enabled: 'false',
  channel_whatsapp_enabled: 'false',
  sms_provider_name: 'MSG91 / Exotel SMS (Disabled)',
  whatsapp_provider_name: 'Meta WhatsApp Cloud API (Disabled)',
  call_recording_enabled: 'false',
  data_retention_days: '365',
};

function initDatabase(customPath) {
  const targetPath = customPath || config.dbPath;
  if (targetPath !== ':memory:') {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(targetPath);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
  } catch (_) {
    // Fallback gracefully on ephemeral/serverless filesystems
  }
  db.exec(SCHEMA_SQL);

  const insertSetting = db.prepare(
    `INSERT OR IGNORE INTO system_settings (key, value) VALUES (?, ?)`
  );
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    insertSetting.run(k, v);
  }

  try {
    db.prepare(`UPDATE system_settings SET value = 'info@indiaquranaward.com' WHERE key = 'official_contact_email' AND value LIKE '%coordination@ihqa%'`).run();
    db.prepare(`UPDATE system_settings SET value = 'India Holy Quran Award <info@indiaquranaward.com>' WHERE key = 'email_from' AND value LIKE '%coordination@ihqa%'`).run();
    db.prepare(`INSERT OR IGNORE INTO system_settings (key, value) VALUES ('email_from', 'India Holy Quran Award <info@indiaquranaward.com>')`).run();
  } catch (_) {
    // Ignore migration catch
  }

  try {
    const existingCampuses = db.prepare('SELECT COUNT(*) AS cnt FROM unuploaded_campuses').get().cnt;
    if (existingCampuses === 0) {
      const { getUnuploadedCampuses } = require('./unuploadedCampusesData');
      const campuses = getUnuploadedCampuses();
      const insertCampus = db.prepare(
        `INSERT INTO unuploaded_campuses (
          serial_no, institution_name, place, district, state,
          supervisor_name, supervisor_phone, supervisor_email,
          enrolled_students, winners_declared, submission_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      db.exec('BEGIN');
      for (const c of campuses) {
        insertCampus.run(
          c.serial_no,
          c.institution_name,
          c.place,
          c.district,
          c.state,
          c.supervisor_name,
          c.supervisor_phone,
          c.supervisor_email,
          c.enrolled_students,
          c.winners_declared,
          c.submission_status
        );
      }
      db.exec('COMMIT');
    }
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error('Failed to seed unuploaded_campuses:', err.message);
  }

  dbInstance = db;
  return db;
}

function getDb() {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

function setDb(db) {
  dbInstance = db;
}

function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {
      // ignore rollback errors
    }
    throw err;
  }
}

function getSettingsMap(db = getDb()) {
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  const map = {};
  for (const row of rows) {
    map[row.key] = row.value;
  }
  return map;
}

module.exports = {
  initDatabase,
  getDb,
  setDb,
  closeDb,
  withTransaction,
  getSettingsMap,
  DEFAULT_SETTINGS,
};
