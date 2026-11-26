-- PostgreSQL Production Schema for Indian Holy Quran Award - Kerala Initial Screening
-- Call Management & Follow-Up System

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(180) NOT NULL,
  phone VARCHAR(30),
  role VARCHAR(24) NOT NULL CHECK (role IN ('ADMIN', 'SUPERVISOR', 'CALLING_STAFF')),
  daily_target INTEGER NOT NULL DEFAULT 30,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS institutions (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) UNIQUE,
  name VARCHAR(250) NOT NULL,
  place VARCHAR(180),
  district VARCHAR(80) NOT NULL,
  supervisor_name VARCHAR(150),
  supervisor_phone VARCHAR(30),
  supervisor_email VARCHAR(180),
  registered_students_count INTEGER NOT NULL DEFAULT 0,
  winner_status VARCHAR(60),
  category_scope VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id SERIAL PRIMARY KEY,
  registration_number VARCHAR(60) NOT NULL UNIQUE,
  student_name VARCHAR(180) NOT NULL,
  parent_name VARCHAR(180) NOT NULL,
  student_mobile VARCHAR(30),
  parent_mobile VARCHAR(30),
  email VARCHAR(180),
  district VARCHAR(80) NOT NULL,
  institution_id INTEGER REFERENCES institutions(id) ON DELETE SET NULL,
  institution_name VARCHAR(250) NOT NULL,
  coordinator_name VARCHAR(150),
  coordinator_mobile VARCHAR(30),
  coordinator_email VARCHAR(180),
  exam_category VARCHAR(160) NOT NULL,
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ,
  communication_status VARCHAR(60) NOT NULL DEFAULT 'Not Assigned',
  valid_attempt_count INTEGER NOT NULL DEFAULT 0,
  last_call_outcome VARCHAR(60),
  last_called_at TIMESTAMPTZ,
  next_followup_at TIMESTAMPTZ,
  manual_followup_required BOOLEAN NOT NULL DEFAULT FALSE,
  invalid_number_flagged BOOLEAN NOT NULL DEFAULT FALSE,
  three_attempt_sequence_id INTEGER NOT NULL DEFAULT 0,
  email_notified_sequence INTEGER NOT NULL DEFAULT 0,
  notes_summary TEXT,
  is_anonymized BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  staff_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attempt_number INTEGER,
  is_valid_attempt BOOLEAN NOT NULL DEFAULT TRUE,
  initiation_mode VARCHAR(30) NOT NULL DEFAULT 'manual' CHECK (initiation_mode IN ('manual', 'telephony_api', 'device_tel')),
  telephony_provider VARCHAR(40),
  external_call_id VARCHAR(120),
  telephony_status VARCHAR(40) DEFAULT 'logged',
  contact_type VARCHAR(30) NOT NULL DEFAULT 'student' CHECK (contact_type IN ('student', 'parent', 'coordinator')),
  contact_number_called VARCHAR(30) NOT NULL,
  call_outcome VARCHAR(60),
  call_duration_seconds INTEGER,
  followup_date TIMESTAMPTZ,
  remarks TEXT,
  called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_notifications (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL DEFAULT 1,
  recipient_email VARCHAR(180),
  recipient_name VARCHAR(180),
  subject VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  delivery_status VARCHAR(30) NOT NULL CHECK (delivery_status IN ('PENDING', 'SENT', 'RETRYING', 'FAILED', 'SKIPPED_NO_EMAIL')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  last_error TEXT,
  provider_message_id VARCHAR(180),
  sent_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  triggered_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_unique_seq
  ON email_notifications(student_id, sequence_number)
  WHERE delivery_status <> 'SKIPPED_NO_EMAIL';

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type VARCHAR(60) NOT NULL,
  title VARCHAR(180) NOT NULL,
  message TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'success')),
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  target_role VARCHAR(24),
  student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
  channels_json JSONB NOT NULL DEFAULT '["in_platform"]'::jsonb,
  delivery_results_json JSONB,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_settings (
  key VARCHAR(80) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username VARCHAR(80),
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(60),
  details_json JSONB,
  ip_address VARCHAR(60),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_students_district ON students(district);
CREATE INDEX IF NOT EXISTS idx_students_institution ON students(institution_name);
CREATE INDEX IF NOT EXISTS idx_students_staff ON students(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_students_status ON students(communication_status);
CREATE INDEX IF NOT EXISTS idx_call_attempts_student ON call_attempts(student_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_call_attempts_staff ON call_attempts(staff_id, called_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(target_user_id, is_read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
