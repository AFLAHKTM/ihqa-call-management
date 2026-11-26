const { getDb, getSettingsMap } = require('../db/database');
const { NOTIFICATION_TYPES } = require('../constants');
const { dispatchNotification } = require('./notificationService');
const { processPendingEmailRetries } = require('./emailService');
const { logAudit } = require('./auditService');

let timerHandle = null;

async function runBackgroundSweep(db = getDb()) {
  const summary = {
    overdueAlertsCreated: 0,
    emailRetriesProcessed: 0,
    anonymizedRecords: 0,
  };

  // 1. Overdue Follow-up Sweep -> Supervisor notifications
  const overdueStudents = db
    .prepare(
      `SELECT id, registration_number, student_name, next_followup_at
       FROM students
       WHERE next_followup_at IS NOT NULL
         AND next_followup_at < datetime('now')
         AND communication_status IN ('Pending Second Call', 'Pending Third Call', 'Callback Scheduled')
         AND id NOT IN (
           SELECT COALESCE(student_id, -1) FROM notifications
           WHERE type = ? AND date(created_at) = date('now')
         )`
    )
    .all(NOTIFICATION_TYPES.FOLLOWUP_OVERDUE);

  for (const st of overdueStudents) {
    dispatchNotification(
      {
        type: NOTIFICATION_TYPES.FOLLOWUP_OVERDUE,
        title: 'Follow-up Overdue',
        message: `Follow-up for ${st.student_name} (${st.registration_number}) was due at ${st.next_followup_at}.`,
        severity: 'warning',
        targetRole: 'SUPERVISOR',
        studentId: st.id,
      },
      db
    );
    summary.overdueAlertsCreated += 1;
  }

  // 2. Email Retry Queue Processing
  const retried = await processPendingEmailRetries(db);
  summary.emailRetriesProcessed = retried.length;

  // 3. Data retention enforcement (Section M)
  const settings = getSettingsMap(db);
  const retentionDays = Math.max(30, Number(settings.data_retention_days || 365));
  const oldCompleted = db
    .prepare(
      `SELECT id FROM students
       WHERE is_anonymized = 0
         AND communication_status = 'Follow-up Completed'
         AND updated_at < datetime('now', ?)`
    )
    .all(`-${retentionDays} days`);

  for (const row of oldCompleted) {
    db.prepare(
      `UPDATE students
       SET student_mobile = '[RETENTION-PURGED]',
           parent_mobile = '[RETENTION-PURGED]',
           email = NULL,
           is_anonymized = 1,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(row.id);
    summary.anonymizedRecords += 1;
  }

  if (summary.anonymizedRecords > 0) {
    logAudit(
      {
        action: 'DATA_RETENTION_PURGE',
        entityType: 'student',
        details: { count: summary.anonymizedRecords, retentionDays },
      },
      db
    );
  }

  return summary;
}

function startScheduler(intervalMs = 60000) {
  if (timerHandle) return;
  timerHandle = setInterval(() => {
    runBackgroundSweep().catch((err) => {
      console.error('Background sweep error:', err.message);
    });
  }, intervalMs);
  if (timerHandle.unref) timerHandle.unref();
}

function stopScheduler() {
  if (timerHandle) {
    clearInterval(timerHandle);
    timerHandle = null;
  }
}

module.exports = {
  runBackgroundSweep,
  startScheduler,
  stopScheduler,
};
