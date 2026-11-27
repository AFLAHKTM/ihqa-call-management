const { getDb, getSettingsMap, withTransaction } = require('../db/database');
const {
  CALL_OUTCOMES,
  COMMUNICATION_STATUSES,
  SUCCESS_OUTCOMES,
  UNREACHABLE_OUTCOMES,
  INVALID_NUMBER_OUTCOMES,
  CALLBACK_OUTCOMES,
  NOTIFICATION_TYPES,
  ROLES,
} = require('../constants');
const { logAudit } = require('./auditService');
const { dispatchNotification } = require('./notificationService');
const { triggerThreeAttemptEmail } = require('./emailService');

function getStudentById(studentId, db = getDb()) {
  return db
    .prepare(
      `SELECT s.*, u.full_name as assigned_staff_name, u.username as assigned_staff_username
       FROM students s
       LEFT JOIN users u ON u.id = s.assigned_staff_id
       WHERE s.id = ?`
    )
    .get(studentId);
}

function getStudentCallHistory(studentId, db = getDb()) {
  return db
    .prepare(
      `SELECT c.*, u.full_name as staff_name, u.username as staff_username
       FROM call_attempts c
       JOIN users u ON u.id = c.staff_id
       WHERE c.student_id = ?
       ORDER BY c.called_at DESC, c.id DESC`
    )
    .all(studentId);
}

function getStudentEmails(studentId, db = getDb()) {
  return db
    .prepare(
      `SELECT * FROM email_notifications WHERE student_id = ? ORDER BY id DESC`
    )
    .all(studentId);
}

function listStudents(filters = {}, user = null, db = getDb()) {
  const where = [];
  const params = [];

  if (user && user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(user.id);
  } else if (filters.assignedStaffId) {
    if (filters.assignedStaffId === 'unassigned') {
      where.push('s.assigned_staff_id IS NULL');
    } else {
      where.push('s.assigned_staff_id = ?');
      params.push(Number(filters.assignedStaffId));
    }
  }

  if (filters.district) {
    where.push('s.district = ?');
    params.push(filters.district);
  }
  if (filters.examCategory) {
    where.push('s.exam_category = ?');
    params.push(filters.examCategory);
  }
  if (filters.institution) {
    where.push('s.institution_name LIKE ?');
    params.push(`%${filters.institution.trim()}%`);
  }
  if (filters.studentName) {
    where.push('s.student_name LIKE ?');
    params.push(`%${filters.studentName.trim()}%`);
  }
  if (filters.registrationNumber) {
    where.push('s.registration_number LIKE ?');
    params.push(`%${filters.registrationNumber.trim()}%`);
  }
  if (filters.callStatus) {
    if (filters.callStatus === 'UNATTENDED') {
      where.push("s.valid_attempt_count >= 1 AND s.communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')");
    } else {
      // Support matching either overall communication_status or last_call_outcome
      where.push('(s.communication_status = ? OR s.last_call_outcome = ?)');
      params.push(filters.callStatus, filters.callStatus);
    }
  }
  if (filters.attemptCount !== undefined && filters.attemptCount !== '' && filters.attemptCount !== null) {
    where.push('s.valid_attempt_count = ?');
    params.push(Number(filters.attemptCount));
  }
  if (filters.dateFrom) {
    where.push("date(COALESCE(s.last_called_at, s.created_at)) >= date(?)");
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    where.push("date(COALESCE(s.last_called_at, s.created_at)) <= date(?)");
    params.push(filters.dateTo);
  }
  if (filters.search) {
    const q = `%${filters.search.trim()}%`;
    where.push(
      '(s.student_name LIKE ? OR s.registration_number LIKE ? OR s.institution_name LIKE ? OR s.district LIKE ? OR s.coordinator_name LIKE ? OR s.coordinator_mobile LIKE ? OR s.student_mobile LIKE ? OR s.parent_mobile LIKE ?)'
    );
    params.push(q, q, q, q, q, q, q, q);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Number(filters.limit || 500), 2000);
  const offset = Number(filters.offset || 0);

  const rows = db
    .prepare(
      `SELECT s.*,
              u.full_name as assigned_staff_name,
              u.username as assigned_staff_username,
              i.place as institution_place,
              i.registered_students_count as institution_students_count,
              i.winner_status as institution_winner_status
       FROM students s
       LEFT JOIN users u ON u.id = s.assigned_staff_id
       LEFT JOIN institutions i ON i.id = s.institution_id
       ${whereClause}
       ORDER BY
         CASE
           WHEN s.registration_number LIKE 'IHQA-TAF-%' THEN 0
           WHEN s.registration_number LIKE 'IHQA-QIR-%' THEN 1
           ELSE 2
         END,
         CASE
           WHEN s.registration_number LIKE 'IHQA-TAF-%' OR s.registration_number LIKE 'IHQA-QIR-%'
             THEN CAST(SUBSTR(s.registration_number, 10) AS INTEGER)
           ELSE 999999
         END ASC,
         s.institution_name ASC,
         s.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);

  const total = db
    .prepare(`SELECT COUNT(*) as total FROM students s ${whereClause}`)
    .get(...params).total;

  return { rows, total };
}

function assignStudents({ studentIds, staffId, assignedByUser }, db = getDb()) {
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    throw new Error('At least one studentId is required');
  }

  let staff = null;
  if (staffId !== null && staffId !== '' && staffId !== undefined) {
    staff = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(Number(staffId));
    if (!staff) throw new Error('Assigned calling staff user not found or inactive');
  }

  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const updatedIds = withTransaction(db, () => {
    const stmt = db.prepare(`
      UPDATE students
      SET assigned_staff_id = ?,
          assigned_at = ?,
          communication_status = CASE
            WHEN ? IS NULL THEN 'Not Assigned'
            WHEN communication_status = 'Not Assigned' THEN 'Pending First Call'
            ELSE communication_status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `);

    const changed = [];
    for (const sid of studentIds) {
      const idNum = Number(sid);
      stmt.run(staff ? staff.id : null, staff ? nowIso : null, staff ? staff.id : null, idNum);
      changed.push(idNum);
    }

    logAudit(
      {
        user: assignedByUser,
        action: staff ? 'STUDENTS_ASSIGNED' : 'STUDENTS_UNASSIGNED',
        entityType: 'student',
        entityId: changed.join(','),
        details: { staffId: staff ? staff.id : null, staffName: staff ? staff.full_name : null, count: changed.length },
      },
      db
    );

    return changed;
  });

  if (staff) {
    dispatchNotification(
      {
        type: NOTIFICATION_TYPES.NEW_STUDENT_ASSIGNMENT,
        title: 'New Student Contacts Assigned',
        message: `${updatedIds.length} student contact(s) assigned to you for calling by ${assignedByUser.full_name}.`,
        severity: 'info',
        targetUserId: staff.id,
        targetRole: staff.role,
        studentId: updatedIds.length === 1 ? updatedIds[0] : null,
      },
      db
    );
  }

  return { updatedCount: updatedIds.length, staffId: staff ? staff.id : null };
}

function fisherYatesShuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function shuffleBySection(
  { section = 'both', staffIds = [], onlyPending = true, assignedByUser },
  db = getDb()
) {
  let targetStaff = [];
  if (Array.isArray(staffIds) && staffIds.length > 0) {
    const placeholders = staffIds.map(() => '?').join(',');
    targetStaff = db
      .prepare(`SELECT id, full_name, role FROM users WHERE id IN (${placeholders}) AND is_active = 1`)
      .all(...staffIds.map(Number));
  } else {
    targetStaff = db
      .prepare("SELECT id, full_name, role FROM users WHERE role = 'CALLING_STAFF' AND is_active = 1 ORDER BY id ASC")
      .all();
  }

  if (targetStaff.length === 0) {
    throw new Error('Select at least one active calling staff member');
  }

  const categories = [];
  if (section === 'qirath' || section === 'Holy Quran Recitation') {
    categories.push('Holy Quran Recitation');
  } else if (section === 'tafseer' || section === 'Complete Memorization of the Holy Quran with Tafsir') {
    categories.push('Complete Memorization of the Holy Quran with Tafsir');
  } else {
    categories.push('Holy Quran Recitation', 'Complete Memorization of the Holy Quran with Tafsir');
  }

  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const staffCounts = new Map(targetStaff.map((s) => [s.id, 0]));
  let totalShuffled = 0;

  withTransaction(db, () => {
    const updateStmt = db.prepare(`
      UPDATE students
      SET assigned_staff_id = ?,
          assigned_at = ?,
          communication_status = CASE
            WHEN communication_status = 'Not Assigned' THEN 'Pending First Call'
            ELSE communication_status
          END,
          updated_at = datetime('now')
      WHERE id = ?
    `);

    const pendingFilter = onlyPending
      ? "AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')"
      : '';

    let staffOffset = 0;
    for (const cat of categories) {
      const ids = db
        .prepare(`SELECT id FROM students WHERE exam_category = ? ${pendingFilter}`)
        .all(cat)
        .map((r) => r.id);

      const shuffledIds = fisherYatesShuffle(ids);
      for (let i = 0; i < shuffledIds.length; i += 1) {
        const staff = targetStaff[(i + staffOffset) % targetStaff.length];
        updateStmt.run(staff.id, nowIso, shuffledIds[i]);
        staffCounts.set(staff.id, (staffCounts.get(staff.id) || 0) + 1);
        totalShuffled += 1;
      }
      staffOffset = (staffOffset + 1) % targetStaff.length;
    }

    logAudit(
      {
        user: assignedByUser,
        action: 'STUDENTS_SHUFFLED_BY_SECTION',
        entityType: 'student',
        entityId: categories.join(','),
        details: {
          section,
          onlyPending,
          totalShuffled,
          distribution: targetStaff.map((s) => ({ id: s.id, name: s.full_name, count: staffCounts.get(s.id) || 0 })),
        },
      },
      db
    );
  });

  for (const staff of targetStaff) {
    const count = staffCounts.get(staff.id) || 0;
    if (count > 0) {
      dispatchNotification(
        {
          type: NOTIFICATION_TYPES.NEW_STUDENT_ASSIGNMENT,
          title: 'Section Contacts Shuffled & Assigned',
          message: `${count} contact(s) (${section.toUpperCase()}) shuffled and assigned to you by ${assignedByUser.full_name}.`,
          severity: 'info',
          targetUserId: staff.id,
          targetRole: staff.role,
        },
        db
      );
    }
  }

  return {
    totalShuffled,
    section,
    distribution: targetStaff.map((s) => ({
      id: s.id,
      full_name: s.full_name,
      assignedCount: staffCounts.get(s.id) || 0,
    })),
  };
}

function computeNextEstablishmentFollowup(retryHours = 4, startHour = 9, endHour = 18) {
  const istOffsetMs = 5.5 * 3600 * 1000;
  const candidateUtcMs = Date.now() + Number(retryHours || 4) * 3600 * 1000;
  const candidateIst = new Date(candidateUtcMs + istOffsetMs);
  const istHour = candidateIst.getUTCHours();

  let finalUtcMs = candidateUtcMs;
  if (istHour < startHour) {
    // Schedule for today at startHour:30 IST
    const morningIst = new Date(candidateIst);
    morningIst.setUTCHours(startHour, 30, 0, 0);
    finalUtcMs = morningIst.getTime() - istOffsetMs;
  } else if (istHour >= endHour) {
    // Past office closing hour -> next morning at startHour:30 IST
    const nextMorningIst = new Date(candidateIst);
    nextMorningIst.setUTCDate(nextMorningIst.getUTCDate() + 1);
    nextMorningIst.setUTCHours(startHour, 30, 0, 0);
    finalUtcMs = nextMorningIst.getTime() - istOffsetMs;
  }

  return new Date(finalUtcMs).toISOString().slice(0, 19).replace('T', ' ');
}

async function logCallAttempt(
  {
    studentId,
    staffUser,
    callSessionId = null,
    contactType = 'student',
    contactNumberCalled = null,
    callOutcome,
    callDurationSeconds = null,
    followupDate = null,
    remarks = '',
    isValidAttempt = true,
    markFollowupCompleted = false,
    initiationMode = 'manual',
  },
  db = getDb()
) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) throw new Error('Student not found');

  // RBAC guard: Calling staff can only log calls for students assigned to them
  if (staffUser.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== staffUser.id) {
    const err = new Error('Forbidden: student is not assigned to this calling staff member');
    err.statusCode = 403;
    throw err;
  }

  if (isValidAttempt && !CALL_OUTCOMES.includes(callOutcome)) {
    throw new Error(`Invalid call outcome: ${callOutcome}`);
  }

  let resolvedNumber = contactNumberCalled;
  if (!resolvedNumber) {
    if (contactType === 'parent') resolvedNumber = student.parent_mobile;
    else if (contactType === 'coordinator') resolvedNumber = student.coordinator_mobile;
    else resolvedNumber = student.student_mobile;
  }
  if (!resolvedNumber) {
    resolvedNumber = student.student_mobile || student.parent_mobile || student.coordinator_mobile || 'N/A';
  }

  const settings = getSettingsMap(db);
  const maxAttempts = Math.max(1, Number(settings.max_attempts || 3));
  const autoEmailEnabled = settings.auto_email_on_max_attempts !== 'false';
  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const txResult = withTransaction(db, () => {
    // Handle accidental click or failed call initiation -> never counts as valid attempt
    if (!isValidAttempt) {
      if (callSessionId) {
        db.prepare(
          `UPDATE call_attempts
           SET is_valid_attempt = 0,
               attempt_number = NULL,
               telephony_status = 'failed_or_cancelled',
               call_outcome = ?,
               remarks = ?,
               called_at = ?
           WHERE id = ? AND student_id = ?`
        ).run(callOutcome || 'Cancelled / Failed Initiation', remarks || 'Accidental click or failed initiation', nowIso, callSessionId, studentId);
      } else {
        db.prepare(
          `INSERT INTO call_attempts (
            student_id, staff_id, attempt_number, is_valid_attempt, initiation_mode,
            telephony_status, contact_type, contact_number_called, call_outcome, remarks, called_at
          ) VALUES (?, ?, NULL, 0, ?, 'failed_or_cancelled', ?, ?, ?, ?, ?)`
        ).run(
          studentId,
          staffUser.id,
          initiationMode,
          contactType,
          resolvedNumber,
          callOutcome || 'Cancelled / Failed Initiation',
          remarks || 'Accidental click or failed initiation',
          nowIso
        );
      }

      logAudit(
        {
          user: staffUser,
          action: 'CALL_INITIATION_CANCELLED',
          entityType: 'student',
          entityId: studentId,
          details: { callSessionId, remarks },
        },
        db
      );

      return {
        countedAsAttempt: false,
        shouldTriggerEmail: false,
        student: getStudentById(studentId, db),
      };
    }

    // Valid call attempt logging
    let attemptNumber = null;
    let newValidCount = student.valid_attempt_count;
    let nextStatus = student.communication_status;
    let nextFollowupAt = followupDate || null;
    let invalidFlag = student.invalid_number_flagged;
    let manualFollowup = student.manual_followup_required;
    let shouldTriggerEmail = false;
    let notificationToDispatch = null;

    if (INVALID_NUMBER_OUTCOMES.has(callOutcome)) {
      // Section F: Wrong numbers flagged for correction instead of ordinary unreachable attempt
      attemptNumber = null;
      invalidFlag = 1;
      manualFollowup = 1;
      nextFollowupAt = null;
      nextStatus = 'Number Correction Required';
      notificationToDispatch = {
        type: NOTIFICATION_TYPES.INVALID_NUMBER,
        title: 'Invalid Phone Number Flagged',
        message: `${student.student_name} (${student.registration_number}) number ${resolvedNumber} marked Invalid / Wrong Number for correction.`,
        severity: 'warning',
        targetRole: 'SUPERVISOR',
        studentId,
      };
    } else if (SUCCESS_OUTCOMES.has(callOutcome)) {
      newValidCount += 1;
      attemptNumber = newValidCount;
      invalidFlag = 0;
      manualFollowup = 0;
      nextFollowupAt = null;
      nextStatus = markFollowupCompleted ? 'Follow-up Completed' : 'Successfully Contacted';
      notificationToDispatch = {
        type: NOTIFICATION_TYPES.SUCCESSFUL_CONTACT,
        title: 'Student / Parent Contacted',
        message: `${student.student_name} (${student.registration_number}) reached (${callOutcome}) by ${staffUser.full_name}.`,
        severity: 'success',
        targetRole: 'SUPERVISOR',
        studentId,
      };
    } else if (callOutcome === 'Not Interested') {
      newValidCount += 1;
      attemptNumber = newValidCount;
      nextFollowupAt = null;
      manualFollowup = 0;
      nextStatus = 'Follow-up Completed';
    } else if (CALLBACK_OUTCOMES.has(callOutcome)) {
      newValidCount += 1;
      attemptNumber = newValidCount;
      nextStatus = 'Callback Scheduled';
      if (!nextFollowupAt) {
        nextFollowupAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      }
      notificationToDispatch = {
        type: NOTIFICATION_TYPES.CALLBACK_REQUESTED,
        title: 'Callback Scheduled',
        message: `Callback requested for ${student.student_name} (${student.registration_number}) on ${nextFollowupAt}.`,
        severity: 'info',
        targetUserId: student.assigned_staff_id || staffUser.id,
        targetRole: 'CALLING_STAFF',
        studentId,
      };
    } else {
      // Unreachable outcomes (No Answer, Not Reachable, Switched Off, Busy, Call Disconnected, Other)
      newValidCount += 1;
      attemptNumber = newValidCount;

      if (newValidCount >= maxAttempts) {
        nextStatus = 'Attempt 3 Completed';
        nextFollowupAt = null;
        if (autoEmailEnabled && student.email_notified_sequence < (student.three_attempt_sequence_id || 1)) {
          shouldTriggerEmail = true;
        }
      } else if (newValidCount === 1) {
        if (!nextFollowupAt) {
          nextFollowupAt = computeNextEstablishmentFollowup(
            Number(settings.retry_interval_hours || 4),
            Number(settings.establishment_start_hour || 9),
            Number(settings.establishment_end_hour || 18)
          );
        }
        nextStatus = 'Pending Second Call';
        if (
          settings.auto_email_on_unattended === 'true' &&
          UNREACHABLE_OUTCOMES.has(callOutcome) &&
          student.email_notified_sequence < (student.three_attempt_sequence_id || 1)
        ) {
          shouldTriggerEmail = true;
        }
      } else if (newValidCount === 2) {
        if (!nextFollowupAt) {
          nextFollowupAt = computeNextEstablishmentFollowup(
            Number(settings.retry_interval_hours || 4),
            Number(settings.establishment_start_hour || 9),
            Number(settings.establishment_end_hour || 18)
          );
        }
        nextStatus = 'Pending Third Call';
        if (
          settings.auto_email_on_unattended === 'true' &&
          UNREACHABLE_OUTCOMES.has(callOutcome) &&
          student.email_notified_sequence < (student.three_attempt_sequence_id || 1)
        ) {
          shouldTriggerEmail = true;
        }
      } else {
        nextStatus = `Pending Follow-up`;
        if (!COMMUNICATION_STATUSES.includes(nextStatus)) {
          nextStatus = 'Attempt 2 Completed';
        }
      }
    }

    const seqId = student.three_attempt_sequence_id || 1;
    let callRecordId;

    if (callSessionId) {
      db.prepare(
        `UPDATE call_attempts
         SET attempt_number = ?,
             is_valid_attempt = 1,
             telephony_status = COALESCE(NULLIF(telephony_status, 'initiated'), 'completed'),
             contact_type = ?,
             contact_number_called = ?,
             call_outcome = ?,
             call_duration_seconds = COALESCE(?, call_duration_seconds),
             followup_date = ?,
             remarks = ?,
             called_at = ?
         WHERE id = ? AND student_id = ?`
      ).run(
        attemptNumber,
        contactType,
        resolvedNumber,
        callOutcome,
        callDurationSeconds !== null && callDurationSeconds !== '' ? Number(callDurationSeconds) : null,
        nextFollowupAt,
        remarks || '',
        nowIso,
        callSessionId,
        studentId
      );
      callRecordId = callSessionId;
    } else {
      const info = db
        .prepare(
          `INSERT INTO call_attempts (
            student_id, staff_id, attempt_number, is_valid_attempt, initiation_mode,
            telephony_status, contact_type, contact_number_called, call_outcome,
            call_duration_seconds, followup_date, remarks, called_at
          ) VALUES (?, ?, ?, 1, ?, 'logged', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          studentId,
          staffUser.id,
          attemptNumber,
          initiationMode,
          contactType,
          resolvedNumber,
          callOutcome,
          callDurationSeconds !== null && callDurationSeconds !== '' ? Number(callDurationSeconds) : null,
          nextFollowupAt,
          remarks || '',
          nowIso
        );
      callRecordId = Number(info.lastInsertRowid);
    }

    db.prepare(
      `UPDATE students
       SET communication_status = ?,
           valid_attempt_count = ?,
           last_call_outcome = ?,
           last_called_at = ?,
           next_followup_at = ?,
           invalid_number_flagged = ?,
           manual_followup_required = ?,
           three_attempt_sequence_id = ?,
           notes_summary = CASE WHEN ? != '' THEN ? ELSE notes_summary END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      nextStatus,
      newValidCount,
      callOutcome,
      nowIso,
      nextFollowupAt,
      invalidFlag,
      manualFollowup,
      seqId,
      (remarks || '').trim(),
      (remarks || '').trim(),
      studentId
    );

    logAudit(
      {
        user: staffUser,
        action: 'CALL_OUTCOME_LOGGED',
        entityType: 'call_attempt',
        entityId: callRecordId,
        details: {
          studentId,
          attemptNumber,
          callOutcome,
          newStatus: nextStatus,
          validAttemptCount: newValidCount,
        },
      },
      db
    );

    return {
      countedAsAttempt: true,
      callRecordId,
      shouldTriggerEmail,
      notificationToDispatch,
    };
  });

  if (txResult.notificationToDispatch) {
    dispatchNotification(txResult.notificationToDispatch, db);
  }

  let emailResult = null;
  if (txResult.shouldTriggerEmail) {
    emailResult = await triggerThreeAttemptEmail(studentId, staffUser, db);
    if (emailResult && !emailResult.skippedNoEmail && emailResult.emailRecord?.delivery_status === 'SENT') {
      dispatchNotification(
        {
          type: NOTIFICATION_TYPES.THREE_UNSUCCESSFUL_CALLS,
          title: 'Three-Attempt Email Sent',
          message: `Automatic 3-attempt contact notice emailed for ${student.student_name} (${student.registration_number}).`,
          severity: 'info',
          targetRole: 'ADMIN',
          studentId,
        },
        db
      );
    }
  }

  return {
    countedAsAttempt: txResult.countedAsAttempt,
    callRecordId: txResult.callRecordId || null,
    emailResult,
    student: getStudentById(studentId, db),
    history: getStudentCallHistory(studentId, db),
  };
}

function updateStudentContactAndStatus(studentId, updates, actorUser, db = getDb()) {
  const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!existing) throw new Error('Student not found');

  if (actorUser.role === ROLES.CALLING_STAFF && existing.assigned_staff_id !== actorUser.id) {
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }

  const allowedStatus = updates.communicationStatus;
  if (allowedStatus && !COMMUNICATION_STATUSES.includes(allowedStatus)) {
    throw new Error(`Invalid communication status: ${allowedStatus}`);
  }

  const nextMobile = updates.studentMobile !== undefined ? updates.studentMobile : existing.student_mobile;
  const nextParentMobile = updates.parentMobile !== undefined ? updates.parentMobile : existing.parent_mobile;
  const nextEmail = updates.email !== undefined ? updates.email : existing.email;
  const nextFollowup = updates.nextFollowupAt !== undefined ? updates.nextFollowupAt : existing.next_followup_at;

  let nextStatus = allowedStatus || existing.communication_status;
  let invalidFlag = existing.invalid_number_flagged;
  let manualFollowup = existing.manual_followup_required;

  // If invalid number was corrected by admin/supervisor, reset invalid flag and return to pending call
  if (updates.resetInvalidFlag) {
    invalidFlag = 0;
    manualFollowup = 0;
    if (existing.communication_status === 'Number Correction Required' && !allowedStatus) {
      nextStatus = existing.assigned_staff_id ? 'Pending First Call' : 'Not Assigned';
    }
  }

  if (updates.markFollowupCompleted) {
    nextStatus = 'Follow-up Completed';
    manualFollowup = 0;
  }

  db.prepare(
    `UPDATE students
     SET student_mobile = ?,
         parent_mobile = ?,
         email = ?,
         next_followup_at = ?,
         communication_status = ?,
         invalid_number_flagged = ?,
         manual_followup_required = ?,
         updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    nextMobile,
    nextParentMobile,
    nextEmail,
    updates.markFollowupCompleted ? null : nextFollowup,
    nextStatus,
    invalidFlag,
    manualFollowup,
    studentId
  );

  logAudit(
    {
      user: actorUser,
      action: 'STUDENT_RECORD_UPDATED',
      entityType: 'student',
      entityId: studentId,
      details: updates,
    },
    db
  );

  return getStudentById(studentId, db);
}

function undoLastCallAttempt(studentId, actorUser = null, db = getDb()) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) throw new Error('Student not found');

  return withTransaction(db, () => {
    // Find the latest valid call attempt
    const latestAttempt = db
      .prepare(
        `SELECT * FROM call_attempts
         WHERE student_id = ? AND is_valid_attempt = 1
         ORDER BY id DESC LIMIT 1`
      )
      .get(studentId);

    if (!latestAttempt) {
      throw new Error('No call attempt to undo for this student');
    }

    // Delete the latest call attempt
    db.prepare('DELETE FROM call_attempts WHERE id = ?').run(latestAttempt.id);

    // If an email notification was queued/sent for this specific 3-attempt sequence, revert it
    if (student.valid_attempt_count >= 3 && student.communication_status === 'Email Notification Sent') {
      db.prepare(
        `DELETE FROM email_notifications
         WHERE student_id = ? AND sequence_number = ?`
      ).run(studentId, student.three_attempt_sequence_id || 1);
    }

    // Query remaining valid call attempts
    const remaining = db
      .prepare(
        `SELECT * FROM call_attempts
         WHERE student_id = ? AND is_valid_attempt = 1
         ORDER BY id DESC`
      )
      .all(studentId);

    const newValidCount = remaining.length;
    let newStatus;
    let lastOutcome = null;
    let lastCalledAt = null;
    let nextFollowupAt = null;

    if (newValidCount === 0) {
      newStatus = student.assigned_staff_id ? 'Pending First Call' : 'Not Assigned';
      lastOutcome = null;
      lastCalledAt = null;
      nextFollowupAt = null;
    } else {
      const last = remaining[0];
      lastOutcome = last.call_outcome;
      lastCalledAt = last.called_at;
      nextFollowupAt = last.followup_date;

      if (SUCCESS_OUTCOMES.has(lastOutcome)) {
        newStatus = 'Successfully Contacted';
      } else if (newValidCount === 1) {
        newStatus = 'Pending Second Call';
      } else if (newValidCount === 2) {
        newStatus = 'Pending Third Call';
      } else {
        newStatus = 'Attempt 3 Completed';
      }
    }

    db.prepare(
      `UPDATE students
       SET communication_status = ?,
           valid_attempt_count = ?,
           last_call_outcome = ?,
           last_called_at = ?,
           next_followup_at = ?,
           manual_followup_required = 0,
           email_notified_sequence = CASE WHEN ? = 0 THEN 0 ELSE email_notified_sequence END,
           updated_at = datetime('now')
       WHERE id = ?`
    ).run(newStatus, newValidCount, lastOutcome, lastCalledAt, nextFollowupAt, newValidCount, studentId);

    logAudit(
      {
        user: actorUser,
        action: 'CALL_ATTEMPT_UNDONE',
        entityType: 'student',
        entityId: studentId,
        details: {
          deletedAttemptId: latestAttempt.id,
          undoneOutcome: latestAttempt.call_outcome,
          restoredStatus: newStatus,
          restoredValidCount: newValidCount,
        },
      },
      db
    );

    return getStudentById(studentId, db);
  });
}

module.exports = {
  getStudentById,
  getStudentCallHistory,
  getStudentEmails,
  listStudents,
  assignStudents,
  shuffleBySection,
  logCallAttempt,
  undoLastCallAttempt,
  updateStudentContactAndStatus,
};
