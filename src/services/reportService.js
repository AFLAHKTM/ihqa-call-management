const { getDb } = require('../db/database');
const { ROLES } = require('../constants');

function getDashboardStats(filters = {}, user = null, db = getDb()) {
  const where = [];
  const params = [];

  if (user && user.role === ROLES.CALLING_STAFF) {
    where.push('s.assigned_staff_id = ?');
    params.push(user.id);
  } else if (filters.assignedStaffId) {
    where.push('s.assigned_staff_id = ?');
    params.push(Number(filters.assignedStaffId));
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

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const studentFilterSubquery = `SELECT id FROM students s ${whereClause}`;

  const totalStudents = db
    .prepare(`SELECT COUNT(*) as c FROM students s ${whereClause}`)
    .get(...params).c;

  const totalAssigned = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s ${whereClause ? `${whereClause} AND` : 'WHERE'} s.assigned_staff_id IS NOT NULL`
    )
    .get(...params).c;

  const totalCallsAttempted = db
    .prepare(
      `SELECT COUNT(*) as c FROM call_attempts
       WHERE is_valid_attempt = 1 AND student_id IN (${studentFilterSubquery})`
    )
    .get(...params).c;

  const successfullyContacted = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.communication_status IN ('Successfully Contacted', 'Follow-up Completed')`
    )
    .get(...params).c;

  const notReachable = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.last_call_outcome IN ('Not Reachable', 'Switched Off', 'Busy', 'Temporary Unavailable', 'Call Disconnected')`
    )
    .get(...params).c;

  const noAnswer = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.last_call_outcome = 'No Answer'`
    )
    .get(...params).c;

  const callbacksRequested = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.communication_status = 'Callback Scheduled'`
    )
    .get(...params).c;

  const wrongPhoneNumbers = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       (s.invalid_number_flagged = 1 OR s.communication_status = 'Number Correction Required')`
    )
    .get(...params).c;

  const followupPending = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.communication_status IN (
         'Pending First Call', 'Attempt 1 Completed', 'Pending Second Call',
         'Attempt 2 Completed', 'Pending Third Call', 'Callback Scheduled', 'Number Correction Required'
       ) OR s.manual_followup_required = 1`
    )
    .get(...params).c;

  const emailNotificationsSent = db
    .prepare(
      `SELECT COUNT(*) as c FROM email_notifications
       WHERE delivery_status = 'SENT' AND student_id IN (${studentFilterSubquery})`
    )
    .get(...params).c;

  const emailNotificationsFailed = db
    .prepare(
      `SELECT COUNT(*) as c FROM email_notifications
       WHERE delivery_status = 'FAILED' AND student_id IN (${studentFilterSubquery})`
    )
    .get(...params).c;

  const completedFollowups = db
    .prepare(
      `SELECT COUNT(*) as c FROM students s
       ${whereClause ? `${whereClause} AND` : 'WHERE'}
       s.communication_status = 'Follow-up Completed'`
    )
    .get(...params).c;

  return {
    totalStudents,
    totalStudentsAssigned: totalAssigned,
    totalCallsAttempted,
    successfullyContacted,
    notReachable,
    noAnswer,
    callbacksRequested,
    wrongPhoneNumbers,
    followupPending,
    emailNotificationsSent,
    emailNotificationsFailed,
    completedFollowups,
  };
}

function getStaffPerformance(user = null, db = getDb()) {
  const roleFilter = user && user.role === ROLES.CALLING_STAFF ? 'AND u.id = ?' : '';
  const params = user && user.role === ROLES.CALLING_STAFF ? [user.id] : [];

  const staffRows = db
    .prepare(
      `SELECT u.id, u.username, u.full_name, u.email, u.phone, u.role, u.daily_target, u.is_active
       FROM users u
       WHERE u.role IN ('CALLING_STAFF', 'SUPERVISOR') ${roleFilter}
       ORDER BY u.role ASC, u.full_name ASC`
    )
    .all(...params);

  return staffRows.map((staff) => {
    const assignedContacts = db
      .prepare('SELECT COUNT(*) as c FROM students WHERE assigned_staff_id = ?')
      .get(staff.id).c;

    const callsCompleted = db
      .prepare('SELECT COUNT(*) as c FROM call_attempts WHERE staff_id = ? AND is_valid_attempt = 1')
      .get(staff.id).c;

    const callsToday = db
      .prepare(
        "SELECT COUNT(*) as c FROM call_attempts WHERE staff_id = ? AND is_valid_attempt = 1 AND date(called_at) = date('now')"
      )
      .get(staff.id).c;

    const successfulContacts = db
      .prepare(
        `SELECT COUNT(*) as c FROM students
         WHERE assigned_staff_id = ? AND communication_status IN ('Successfully Contacted', 'Follow-up Completed')`
      )
      .get(staff.id).c;

    const unreachableContacts = db
      .prepare(
        `SELECT COUNT(*) as c FROM students
         WHERE assigned_staff_id = ? AND communication_status IN ('Attempt 1 Completed', 'Pending Second Call', 'Attempt 2 Completed', 'Pending Third Call', 'Attempt 3 Completed', 'Email Notification Sent')`
      )
      .get(staff.id).c;

    const pendingFollowups = db
      .prepare(
        `SELECT COUNT(*) as c FROM students
         WHERE assigned_staff_id = ? AND communication_status IN ('Pending First Call', 'Attempt 1 Completed', 'Pending Second Call', 'Attempt 2 Completed', 'Pending Third Call', 'Callback Scheduled', 'Number Correction Required')`
      )
      .get(staff.id).c;

    const threeAttemptCases = db
      .prepare(
        `SELECT COUNT(*) as c FROM students
         WHERE assigned_staff_id = ? AND valid_attempt_count >= 3 AND communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')`
      )
      .get(staff.id).c;

    const dailyCompletionPercentage =
      staff.daily_target > 0 ? Math.min(100, Math.round((callsToday / staff.daily_target) * 100)) : 0;

    return {
      ...staff,
      assignedContacts,
      callsCompleted,
      callsToday,
      successfulContacts,
      unreachableContacts,
      pendingFollowups,
      threeAttemptCases,
      dailyCompletionPercentage,
    };
  });
}

function generateReport(reportType, user = null, db = getDb()) {
  const staffFilter = user && user.role === ROLES.CALLING_STAFF ? 'AND s.assigned_staff_id = ?' : '';
  const staffParams = user && user.role === ROLES.CALLING_STAFF ? [user.id] : [];

  switch (reportType) {
    case 'district':
      return {
        title: 'District-wise Calling Report',
        columns: ['District', 'Total Students', 'Assigned', 'Total Calls', 'Successfully Contacted', 'Pending Follow-ups', '3-Attempt / Email Cases', 'Wrong Numbers'],
        rows: db
          .prepare(
            `SELECT
               s.district AS "District",
               COUNT(*) AS "Total Students",
               SUM(CASE WHEN s.assigned_staff_id IS NOT NULL THEN 1 ELSE 0 END) AS "Assigned",
               SUM(s.valid_attempt_count) AS "Total Calls",
               SUM(CASE WHEN s.communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS "Successfully Contacted",
               SUM(CASE WHEN s.communication_status IN ('Pending First Call','Attempt 1 Completed','Pending Second Call','Attempt 2 Completed','Pending Third Call','Callback Scheduled') THEN 1 ELSE 0 END) AS "Pending Follow-ups",
               SUM(CASE WHEN s.communication_status IN ('Attempt 3 Completed','Email Notification Sent') THEN 1 ELSE 0 END) AS "3-Attempt / Email Cases",
               SUM(CASE WHEN s.invalid_number_flagged = 1 THEN 1 ELSE 0 END) AS "Wrong Numbers"
             FROM students s
             WHERE 1=1 ${staffFilter}
             GROUP BY s.district
             ORDER BY s.district ASC`
          )
          .all(...staffParams),
      };

    case 'institution':
      return {
        title: 'Institution-wise Communication Report',
        columns: ['Institution', 'District', 'Coordinator', 'Coordinator Phone', 'Students', 'Contacted', 'Pending', 'Wrong Numbers'],
        rows: db
          .prepare(
            `SELECT
               s.institution_name AS "Institution",
               s.district AS "District",
               COALESCE(s.coordinator_name, '') AS "Coordinator",
               COALESCE(s.coordinator_mobile, '') AS "Coordinator Phone",
               COUNT(*) AS "Students",
               SUM(CASE WHEN s.communication_status IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS "Contacted",
               SUM(CASE WHEN s.communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed') THEN 1 ELSE 0 END) AS "Pending",
               SUM(CASE WHEN s.invalid_number_flagged = 1 THEN 1 ELSE 0 END) AS "Wrong Numbers"
             FROM students s
             WHERE 1=1 ${staffFilter}
             GROUP BY s.institution_name, s.district
             ORDER BY s.district ASC, s.institution_name ASC`
          )
          .all(...staffParams),
      };

    case 'staff': {
      const perf = getStaffPerformance(user, db);
      return {
        title: 'Staff-wise Performance Report',
        columns: ['Staff Name', 'Role', 'Daily Target', 'Assigned Contacts', 'Calls Completed', 'Calls Today', 'Successful Contacts', 'Unreachable Contacts', 'Pending Follow-ups', '3-Attempt Cases', 'Daily Completion %'],
        rows: perf.map((p) => ({
          'Staff Name': p.full_name,
          Role: p.role,
          'Daily Target': p.daily_target,
          'Assigned Contacts': p.assignedContacts,
          'Calls Completed': p.callsCompleted,
          'Calls Today': p.callsToday,
          'Successful Contacts': p.successfulContacts,
          'Unreachable Contacts': p.unreachableContacts,
          'Pending Follow-ups': p.pendingFollowups,
          '3-Attempt Cases': p.threeAttemptCases,
          'Daily Completion %': `${p.dailyCompletionPercentage}%`,
        })),
      };
    }

    case 'daily':
      return {
        title: 'Daily Call Completion Report',
        columns: ['Date', 'Total Valid Calls', 'Successful Outcomes', 'Callbacks Scheduled', 'Unreachable Attempts', 'Wrong Numbers'],
        rows: db
          .prepare(
            `SELECT
               date(c.called_at) AS "Date",
               COUNT(*) AS "Total Valid Calls",
               SUM(CASE WHEN c.call_outcome IN ('Successfully Contacted','Parent Contacted','Student Contacted','Information Communicated') THEN 1 ELSE 0 END) AS "Successful Outcomes",
               SUM(CASE WHEN c.call_outcome = 'Callback Requested' THEN 1 ELSE 0 END) AS "Callbacks Scheduled",
               SUM(CASE WHEN c.call_outcome IN ('No Answer','Not Reachable','Switched Off','Busy','Temporary Unavailable','Call Disconnected') THEN 1 ELSE 0 END) AS "Unreachable Attempts",
               SUM(CASE WHEN c.call_outcome = 'Invalid / Wrong Number' THEN 1 ELSE 0 END) AS "Wrong Numbers"
             FROM call_attempts c
             JOIN students s ON s.id = c.student_id
             WHERE c.is_valid_attempt = 1 ${staffFilter}
             GROUP BY date(c.called_at)
             ORDER BY date(c.called_at) DESC`
          )
          .all(...staffParams),
      };

    case 'three_attempt':
      return {
        title: 'Three-Attempt Unreachable Report',
        columns: ['Reg No', 'Student Name', 'District', 'Institution', 'Mobile', 'Email', 'Attempts', 'Status', 'Manual Follow-up'],
        rows: db
          .prepare(
            `SELECT
               s.registration_number AS "Reg No",
               s.student_name AS "Student Name",
               s.district AS "District",
               s.institution_name AS "Institution",
               COALESCE(s.student_mobile, '') AS "Mobile",
               COALESCE(s.email, '') AS "Email",
               s.valid_attempt_count AS "Attempts",
               s.communication_status AS "Status",
               CASE WHEN s.manual_followup_required = 1 THEN 'Yes' ELSE 'No' END AS "Manual Follow-up"
             FROM students s
             WHERE s.valid_attempt_count >= 3
               AND s.communication_status NOT IN ('Successfully Contacted', 'Follow-up Completed')
               ${staffFilter}
             ORDER BY s.updated_at DESC`
          )
          .all(...staffParams),
      };

    case 'email':
      return {
        title: 'Email Notification Report',
        columns: ['Reg No', 'Student Name', 'Recipient Email', 'Delivery Status', 'Attempts', 'Sent At', 'Last Error'],
        rows: db
          .prepare(
            `SELECT
               s.registration_number AS "Reg No",
               s.student_name AS "Student Name",
               COALESCE(e.recipient_email, 'No Email') AS "Recipient Email",
               e.delivery_status AS "Delivery Status",
               e.attempt_count AS "Attempts",
               COALESCE(e.sent_at, '') AS "Sent At",
               COALESCE(e.last_error, '') AS "Last Error"
             FROM email_notifications e
             JOIN students s ON s.id = e.student_id
             WHERE 1=1 ${staffFilter}
             ORDER BY e.id DESC`
          )
          .all(...staffParams),
      };

    case 'callbacks':
      return {
        title: 'Pending Callback Report',
        columns: ['Reg No', 'Student Name', 'District', 'Assigned Staff', 'Follow-up At', 'Overdue', 'Notes'],
        rows: db
          .prepare(
            `SELECT
               s.registration_number AS "Reg No",
               s.student_name AS "Student Name",
               s.district AS "District",
               COALESCE(u.full_name, 'Unassigned') AS "Assigned Staff",
               COALESCE(s.next_followup_at, '') AS "Follow-up At",
               CASE WHEN s.next_followup_at IS NOT NULL AND s.next_followup_at < datetime('now') THEN 'OVERDUE' ELSE 'Scheduled' END AS "Overdue",
               COALESCE(s.notes_summary, '') AS "Notes"
             FROM students s
             LEFT JOIN users u ON u.id = s.assigned_staff_id
             WHERE s.communication_status IN ('Callback Scheduled', 'Pending Second Call', 'Pending Third Call')
               ${staffFilter}
             ORDER BY s.next_followup_at ASC`
          )
          .all(...staffParams),
      };

    case 'invalid_contacts':
      return {
        title: 'Invalid Contact Report',
        columns: ['Reg No', 'Student Name', 'District', 'Institution', 'Student Mobile', 'Parent Mobile', 'Coordinator Phone', 'Notes'],
        rows: db
          .prepare(
            `SELECT
               s.registration_number AS "Reg No",
               s.student_name AS "Student Name",
               s.district AS "District",
               s.institution_name AS "Institution",
               COALESCE(s.student_mobile, '') AS "Student Mobile",
               COALESCE(s.parent_mobile, '') AS "Parent Mobile",
               COALESCE(s.coordinator_mobile, '') AS "Coordinator Phone",
               COALESCE(s.notes_summary, '') AS "Notes"
             FROM students s
             WHERE (s.invalid_number_flagged = 1 OR s.communication_status = 'Number Correction Required')
               ${staffFilter}
             ORDER BY s.updated_at DESC`
          )
          .all(...staffParams),
      };

    default:
      throw new Error(`Unknown report type: ${reportType}`);
  }
}

function escapeCsvCell(val) {
  const str = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function reportToCsv(report) {
  const header = report.columns.map(escapeCsvCell).join(',');
  const body = report.rows
    .map((row) => report.columns.map((col) => escapeCsvCell(row[col])).join(','))
    .join('\r\n');
  return `\uFEFF${header}\r\n${body}\r\n`;
}

function escapeXml(val) {
  return String(val === null || val === undefined ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reportToExcelXml(report) {
  const headerRow = `<Row>${report.columns
    .map((col) => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(col)}</Data></Cell>`)
    .join('')}</Row>`;

  const dataRows = report.rows
    .map(
      (row) =>
        `<Row>${report.columns
          .map((col) => {
            const v = row[col];
            const isNum = typeof v === 'number' && Number.isFinite(v);
            return `<Cell><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(v)}</Data></Cell>`;
          })
          .join('')}</Row>`
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header">
   <Font ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0F5132" ss:Pattern="Solid"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(report.title.slice(0, 31))}">
  <Table>
   ${headerRow}
   ${dataRows}
  </Table>
 </Worksheet>
</Workbook>`;
}

module.exports = {
  getDashboardStats,
  getStaffPerformance,
  generateReport,
  reportToCsv,
  reportToExcelXml,
};
