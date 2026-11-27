const { getDb, withTransaction, ensureStaffAndSplitUnuploaded } = require('./database');
const { hashPassword } = require('../utils/security');
const { isValidEmail } = require('../utils/security');
const { RECITATION_RECORDS, TAFSIR_RECORDS } = require('./pdfDataset');

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function seedDatabase(db = getDb(), { force = false } = {}) {
  const existingAdmin = db.prepare("SELECT COUNT(*) as c FROM users WHERE username = 'admin'").get().c;
  if (existingAdmin > 0 && !force) {
    return { seeded: false, reason: 'Database already populated' };
  }

  const result = withTransaction(db, () => {
    if (force) {
      db.exec(`
        DELETE FROM audit_logs;
        DELETE FROM notifications;
        DELETE FROM email_notifications;
        DELETE FROM call_attempts;
        DELETE FROM students;
        DELETE FROM institutions;
        DELETE FROM users;
      `);
    }

    const insertUser = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, phone, role, daily_target)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const users = [
      ['admin', hashPassword('Admin@2026'), 'State Admin (Kerala)', 'admin@ihqakerala.org', '', 'ADMIN', 0],
      ['supervisor', hashPassword('Supervisor@2026'), 'Kerala Supervisor', 'supervisor@ihqakerala.org', '', 'SUPERVISOR', 15],
      ['saeed_adany', hashPassword('Staff@2026'), 'Saeed Adany', 'saeed.adany@ihqakerala.org', '', 'CALLING_STAFF', 40],
      ['shahid_adany', hashPassword('Staff@2026'), 'Shahid Abdullah Adany', 'shahid.adany@ihqakerala.org', '', 'CALLING_STAFF', 40],
      ['usman_adany', hashPassword('Staff@2026'), 'Usman Adany', 'usman.adany@ihqakerala.org', '', 'CALLING_STAFF', 40],
      ['kashif', hashPassword('Staff@2026'), 'Kashif', 'kashif@ihqakerala.org', '', 'CALLING_STAFF', 45],
      ['salman', hashPassword('Staff@2026'), 'Salman', 'salman@ihqakerala.org', '', 'CALLING_STAFF', 45],
      ['suhail', hashPassword('Staff@2026'), 'Suhail', 'suhail@ihqakerala.org', '', 'CALLING_STAFF', 45],
    ];

    const userIds = {};
    for (const u of users) {
      const info = insertUser.run(...u);
      userIds[u[0]] = Number(info.lastInsertRowid);
    }
    const callerIds = [userIds.saeed_adany, userIds.shahid_adany, userIds.usman_adany];

    const insertInst = db.prepare(`
      INSERT INTO institutions (code, name, place, district, supervisor_name, supervisor_phone, supervisor_email, registered_students_count, winner_status, category_scope)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertStudent = db.prepare(`
      INSERT INTO students (
        registration_number, student_name, parent_name, student_mobile, parent_mobile, email,
        district, institution_id, institution_name, coordinator_name, coordinator_mobile, coordinator_email,
        exam_category, assigned_staff_id, assigned_at, communication_status, valid_attempt_count,
        last_call_outcome, last_called_at, next_followup_at, manual_followup_required,
        invalid_number_flagged, three_attempt_sequence_id, email_notified_sequence, notes_summary
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, 0, 0, 1, 0, ?)
    `);

    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const instCache = new Map();
    let instCounter = 0;
    let studentCounter = 0;

    function ensureInstitution(rec, categoryScope) {
      const [name, place, district, supName, supPhone, supEmail, count, winnerStatus] = rec;
      const key = `${name.trim().toLowerCase()}|${place.trim().toLowerCase()}|${supPhone.trim()}`;
      if (instCache.has(key)) {
        return instCache.get(key);
      }
      instCounter += 1;
      const code = `IHQA-INST-${String(instCounter).padStart(3, '0')}`;
      const info = insertInst.run(
        code,
        name.trim(),
        place.trim(),
        district.trim(),
        supName.trim(),
        supPhone.trim(),
        supEmail.trim(),
        Number(count || 0),
        winnerStatus.trim(),
        categoryScope
      );
      const id = Number(info.lastInsertRowid);
      instCache.set(key, id);
      return id;
    }

    function insertPdfRecord(rec, category, prefix, staffId) {
      const [instName, place, district, supName, supPhone, supEmail, totalInstStudents, winnerStatus, studentName] = rec;
      const instId = ensureInstitution(rec, category);
      studentCounter += 1;
      const regNo = `IHQA-${prefix}-${String(studentCounter).padStart(3, '0')}`;
      const validEmail = isValidEmail(supEmail) ? supEmail.trim() : null;
      const notes = `${place.trim()} · ${winnerStatus.trim()} · Institution students: ${totalInstStudents}`;

      insertStudent.run(
        regNo,
        studentName.trim(),
        '', // No parent name in PDF reports
        null, // No separate student mobile in PDF reports
        null, // No separate parent mobile in PDF reports
        validEmail,
        district.trim(),
        instId,
        instName.trim(),
        supName.trim(),
        supPhone.trim(),
        supEmail.trim(),
        category,
        staffId,
        nowIso,
        'Pending First Call',
        notes
      );
    }

    const shuffledQirath = shuffleArray(RECITATION_RECORDS);
    for (let i = 0; i < shuffledQirath.length; i += 1) {
      insertPdfRecord(shuffledQirath[i], 'Holy Quran Recitation', 'REC', callerIds[i % callerIds.length]);
    }

    const shuffledTafseer = shuffleArray(TAFSIR_RECORDS);
    for (let i = 0; i < shuffledTafseer.length; i += 1) {
      insertPdfRecord(
        shuffledTafseer[i],
        'Complete Memorization of the Holy Quran with Tafsir',
        'TAF',
        callerIds[(i + 1) % callerIds.length]
      );
    }

    return {
      seeded: true,
      users: users.length,
      institutions: instCounter,
      students: studentCounter,
      calls: 0,
    };
  });

  ensureStaffAndSplitUnuploaded(db);
  return result;
}

module.exports = {
  seedDatabase,
};
