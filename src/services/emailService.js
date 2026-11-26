const nodemailer = require('nodemailer');
const config = require('../config');
const { getDb, getSettingsMap } = require('../db/database');
const { EMAIL_SUBJECT_THREE_ATTEMPTS, NOTIFICATION_TYPES } = require('../constants');
const { isValidEmail } = require('../utils/security');
const { logAudit } = require('./auditService');

let customTransporter = null;

function setCustomTransporter(transporter) {
  customTransporter = transporter;
}

function getTransporter(settings) {
  if (customTransporter) {
    customTransporter.isSimulated = false;
    return customTransporter;
  }
  const provider = settings.email_provider || config.email.provider || 'dev-json';
  const user = settings.smtp_user || config.email.user;
  const pass = settings.smtp_pass || config.email.pass;
  const host = settings.smtp_host || config.email.host;
  const port = Number(settings.smtp_port || config.email.port || 587);
  const secure = String(settings.smtp_secure ?? config.email.secure) === 'true';

  if (provider === 'gmail' && user && pass) {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass },
    });
    t.isSimulated = false;
    return t;
  }
  if ((provider === 'smtp' || provider === 'ses') && host && user && pass) {
    const t = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
    });
    t.isSimulated = false;
    return t;
  }
  // Safe local/dev transport using nodemailer jsonTransport
  const t = nodemailer.createTransport({ jsonTransport: true });
  t.isSimulated = true;
  return t;
}

function buildUnattendedEmailBody(student, settings, attemptCount = 3) {
  const estName = settings.establishment_name || 'India Holy Quran Award — Kerala Coordination Office';
  const callingHours = settings.establishment_calling_hours || '09:00 AM - 06:00 PM IST';
  const phone = settings.official_contact_phone || '+91 483 273 4500';
  const email = settings.official_contact_email || 'info@indiaquranaward.com';
  const website = settings.official_website_url || 'https://indiaquranaward.com';
  const instName = student.institution_name || 'Institution';
  const coordinatorName = student.coordinator_name || 'Principal / Coordinator';

  if (attemptCount >= 3) {
    return `To: The Principal / Institution Coordinator (${coordinatorName})
Institution: ${instName}
Regarding Candidate: ${student.student_name} (Reg No: ${student.registration_number})

Dear Principal / Coordinator & Dear ${student.student_name} / Parent,

Greetings from the India Holy Quran Award.

Our coordination team has attempted to reach your institution and candidate THREE (3) times by phone regarding verification for the Kerala Initial Screening of the India Holy Quran Award, but the calls were unattended (${student.last_call_outcome || 'Unattended'}).

Candidate & Institution Details:
• Student Name: ${student.student_name}
• Registration Number: ${student.registration_number}
• Examination Category: ${student.exam_category}
• Institution: ${instName}
• District: ${student.district}
• Total Unattended Calls: 3

Since 3 phone attempts have been exhausted, we kindly request the institution authority or coordinator to urgently contact our coordination team or reply to this email (${email}) to confirm the student's screening participation and receive schedule information.

Thank you.

${estName}
Official Contact Phone: ${phone}
Official Email: ${email}
Office Calling Hours: ${callingHours}
Website: ${website}`;
  }

  return `Dear ${student.student_name} / Parent,

Greetings from the India Holy Quran Award.

Our coordination team attempted to reach you by phone (${student.last_call_outcome || 'Unattended'}) regarding your participation in the Kerala Initial Screening of the India Holy Quran Award.

Unfortunately, we have not been able to reach you.

We kindly request you to contact our coordination team or respond to this email to confirm your availability and receive the necessary examination information.

Your participation is important to us.

Thank you.

${estName}
Official Contact Phone: ${phone}
Official Email: ${email}
Office Calling Hours: ${callingHours}
Website: ${website}`;
}

function buildThreeAttemptEmailBody(student, settings) {
  return buildUnattendedEmailBody(student, settings, 3);
}

async function sendGenericEmail({ to, subject, text }, db = getDb()) {
  if (!isValidEmail(to)) {
    return { ok: false, error: 'Invalid recipient email address' };
  }
  const settings = getSettingsMap(db);
  const transporter = getTransporter(settings);
  const senderFrom =
    settings.email_from ||
    (config.email && config.email.from) ||
    'India Holy Quran Award <info@indiaquranaward.com>';
  const info = await transporter.sendMail({
    from: senderFrom,
    to,
    subject,
    text,
  });
  return { ok: true, messageId: info.messageId || `msg-${Date.now()}` };
}

function notifyEmailFailure(db, student, errorMsg) {
  const { dispatchNotification } = require('./notificationService');
  dispatchNotification(
    {
      type: NOTIFICATION_TYPES.EMAIL_DELIVERY_FAILURE,
      title: 'Email Delivery Failed',
      message: `Three-attempt notice to ${student.student_name} (${student.registration_number}) failed: ${errorMsg}`,
      severity: 'error',
      targetRole: 'ADMIN',
      studentId: student.id,
    },
    db
  );
}

async function attemptEmailDelivery(emailRecordId, db = getDb()) {
  const row = db
    .prepare(
      `SELECT e.*, s.registration_number, s.student_name, s.three_attempt_sequence_id
       FROM email_notifications e
       JOIN students s ON s.id = e.student_id
       WHERE e.id = ?`
    )
    .get(emailRecordId);

  if (!row) throw new Error('Email notification record not found');
  if (!isValidEmail(row.recipient_email)) {
    db.prepare(
      `UPDATE email_notifications
       SET delivery_status = 'SKIPPED_NO_EMAIL', last_error = 'No valid email address exists', updated_at = datetime('now')
       WHERE id = ?`
    ).run(row.id);
    db.prepare(`UPDATE students SET manual_followup_required = 1, updated_at = datetime('now') WHERE id = ?`).run(row.student_id);
    return db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(row.id);
  }

  const settings = getSettingsMap(db);
  const transporter = getTransporter(settings);
  const nextAttempt = (row.attempt_count || 0) + 1;
  const senderFrom =
    settings.email_from ||
    (config.email && config.email.from) ||
    'India Holy Quran Award <info@indiaquranaward.com>';

  try {
    const info = await transporter.sendMail({
      from: senderFrom,
      to: row.recipient_email,
      subject: row.subject,
      text: row.body,
    });
    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const simNote = transporter.isSimulated
      ? 'SIMULATION_ONLY: Real SMTP credentials not configured. Configure Gmail or SMTP in Settings to deliver to real inboxes.'
      : null;

    db.prepare(
      `UPDATE email_notifications
       SET delivery_status = 'SENT',
           attempt_count = ?,
           last_error = ?,
           provider_message_id = ?,
           sent_at = ?,
           next_retry_at = NULL,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(nextAttempt, simNote, info.messageId || `ihqa-${Date.now()}`, nowIso, row.id);

    db.prepare(
      `UPDATE students
       SET communication_status = CASE
             WHEN communication_status IN ('Attempt 3 Completed', 'Email Notification Sent') THEN 'Email Notification Sent'
             ELSE communication_status
           END,
           email_notified_sequence = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(row.sequence_number, row.student_id);

    logAudit(
      {
        action: 'EMAIL_SENT',
        entityType: 'email_notification',
        entityId: row.id,
        details: { studentId: row.student_id, to: row.recipient_email, sequence: row.sequence_number },
      },
      db
    );
  } catch (err) {
    const maxRetries = row.max_retries || Number(settings.email_retry_max || 3);
    const isFinalFailure = nextAttempt >= maxRetries;
    const status = isFinalFailure ? 'FAILED' : 'RETRYING';
    const nextRetryAt = isFinalFailure
      ? null
      : new Date(Date.now() + nextAttempt * 5 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');

    db.prepare(
      `UPDATE email_notifications
       SET delivery_status = ?,
           attempt_count = ?,
           last_error = ?,
           next_retry_at = ?,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(status, nextAttempt, err.message || 'Email transport failure', nextRetryAt, row.id);

    logAudit(
      {
        action: 'EMAIL_DELIVERY_ERROR',
        entityType: 'email_notification',
        entityId: row.id,
        details: { studentId: row.student_id, status, attempt: nextAttempt, error: err.message },
      },
      db
    );

    if (isFinalFailure) {
      notifyEmailFailure(db, row, err.message || 'Unknown SMTP failure');
    }
  }

  return db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(row.id);
}

async function triggerThreeAttemptEmail(studentId, actorUser = null, db = getDb()) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) throw new Error('Student not found');

  const sequenceNumber = student.three_attempt_sequence_id || 1;

  // Duplicate guard for same three-attempt sequence
  const existing = db
    .prepare(
      `SELECT * FROM email_notifications
       WHERE student_id = ? AND sequence_number = ? AND delivery_status != 'SKIPPED_NO_EMAIL'`
    )
    .get(studentId, sequenceNumber);

  if (existing) {
    return { duplicatePrevented: true, emailRecord: existing };
  }

  const settings = getSettingsMap(db);
  const maxRetries = Number(settings.email_retry_max || 3);
  const subject = EMAIL_SUBJECT_THREE_ATTEMPTS;
  const body = buildUnattendedEmailBody(student, settings, student.valid_attempt_count || 3);

  // Prioritize institution email: supervisor_email from institutions, then coordinator_email, then student.email
  let targetEmail = null;
  let recipientName = student.coordinator_name || student.institution_name || student.student_name;

  if (student.institution_id) {
    const inst = db
      .prepare('SELECT name, supervisor_name, supervisor_email FROM institutions WHERE id = ?')
      .get(student.institution_id);
    if (inst && isValidEmail(inst.supervisor_email)) {
      targetEmail = inst.supervisor_email.trim();
      recipientName = inst.supervisor_name || inst.name || recipientName;
    }
  }

  if (!targetEmail && isValidEmail(student.coordinator_email)) {
    targetEmail = student.coordinator_email.trim();
    if (student.coordinator_name) {
      recipientName = student.coordinator_name;
    }
  }

  if (!targetEmail && isValidEmail(student.email)) {
    targetEmail = student.email.trim();
    recipientName = student.student_name;
  }

  if (!targetEmail) {
    const info = db
      .prepare(
        `INSERT INTO email_notifications (
          student_id, sequence_number, recipient_email, recipient_name, subject, body,
          delivery_status, attempt_count, max_retries, last_error, triggered_by_user_id
        ) VALUES (?, ?, NULL, ?, ?, ?, 'SKIPPED_NO_EMAIL', 0, ?, 'No valid email address exists; flagged for manual follow-up.', ?)`
      )
      .run(student.id, sequenceNumber, student.student_name, subject, body, maxRetries, actorUser?.id ?? null);

    db.prepare(`UPDATE students SET manual_followup_required = 1, updated_at = datetime('now') WHERE id = ?`).run(student.id);

    logAudit(
      {
        user: actorUser,
        action: 'EMAIL_SKIPPED_NO_ADDRESS',
        entityType: 'student',
        entityId: student.id,
        details: { sequenceNumber },
      },
      db
    );

    return {
      duplicatePrevented: false,
      skippedNoEmail: true,
      emailRecord: db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(Number(info.lastInsertRowid)),
    };
  }

  const info = db
    .prepare(
      `INSERT INTO email_notifications (
        student_id, sequence_number, recipient_email, recipient_name, subject, body,
        delivery_status, attempt_count, max_retries, triggered_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`
    )
    .run(
      student.id,
      sequenceNumber,
      targetEmail,
      student.student_name,
      subject,
      body,
      maxRetries,
      actorUser?.id ?? null
    );

  const emailRecord = await attemptEmailDelivery(Number(info.lastInsertRowid), db);
  return { duplicatePrevented: false, skippedNoEmail: false, emailRecord };
}

async function resendEmailNotification(emailId, adminUser, db = getDb()) {
  const existing = db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(emailId);
  if (!existing) throw new Error('Email notification not found');
  if (!isValidEmail(existing.recipient_email)) {
    // Re-check student email in case it was updated since
    const student = db.prepare('SELECT email FROM students WHERE id = ?').get(existing.student_id);
    if (student && isValidEmail(student.email)) {
      db.prepare(`UPDATE email_notifications SET recipient_email = ? WHERE id = ?`).run(student.email.trim(), emailId);
    } else {
      throw new Error('Cannot resend: student has no valid email address on record');
    }
  }

  db.prepare(
    `UPDATE email_notifications
     SET delivery_status = 'PENDING', attempt_count = 0, last_error = NULL, next_retry_at = NULL, updated_at = datetime('now')
     WHERE id = ?`
  ).run(emailId);

  logAudit(
    {
      user: adminUser,
      action: 'EMAIL_RESEND_REQUESTED',
      entityType: 'email_notification',
      entityId: emailId,
    },
    db
  );

  return attemptEmailDelivery(emailId, db);
}

async function processPendingEmailRetries(db = getDb()) {
  const due = db
    .prepare(
      `SELECT id FROM email_notifications
       WHERE delivery_status = 'RETRYING'
         AND (next_retry_at IS NULL OR next_retry_at <= datetime('now'))`
    )
    .all();

  const results = [];
  for (const row of due) {
    results.push(await attemptEmailDelivery(row.id, db));
  }
  return results;
}

function listEmailNotifications({ status = '', limit = 100 } = {}, db = getDb()) {
  const where = [];
  const params = [];
  if (status) {
    where.push('e.delivery_status = ?');
    params.push(status);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT e.*, s.registration_number, s.student_name, s.district, s.institution_name, s.communication_status
       FROM email_notifications e
       JOIN students s ON s.id = e.student_id
       ${whereClause}
       ORDER BY e.updated_at DESC, e.id DESC
       LIMIT ?`
    )
    .all(...params, Number(limit));
}

async function sendAutoEmailToUnattendedStudents(actorUser = null, db = getDb()) {
  const unattended = db
    .prepare(
      `SELECT id FROM students
       WHERE (
         last_call_outcome IN ('No Answer', 'Not Reachable', 'Switched Off', 'Busy', 'Temporary Unavailable', 'Call Disconnected')
         OR communication_status IN ('Attempt 1 Completed', 'Pending Second Call', 'Attempt 2 Completed', 'Pending Third Call', 'Attempt 3 Completed')
       )
       AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')
       AND email_notified_sequence < COALESCE(NULLIF(three_attempt_sequence_id, 0), 1)`
    )
    .all();

  const summary = {
    processedCount: unattended.length,
    sentCount: 0,
    skippedNoEmailCount: 0,
    failedCount: 0,
    duplicateCount: 0,
  };

  for (const row of unattended) {
    const res = await triggerThreeAttemptEmail(row.id, actorUser, db);
    if (res.duplicatePrevented) summary.duplicateCount += 1;
    else if (res.skippedNoEmail) summary.skippedNoEmailCount += 1;
    else if (res.emailRecord?.delivery_status === 'SENT') summary.sentCount += 1;
    else summary.failedCount += 1;
  }

  logAudit(
    {
      user: actorUser,
      action: 'BULK_UNATTENDED_EMAIL_RUN',
      entityType: 'email_notification',
      details: summary,
    },
    db
  );

  return summary;
}

module.exports = {
  setCustomTransporter,
  buildUnattendedEmailBody,
  buildThreeAttemptEmailBody,
  sendGenericEmail,
  attemptEmailDelivery,
  triggerThreeAttemptEmail,
  sendAutoEmailToUnattendedStudents,
  resendEmailNotification,
  processPendingEmailRetries,
  listEmailNotifications,
};
