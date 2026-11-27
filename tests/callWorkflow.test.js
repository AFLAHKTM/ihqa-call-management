const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { initDatabase, closeDb, setDb } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seedData');
const { logCallAttempt, assignStudents, undoLastCallAttempt } = require('../src/services/callWorkflowService');
const {
  setCustomTransporter,
  triggerThreeAttemptEmail,
  sendAutoEmailToUnattendedStudents,
  resendEmailNotification,
  processPendingEmailRetries,
} = require('../src/services/emailService');
const { runBackgroundSweep } = require('../src/services/jobScheduler');
const { EMAIL_SUBJECT_THREE_ATTEMPTS } = require('../src/constants');

describe('Three-Attempt Workflow, Email Notification & Follow-Up Rules', () => {
  let db;
  let adminUser;
  let staffUser;
  const sentMessages = [];

  beforeEach(() => {
    sentMessages.length = 0;
    db = initDatabase(':memory:');
    setDb(db);
    seedDatabase(db, { force: true });
    adminUser = db.prepare("SELECT * FROM users WHERE username = 'admin'").get();
    staffUser = db.prepare("SELECT * FROM users WHERE username = 'usman_adany'").get();

    setCustomTransporter({
      async sendMail(mail) {
        sentMessages.push(mail);
        return { messageId: `test-msg-${sentMessages.length}` };
      },
    });
  });

  afterEach(() => {
    setCustomTransporter(null);
    closeDb();
  });

  function createTestStudent({ reg, email = 'test.student@example.org', staffId = staffUser.id }) {
    const info = db
      .prepare(
        `INSERT INTO students (
          registration_number, student_name, parent_name, student_mobile, parent_mobile, email,
          district, institution_name, exam_category, assigned_staff_id, communication_status
        ) VALUES (?, 'Test Student Ali', 'Parent Ali', '+91 9847011111', '+91 9847022222', ?,
          'Malappuram East', 'MADIN PUBLIC SCHOOL', 'Holy Quran Recitation', ?, 'Pending First Call')`
      )
      .run(reg, email, staffId);
    return Number(info.lastInsertRowid);
  }

  it('does not count accidental clicks or failed initiations as valid attempts', async () => {
    const sid = createTestStudent({ reg: 'TEST-REG-001' });
    const res = await logCallAttempt(
      {
        studentId: sid,
        staffUser,
        isValidAttempt: false,
        remarks: 'Accidental click',
      },
      db
    );
    assert.equal(res.countedAsAttempt, false);
    assert.equal(res.student.valid_attempt_count, 0);
    assert.equal(res.student.communication_status, 'Pending First Call');
  });

  it('executes 3-attempt rule and sends personalized email once without duplicates', async () => {
    db.prepare("UPDATE system_settings SET value = '3' WHERE key = 'max_attempts'").run();
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    const sid = createTestStudent({ reg: 'TEST-REG-002', email: 'ali.family@example.org' });

    const r1 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer', remarks: 'Try 1' }, db);
    assert.equal(r1.student.valid_attempt_count, 1);
    assert.equal(r1.student.communication_status, 'Pending Second Call');
    assert.equal(sentMessages.length, 0);

    const r2 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Not Reachable', remarks: 'Try 2' }, db);
    assert.equal(r2.student.valid_attempt_count, 2);
    assert.equal(r2.student.communication_status, 'Pending Third Call');
    assert.equal(sentMessages.length, 0);

    const r3 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Switched Off', remarks: 'Try 3' }, db);
    assert.equal(r3.student.valid_attempt_count, 3);
    assert.equal(r3.student.communication_status, 'Email Notification Sent');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].from, 'India Holy Quran Award <info@indiaquranaward.com>');
    assert.equal(sentMessages[0].subject, EMAIL_SUBJECT_THREE_ATTEMPTS);
    assert.match(sentMessages[0].text, /Dear Usthad\/Institution Supervisor,/);

    // Duplicate automatic email check for same sequence
    const dupCheck = await triggerThreeAttemptEmail(sid, staffUser, db);
    assert.equal(dupCheck.duplicatePrevented, true);
    assert.equal(sentMessages.length, 1);
  });

  it('sends 3-attempt automail from info@indiaquranaward.com to mail of institution', async () => {
    db.prepare("UPDATE system_settings SET value = '3' WHERE key = 'max_attempts'").run();
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    const instInfo = db
      .prepare(
        `INSERT INTO institutions (name, district, supervisor_name, supervisor_email)
         VALUES ('DARUL HUDA ISLAMIC UNIVERSITY', 'Malappuram East', 'Dr. Bahauddeen Nadwi', 'principal@darulhuda.edu.in')`
      )
      .run();
    const instId = Number(instInfo.lastInsertRowid);

    const studInfo = db
      .prepare(
        `INSERT INTO students (
          registration_number, student_name, parent_name, email, coordinator_email,
          institution_id, institution_name, district, exam_category, assigned_staff_id, communication_status
        ) VALUES ('TEST-INST-001', 'Zayd Ahmed', 'Ahmed', 'zayd@personal.com', 'coordinator@darulhuda.edu.in',
          ?, 'DARUL HUDA ISLAMIC UNIVERSITY', 'Malappuram East', 'Holy Quran Recitation', ?, 'Pending First Call')`
      )
      .run(instId, staffUser.id);
    const sid = Number(studInfo.lastInsertRowid);

    sentMessages.length = 0;
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Switched Off' }, db);
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Not Reachable' }, db);
    const r3 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Busy' }, db);

    assert.equal(r3.student.valid_attempt_count, 3);
    assert.equal(r3.student.communication_status, 'Email Notification Sent');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].from, 'India Holy Quran Award <info@indiaquranaward.com>');
    assert.equal(sentMessages[0].to, 'principal@darulhuda.edu.in');
    assert.match(sentMessages[0].text, /Dear Usthad\/Institution Supervisor,/);
    assert.match(sentMessages[0].text, /Kerala State Competition Dates: November 30 – December 3, 2026\./);
    assert.match(sentMessages[0].text, /info@indiaquranaward\.com/);
  });

  it('stops unreachable workflow on successful contact', async () => {
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    const sid = createTestStudent({ reg: 'TEST-REG-003' });
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    const r2 = await logCallAttempt(
      { studentId: sid, staffUser, callOutcome: 'Parent Contacted', remarks: 'Confirmed participation' },
      db
    );
    assert.equal(r2.student.communication_status, 'Successfully Contacted');
    assert.equal(r2.student.next_followup_at, null);
    assert.equal(sentMessages.length, 0);
  });

  it('flags invalid / wrong numbers for correction without counting as unreachable attempt', async () => {
    const sid = createTestStudent({ reg: 'TEST-REG-004' });
    const res = await logCallAttempt(
      { studentId: sid, staffUser, callOutcome: 'Invalid / Wrong Number', remarks: 'Wrong number' },
      db
    );
    assert.equal(res.student.valid_attempt_count, 0);
    assert.equal(res.student.invalid_number_flagged, 1);
    assert.equal(res.student.manual_followup_required, 1);
    assert.equal(res.student.communication_status, 'Number Correction Required');
  });

  it('schedules callback and sends reminder notification to assigned staff', async () => {
    const sid = createTestStudent({ reg: 'TEST-REG-005' });
    const res = await logCallAttempt(
      {
        studentId: sid,
        staffUser,
        callOutcome: 'Callback Requested',
        followupDate: '2026-11-27 17:00:00',
        remarks: 'Parent requested another call tomorrow.',
      },
      db
    );
    assert.equal(res.student.communication_status, 'Callback Scheduled');
    assert.equal(res.student.next_followup_at, '2026-11-27 17:00:00');
    const notif = db
      .prepare("SELECT * FROM notifications WHERE student_id = ? AND type = 'CALLBACK_REQUESTED'")
      .get(sid);
    assert.ok(notif);
    assert.equal(notif.target_user_id, staffUser.id);
  });

  it('does not send email when no valid email exists and flags manual follow-up', async () => {
    const sid = createTestStudent({ reg: 'TEST-REG-006', email: null });
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Busy' }, db);
    const r3 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Switched Off' }, db);

    assert.equal(r3.student.communication_status, 'Attempt 3 Completed');
    assert.equal(r3.student.manual_followup_required, 1);
    assert.equal(sentMessages.length, 0);
    const emailRow = db.prepare('SELECT * FROM email_notifications WHERE student_id = ?').get(sid);
    assert.equal(emailRow.delivery_status, 'SKIPPED_NO_EMAIL');
  });

  it('retries temporary email failures and supports admin resend', async () => {
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    let failMode = true;
    setCustomTransporter({
      async sendMail(mail) {
        if (failMode) throw new Error('Simulated 421 temporary failure');
        sentMessages.push(mail);
        return { messageId: 'recovered-1' };
      },
    });

    const sid = createTestStudent({ reg: 'TEST-REG-007', email: 'retry.test@example.org' });
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);

    let emailRow = db.prepare('SELECT * FROM email_notifications WHERE student_id = ?').get(sid);
    assert.equal(emailRow.delivery_status, 'RETRYING');

    // Simulate retries exhausting -> FAILED
    db.prepare("UPDATE email_notifications SET next_retry_at = datetime('now', '-1 minute') WHERE id = ?").run(emailRow.id);
    await processPendingEmailRetries(db);
    db.prepare("UPDATE email_notifications SET next_retry_at = datetime('now', '-1 minute') WHERE id = ?").run(emailRow.id);
    await processPendingEmailRetries(db);

    emailRow = db.prepare('SELECT * FROM email_notifications WHERE id = ?').get(emailRow.id);
    assert.equal(emailRow.delivery_status, 'FAILED');

    // Admin resends after SMTP recovers
    failMode = false;
    const resent = await resendEmailNotification(emailRow.id, adminUser, db);
    assert.equal(resent.delivery_status, 'SENT');
    const updatedStudent = db.prepare('SELECT * FROM students WHERE id = ?').get(sid);
    assert.equal(updatedStudent.communication_status, 'Email Notification Sent');
  });

  it('respects configurable max_attempts threshold and background overdue sweep', async () => {
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    db.prepare("UPDATE system_settings SET value = '2' WHERE key = 'max_attempts'").run();
    const sid = createTestStudent({ reg: 'TEST-REG-008', email: 'two.attempts@example.org' });
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    const r2 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Not Reachable' }, db);
    assert.equal(r2.student.communication_status, 'Email Notification Sent');
    assert.equal(sentMessages.length, 1);

    // Create an overdue callback student to verify background sweep creates supervisor alert
    const overdueSid = createTestStudent({ reg: 'TEST-REG-008B' });
    db.prepare(
      "UPDATE students SET communication_status = 'Callback Scheduled', next_followup_at = datetime('now', '-2 hours') WHERE id = ?"
    ).run(overdueSid);

    const sweep = await runBackgroundSweep(db);
    assert.ok(sweep.overdueAlertsCreated >= 1);
  });

  it('assigns students and notifies target staff member', () => {
    const sid = createTestStudent({ reg: 'TEST-REG-009', staffId: null });
    const targetStaff = db.prepare("SELECT * FROM users WHERE username = 'saeed_adany'").get();
    const res = assignStudents({ studentIds: [sid], staffId: targetStaff.id, assignedByUser: adminUser }, db);
    assert.equal(res.updatedCount, 1);
    const st = db.prepare('SELECT * FROM students WHERE id = ?').get(sid);
    assert.equal(st.assigned_staff_id, targetStaff.id);
    assert.equal(st.communication_status, 'Pending First Call');
  });

  it('supports immediate auto-mail on unattended call and bulk unattended email sweep', async () => {
    db.prepare("UPDATE system_settings SET value = 'true' WHERE key = 'auto_email_on_unattended'").run();
    const sid1 = createTestStudent({ reg: 'TEST-REG-010', email: 'unattended1@example.org' });
    const r1 = await logCallAttempt({ studentId: sid1, staffUser, callOutcome: 'No Answer' }, db);
    assert.equal(r1.student.communication_status, 'Pending Second Call');
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /India Holy Quran Award 2026–27/);

    // Bulk sweep skips already-emailed sid1 and emails sid2
    db.prepare("UPDATE system_settings SET value = 'false' WHERE key = 'auto_email_on_unattended'").run();
    const sid2 = createTestStudent({ reg: 'TEST-REG-011', email: 'unattended2@example.org' });
    await logCallAttempt({ studentId: sid2, staffUser, callOutcome: 'Not Reachable' }, db);
    assert.equal(sentMessages.length, 1);

    const bulk = await sendAutoEmailToUnattendedStudents(adminUser, db);
    assert.equal(bulk.sentCount, 1);
    assert.equal(sentMessages.length, 2);
  });

  it('reverts attended call and restores previous pending state via undo', async () => {
    const sid = createTestStudent({ reg: 'TEST-UNDO-001', email: 'undo@example.org' });
    const initial = db.prepare('SELECT * FROM students WHERE id = ?').get(sid);
    assert.equal(initial.communication_status, 'Pending First Call');
    assert.equal(initial.valid_attempt_count, 0);

    // Mark as attended
    await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Successfully Contacted' }, db);
    const attended = db.prepare('SELECT * FROM students WHERE id = ?').get(sid);
    assert.equal(attended.communication_status, 'Successfully Contacted');
    assert.equal(attended.valid_attempt_count, 1);

    // Undo the attended call
    const undone = undoLastCallAttempt(sid, staffUser, db);
    assert.equal(undone.communication_status, 'Pending First Call');
    assert.equal(undone.valid_attempt_count, 0);
    assert.equal(undone.last_call_outcome, null);

    // Call history for the student should have 0 valid attempts
    const attempts = db.prepare('SELECT * FROM call_attempts WHERE student_id = ?').all(sid);
    assert.equal(attempts.length, 0);
  });

  it('sends official email automatically after 2 unattended attempts by default', async () => {
    const sid = createTestStudent({ reg: 'TEST-2ATT-001', email: 'two.unattend@example.org' });
    const r1 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'No Answer' }, db);
    assert.equal(r1.student.valid_attempt_count, 1);
    assert.equal(r1.student.communication_status, 'Pending Second Call');
    assert.equal(sentMessages.length, 0);

    const r2 = await logCallAttempt({ studentId: sid, staffUser, callOutcome: 'Switched Off' }, db);
    assert.equal(r2.student.valid_attempt_count, 2);
    assert.equal(r2.student.communication_status, 'Email Notification Sent');
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].from, 'India Holy Quran Award <info@indiaquranaward.com>');
    assert.equal(sentMessages[0].to, 'two.unattend@example.org');
  });
});
