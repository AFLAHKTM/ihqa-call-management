const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { ROLES } = require('../constants');
const {
  listStudents,
  getStudentById,
  getStudentCallHistory,
  getStudentEmails,
  assignStudents,
  shuffleBySection,
  logCallAttempt,
  undoLastCallAttempt,
  updateStudentContactAndStatus,
} = require('../services/callWorkflowService');
const { initiateClickToCall } = require('../services/telephonyService');
const { triggerThreeAttemptEmail } = require('../services/emailService');
const { logAudit } = require('../services/auditService');
const { reportToCsv, reportToExcelXml } = require('../services/reportService');
const PDFDocument = require('pdfkit');

const router = express.Router();

router.use(requireAuth);

function sortRowsByDisplayNumber(rows) {
  const getNum = (r) => {
    const m = String(r.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  };
  return rows.sort((a, b) => {
    const diff = getNum(a) - getNum(b);
    return diff !== 0 ? diff : Number(a.id) - Number(b.id);
  });
}

router.get('/', (req, res) => {
  const result = listStudents(req.query, req.user, getDb());
  res.json(result);
});

router.get('/approved-dated', (req, res) => {
  const db = getDb();
  const { search = '', district = '', staffId = '' } = req.query;

  const where = [
    "s.communication_status IN ('Successfully Contacted', 'Follow-up Completed')",
    "u.username IN ('shahid_adany', 'usman_adany', 'saeed_adany', 'unais_adany')",
  ];
  const params = [];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    where.push('s.assigned_staff_id = ?');
    params.push(Number(staffId));
  }

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      '(s.institution_name LIKE ? OR s.student_name LIKE ? OR s.district LIKE ? OR s.coordinator_name LIKE ? OR s.coordinator_mobile LIKE ? OR s.student_mobile LIKE ?)'
    );
    params.push(q, q, q, q, q, q);
  }
  if (district) {
    where.push('s.district = ?');
    params.push(district);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = sortRowsByDisplayNumber(
    db
      .prepare(
        `SELECT s.*,
                u.full_name AS assigned_staff_name,
                u.username AS assigned_staff_username,
                i.place AS institution_place,
                i.winner_status AS institution_winner_status
         FROM students s
         JOIN users u ON u.id = s.assigned_staff_id
         LEFT JOIN institutions i ON i.id = s.institution_id
         ${whereSql}`
      )
      .all(...params)
  );

  const baseWhere =
    req.user.role === ROLES.CALLING_STAFF
      ? "WHERE s.communication_status IN ('Successfully Contacted', 'Follow-up Completed') AND s.assigned_staff_id = ?"
      : "WHERE s.communication_status IN ('Successfully Contacted', 'Follow-up Completed') AND u.username IN ('shahid_adany', 'usman_adany', 'saeed_adany', 'unais_adany')";
  const baseParams = req.user.role === ROLES.CALLING_STAFF ? [req.user.id] : [];

  const orderRank = { shahid_adany: 1, usman_adany: 2, saeed_adany: 3, unais_adany: 4 };
  const staffBreakdown = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, COUNT(s.id) AS count
       FROM students s
       JOIN users u ON u.id = s.assigned_staff_id
       ${baseWhere}
       GROUP BY u.id, u.username, u.full_name`
    )
    .all(...baseParams)
    .sort((a, b) => (orderRank[a.username] || 99) - (orderRank[b.username] || 99));

  const overallTotal = staffBreakdown.reduce((acc, r) => acc + r.count, 0);

  const districts = db
    .prepare(
      `SELECT DISTINCT s.district
       FROM students s
       JOIN users u ON u.id = s.assigned_staff_id
       ${baseWhere}
       ORDER BY s.district ASC`
    )
    .all(...baseParams)
    .map((r) => r.district);

  res.json({
    rows,
    total: rows.length,
    overallTotal,
    districts,
    staffBreakdown,
  });
});

// ── Scheduled-day export (CSV / Excel) ───────────────────────────────────────
router.get('/scheduled-day/export', (req, res) => {
  const db = getDb();
  const { day = '', format = 'csv', search = '', district = '', staffId = '' } = req.query;
  if (!['Monday', 'Tuesday'].includes(day)) {
    return res.status(400).json({ error: 'day must be Monday or Tuesday' });
  }

  const where = ['s.scheduled_call_day = ?'];
  const params = [day];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    where.push('s.assigned_staff_id = ?');
    params.push(Number(staffId));
  }

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      '(s.institution_name LIKE ? OR s.student_name LIKE ? OR s.district LIKE ? OR s.coordinator_name LIKE ? OR s.coordinator_mobile LIKE ?)'
    );
    params.push(q, q, q, q, q);
  }
  if (district) {
    where.push('s.district = ?');
    params.push(district);
  }

  const rows = db
    .prepare(
      `SELECT s.registration_number, s.institution_name, i.place AS institution_place,
              s.district, s.coordinator_name, s.coordinator_mobile, s.coordinator_email,
              s.exam_category, s.student_name, u.full_name AS assigned_staff_name,
              s.last_called_at, s.scheduled_call_day
       FROM students s
       LEFT JOIN users u ON u.id = s.assigned_staff_id
       LEFT JOIN institutions i ON i.id = s.institution_id
       WHERE ${where.join(' AND ')}`
    )
    .all(...params);

  const columns = [
    '#', 'Reg No', 'Institution', 'Place', 'District',
    'Supervisor', 'Phone', 'Email', 'Category', 'Winner',
    'Handled By', 'Approved Date', 'Scheduled Day',
  ];

  const reportRows = rows.map((s, idx) => {
    const pdfMatch = String(s.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
    const displayNo = pdfMatch ? Number(pdfMatch[1]) : idx + 1;
    return {
      '#': displayNo,
      'Reg No': s.registration_number || '',
      'Institution': s.institution_name || '',
      'Place': s.institution_place || '',
      'District': s.district || '',
      'Supervisor': s.coordinator_name || '',
      'Phone': s.coordinator_mobile || '',
      'Email': s.coordinator_email || '',
      'Category': s.exam_category || '',
      'Winner': s.student_name || '',
      'Handled By': s.assigned_staff_name || '',
      'Approved Date': s.last_called_at || '',
      'Scheduled Day': s.scheduled_call_day || '',
    };
  });

  const safeName = `Call_for_${day}`;
  const report = { title: safeName, columns, rows: reportRows };

  if (format === 'excel') {
    const xml = reportToExcelXml(report);
    res.setHeader('Content-Type', 'application/vnd.ms-excel');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xls"`);
    return res.send(xml);
  }

  // default CSV
  const csv = reportToCsv(report);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
  return res.send(csv);
});

// ── Scheduled-day PDF export (A4) ────────────────────────────────────────────
router.get('/scheduled-day/pdf', (req, res) => {
  const db = getDb();
  const { day = '', search = '', district = '', staffId = '' } = req.query;
  if (!['Monday', 'Tuesday'].includes(day)) {
    return res.status(400).json({ error: 'day must be Monday or Tuesday' });
  }

  const where = ['s.scheduled_call_day = ?'];
  const params = [day];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    where.push('s.assigned_staff_id = ?');
    params.push(Number(staffId));
  }
  if (search) {
    const q = `%${search.trim()}%`;
    where.push('(s.institution_name LIKE ? OR s.student_name LIKE ? OR s.district LIKE ? OR s.coordinator_name LIKE ? OR s.coordinator_mobile LIKE ?)');
    params.push(q, q, q, q, q);
  }
  if (district) {
    where.push('s.district = ?');
    params.push(district);
  }

  const rows = db.prepare(
    `SELECT s.registration_number, s.institution_name, i.place AS institution_place,
            s.district, s.coordinator_name, s.coordinator_mobile, s.coordinator_email,
            s.exam_category, s.student_name, u.full_name AS assigned_staff_name,
            s.last_called_at, s.scheduled_call_day
     FROM students s
     LEFT JOIN users u ON u.id = s.assigned_staff_id
     LEFT JOIN institutions i ON i.id = s.institution_id
     WHERE ${where.join(' AND ')}`
  ).all(...params);

  const safeName = `Call_for_${day}`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);

  // A4: 595.28 x 841.89 pt — landscape for more columns
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 28, autoFirstPage: true });
  doc.pipe(res);

  const W = 841.89 - 56; // usable width in landscape
  const H = 595.28;
  const marginL = 28;
  const marginT = 28;

  // ── Header ────────────────────────────────────────────────────────────────
  doc.rect(marginL, marginT, W, 36).fill('#0f5132');
  doc.fillColor('#ffffff').fontSize(13).font('Helvetica-Bold')
    .text('India Holy Quran Award 2026–27 — Kerala Initial Screening', marginL + 8, marginT + 6, { width: W - 180, lineBreak: false });
  doc.fontSize(10).font('Helvetica')
    .text(`Call for ${day} — Scheduled Establishments`, marginL + 8, marginT + 22, { width: W - 180, lineBreak: false });

  // right: total + date
  const generatedStr = `Total: ${rows.length}  |  Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}`;
  doc.fillColor('#d1fae5').fontSize(8).font('Helvetica')
    .text(generatedStr, marginL + W - 200, marginT + 14, { width: 196, align: 'right', lineBreak: false });

  // ── Column definitions ────────────────────────────────────────────────────
  const cols = [
    { label: '#',          key: 'num',           w: 22 },
    { label: 'Reg No',     key: 'reg',           w: 62 },
    { label: 'Institution',key: 'inst',          w: 118 },
    { label: 'Place',      key: 'place',         w: 60 },
    { label: 'District',   key: 'district',      w: 60 },
    { label: 'Supervisor', key: 'sup',           w: 80 },
    { label: 'Phone',      key: 'phone',         w: 72 },
    { label: 'Email',      key: 'email',         w: 110 },
    { label: 'Category',   key: 'cat',           w: 85 },
    { label: 'Winner',     key: 'winner',        w: 80 },
    { label: 'Handled By', key: 'staff',         w: 65 },
    { label: 'Approved',   key: 'approved',      w: 72 },
  ];
  // Stretch last column to fill remaining width
  const usedW = cols.reduce((s, c) => s + c.w, 0);
  cols[cols.length - 1].w += (W - usedW);

  const rowH = 22;
  const headerH = 18;
  let y = marginT + 36 + 4;

  const drawTableHeader = () => {
    let x = marginL;
    doc.rect(marginL, y, W, headerH).fill('#1a6b41');
    cols.forEach(col => {
      doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold')
        .text(col.label, x + 2, y + 5, { width: col.w - 4, lineBreak: false, ellipsis: true });
      x += col.w;
    });
    y += headerH;
  };

  drawTableHeader();

  let rowIdx = 0;
  rows.forEach((s) => {
    const pdfMatch = String(s.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
    const displayNo = pdfMatch ? Number(pdfMatch[1]) : rowIdx + 1;

    // Estimate row height needed (institution name can wrap)
    const instText = s.institution_name || '';
    const approvedStr = s.last_called_at
      ? new Date(s.last_called_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';

    // Check if we need a new page
    if (y + rowH > H - marginT) {
      doc.addPage();
      y = marginT;
      drawTableHeader();
    }

    // Row background (alternating)
    const bgColor = rowIdx % 2 === 0 ? '#f0fdf4' : '#ffffff';
    doc.rect(marginL, y, W, rowH).fill(bgColor);

    // Cell borders (bottom line only)
    doc.moveTo(marginL, y + rowH).lineTo(marginL + W, y + rowH).strokeColor('#d1d5db').lineWidth(0.3).stroke();

    // Draw cells
    let x = marginL;
    const cellData = [
      String(displayNo),
      s.registration_number || '',
      instText,
      s.institution_place || '',
      s.district || '',
      s.coordinator_name || '',
      s.coordinator_mobile || '',
      s.coordinator_email || '',
      s.exam_category || '',
      s.student_name || '',
      s.assigned_staff_name || '',
      approvedStr,
    ];

    cellData.forEach((text, i) => {
      const col = cols[i];
      doc.fillColor('#111827').fontSize(6.5).font('Helvetica')
        .text(String(text), x + 2, y + 7, {
          width: col.w - 4,
          height: rowH - 7,
          lineBreak: false,
          ellipsis: true,
        });
      // vertical separator
      doc.moveTo(x + col.w, y).lineTo(x + col.w, y + rowH).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
      x += col.w;
    });

    y += rowH;
    rowIdx++;
  });

  // Footer on each page
  const totalPages = doc.bufferedPageRange ? doc.bufferedPageRange().count : 1;
  for (let i = 0; i < doc._pageBuffer?.length || 0; i++) {
    // pdfkit doesn't easily support retroactive footer — skip for now
  }

  doc.end();
});

router.get('/scheduled-day', (req, res) => {
  const db = getDb();
  const { day = '', search = '', district = '', staffId = '' } = req.query;
  if (!['Monday', 'Tuesday'].includes(day)) {
    return res.status(400).json({ error: 'day must be Monday or Tuesday' });
  }

  const where = ['s.scheduled_call_day = ?'];
  const params = [day];

  if (req.user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(req.user.id);
  } else if (staffId) {
    where.push('s.assigned_staff_id = ?');
    params.push(Number(staffId));
  }

  if (search) {
    const q = `%${search.trim()}%`;
    where.push(
      '(s.institution_name LIKE ? OR s.student_name LIKE ? OR s.district LIKE ? OR s.coordinator_name LIKE ? OR s.coordinator_mobile LIKE ? OR s.student_mobile LIKE ?)'
    );
    params.push(q, q, q, q, q, q);
  }
  if (district) {
    where.push('s.district = ?');
    params.push(district);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const rows = sortRowsByDisplayNumber(
    db
      .prepare(
        `SELECT s.*,
                u.full_name AS assigned_staff_name,
                u.username AS assigned_staff_username,
                i.place AS institution_place,
                i.winner_status AS institution_winner_status
         FROM students s
         LEFT JOIN users u ON u.id = s.assigned_staff_id
         LEFT JOIN institutions i ON i.id = s.institution_id
         ${whereSql}`
      )
      .all(...params)
  );

  const baseWhere =
    req.user.role === ROLES.CALLING_STAFF
      ? 'WHERE s.scheduled_call_day = ? AND s.assigned_staff_id = ?'
      : 'WHERE s.scheduled_call_day = ?';
  const baseParams = req.user.role === ROLES.CALLING_STAFF ? [day, req.user.id] : [day];

  const orderRank = { shahid_adany: 1, usman_adany: 2, saeed_adany: 3, unais_adany: 4 };
  const staffBreakdown = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, COUNT(s.id) AS count
       FROM students s
       JOIN users u ON u.id = s.assigned_staff_id
       ${baseWhere}
       GROUP BY u.id, u.username, u.full_name`
    )
    .all(...baseParams)
    .sort((a, b) => (orderRank[a.username] || 99) - (orderRank[b.username] || 99));

  const overallTotal = db
    .prepare(`SELECT COUNT(*) AS cnt FROM students s ${baseWhere}`)
    .get(...baseParams).cnt;

  const districts = db
    .prepare(
      `SELECT DISTINCT s.district
       FROM students s
       ${baseWhere}
       ORDER BY s.district ASC`
    )
    .all(...baseParams)
    .map((r) => r.district);

  res.json({
    day,
    rows,
    total: rows.length,
    overallTotal,
    districts,
    staffBreakdown,
  });
});

router.post('/:id/transfer-day', (req, res) => {
  const db = getDb();
  const studentId = Number(req.params.id);
  const rawDay = req.body?.day;
  const day = rawDay === null || rawDay === '' ? null : String(rawDay);

  if (day !== null && day !== 'Monday' && day !== 'Tuesday') {
    return res.status(400).json({ error: 'day must be Monday, Tuesday, or null' });
  }

  const student = db.prepare('SELECT id, assigned_staff_id, institution_name FROM students WHERE id = ?').get(studentId);
  if (!student) {
    return res.status(404).json({ error: 'Student / establishment not found' });
  }
  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  db.prepare(`UPDATE students SET scheduled_call_day = ?, updated_at = datetime('now') WHERE id = ?`).run(
    day,
    studentId
  );

  logAudit(
    {
      actorUserId: req.user.id,
      action: day ? 'TRANSFER_CALL_DAY' : 'CLEAR_CALL_DAY',
      entityType: 'student',
      entityId: studentId,
      details: { institutionName: student.institution_name, scheduledCallDay: day },
    },
    db
  );

  const countWhere =
    req.user.role === ROLES.CALLING_STAFF ? 'AND assigned_staff_id = ?' : '';
  const countParams = req.user.role === ROLES.CALLING_STAFF ? [req.user.id] : [];
  const mondayCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM students WHERE scheduled_call_day = 'Monday' ${countWhere}`)
    .get(...countParams).cnt;
  const tuesdayCount = db
    .prepare(`SELECT COUNT(*) AS cnt FROM students WHERE scheduled_call_day = 'Tuesday' ${countWhere}`)
    .get(...countParams).cnt;

  res.json({ ok: true, id: studentId, scheduled_call_day: day, mondayCount, tuesdayCount });
});

router.post('/', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  const {
    registrationNumber,
    studentName,
    parentName,
    studentMobile,
    parentMobile,
    email,
    district,
    institutionName,
    coordinatorName,
    coordinatorMobile,
    coordinatorEmail,
    examCategory,
    assignedStaffId,
  } = req.body || {};

  if (!registrationNumber || !studentName || !parentName || !district || !institutionName || !examCategory) {
    return res.status(400).json({
      error: 'registrationNumber, studentName, parentName, district, institutionName, and examCategory are required',
    });
  }

  const db = getDb();
  const status = assignedStaffId ? 'Pending First Call' : 'Not Assigned';
  try {
    const info = db
      .prepare(
        `INSERT INTO students (
          registration_number, student_name, parent_name, student_mobile, parent_mobile, email,
          district, institution_name, coordinator_name, coordinator_mobile, coordinator_email,
          exam_category, assigned_staff_id, assigned_at, communication_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') ELSE NULL END, ?)`
      )
      .run(
        String(registrationNumber).trim(),
        String(studentName).trim(),
        String(parentName).trim(),
        studentMobile || null,
        parentMobile || null,
        email || null,
        district,
        institutionName,
        coordinatorName || null,
        coordinatorMobile || null,
        coordinatorEmail || null,
        examCategory,
        assignedStaffId ? Number(assignedStaffId) : null,
        assignedStaffId ? Number(assignedStaffId) : null,
        status
      );

    const created = getStudentById(Number(info.lastInsertRowid), db);
    logAudit(
      {
        user: req.user,
        action: 'STUDENT_CREATED',
        entityType: 'student',
        entityId: created.id,
        details: { registrationNumber: created.registration_number },
        ipAddress: req.ip,
      },
      db
    );
    res.status(201).json({ student: created });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Registration number already exists' });
    }
    return res.status(400).json({ error: err.message });
  }
});

router.post('/assign', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  try {
    const { studentIds, staffId } = req.body || {};
    const result = assignStudents({ studentIds, staffId, assignedByUser: req.user }, getDb());
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/shuffle-by-section', requireRole(ROLES.ADMIN, ROLES.SUPERVISOR), (req, res) => {
  try {
    const { section = 'both', staffIds = [], onlyPending = true } = req.body || {};
    const result = shuffleBySection(
      { section, staffIds, onlyPending, assignedByUser: req.user },
      getDb()
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: you can only view students assigned to you' });
  }

  const history = getStudentCallHistory(student.id, db);
  const emails = getStudentEmails(student.id, db);

  logAudit(
    {
      user: req.user,
      action: 'STUDENT_RECORD_VIEWED',
      entityType: 'student',
      entityId: student.id,
      ipAddress: req.ip,
    },
    db
  );

  res.json({ student, history, emails });
});

router.patch('/:id', (req, res) => {
  try {
    const updated = updateStudentContactAndStatus(Number(req.params.id), req.body || {}, req.user, getDb());
    res.json({ student: updated });
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/:id/click-to-call', async (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden: you can only initiate calls for students assigned to you' });
  }

  try {
    const { contactType = 'student', mode = 'telephony_api' } = req.body || {};
    const result = await initiateClickToCall(
      { studentId: student.id, contactType, mode, staffUser: req.user },
      db
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/calls', async (req, res) => {
  try {
    const result = await logCallAttempt(
      {
        studentId: Number(req.params.id),
        staffUser: req.user,
        callSessionId: req.body?.callSessionId || null,
        contactType: req.body?.contactType || 'student',
        contactNumberCalled: req.body?.contactNumberCalled || null,
        callOutcome: req.body?.callOutcome,
        callDurationSeconds: req.body?.callDurationSeconds ?? null,
        followupDate: req.body?.followupDate || null,
        remarks: req.body?.remarks || '',
        isValidAttempt: req.body?.isValidAttempt !== false,
        markFollowupCompleted: Boolean(req.body?.markFollowupCompleted),
        initiationMode: req.body?.initiationMode || 'manual',
      },
      getDb()
    );
    res.status(201).json(result);
  } catch (err) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

router.post('/:id/send-unattended-email', async (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await triggerThreeAttemptEmail(student.id, req.user, db);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/undo-calls', async (req, res) => {
  const db = getDb();
  const { studentIds } = req.body || {};
  if (!Array.isArray(studentIds) || studentIds.length === 0) {
    return res.status(400).json({ error: 'studentIds array is required' });
  }
  try {
    const results = [];
    for (const sid of studentIds) {
      const student = getStudentById(Number(sid), db);
      if (!student) continue;
      if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
        const sibling = student.institution_name
          ? db
              .prepare(
                'SELECT id FROM students WHERE institution_name = ? AND assigned_staff_id = ? LIMIT 1'
              )
              .get(student.institution_name, req.user.id)
          : null;
        if (!sibling) continue;
      }
      try {
        const updated = undoLastCallAttempt(Number(sid), req.user, db);
        results.push(updated);
      } catch (_) {
        // Gracefully ignore students that had no prior attempt in a batch
      }
    }
    res.json({ ok: true, count: results.length, students: results });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/calls/undo', async (req, res) => {
  const db = getDb();
  const student = getStudentById(Number(req.params.id), db);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  if (req.user.role === ROLES.CALLING_STAFF && student.assigned_staff_id !== req.user.id) {
    const sibling = student.institution_name
      ? db
          .prepare(
            'SELECT id FROM students WHERE institution_name = ? AND assigned_staff_id = ? LIMIT 1'
          )
          .get(student.institution_name, req.user.id)
      : null;
    if (!sibling) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  try {
    const updated = undoLastCallAttempt(Number(req.params.id), req.user, db);
    res.json({ ok: true, student: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
