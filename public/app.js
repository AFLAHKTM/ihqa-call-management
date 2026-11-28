const state = {
  user: null,
  filtersMeta: null,
  workflowConfig: null,
  showAllKpis: false,
  activeSection: '',
  quickSearchTimer: null,
  students: [],
  selectedStudentIds: new Set(),
  activeStudentId: null,
  activeReport: 'district',
  currentReportData: null,
};

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWhatsAppUrl(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  const waNum = digits.length === 10 ? `91${digits}` : digits;
  const msg = `Dear Usthad/Institution Supervisor,

We tried contacting you regarding your institution’s participation in District Level for India Holy Quran Award 2026–27 but could not reach you.

Kerala State Competition Dates: November 30 – December 3, 2026.

Kindly contact us at the earliest to complete the pending formalities.

Whatsapp: +91 94004 56562
Call: 8086666144
Email: info@indiaquranaward.com

Thank you for your cooperation.

India Holy Quran Award 2026–27
Award Coordination Team`;
  return `https://wa.me/${waNum}?text=${encodeURIComponent(msg)}`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3200);
}

function statusBadgeClass(status) {
  if (status === 'Successfully Contacted' || status === 'Follow-up Completed') return 'badge-success';
  if (status === 'Number Correction Required' || status === 'Attempt 3 Completed') return 'badge-danger';
  if (status === 'Callback Scheduled' || status === 'Pending Second Call' || status === 'Pending Third Call') return 'badge-warn';
  if (status === 'Email Notification Sent') return 'badge-info';
  return 'badge-neutral';
}

function applyRoleVisibility() {
  const role = state.user?.role;
  const isAdmin = role === 'ADMIN';
  const isSupervisorOrAdmin = role === 'ADMIN' || role === 'SUPERVISOR';
  document.querySelectorAll('.admin-only').forEach((el) => {
    el.classList.toggle('hidden', !isAdmin);
  });
  document.querySelectorAll('.admin-supervisor-only').forEach((el) => {
    el.classList.toggle('hidden', !isSupervisorOrAdmin);
  });
}

async function checkSession() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user;
    enterApp();
  } catch {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app-shell').classList.add('hidden');
  }
}

async function enterApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  document.getElementById('current-user-name').textContent = state.user.full_name;
  document.getElementById('current-user-role').textContent = state.user.role;
  const greetingEl = document.getElementById('topbar-greeting');
  if (greetingEl) {
    const greetName = state.user.role === 'ADMIN' ? 'Admin' : state.user.full_name;
    greetingEl.textContent = `👋 Hey ${greetName}`;
    greetingEl.classList.remove('hidden');
  }
  applyRoleVisibility();
  await loadAllData();
  if (['kashif', 'salman', 'suhail'].includes(state.user.username)) {
    switchView('unuploaded');
  }
}

async function loadAllData() {
  await Promise.all([
    loadDashboardAndQueue(),
    loadNotifications(),
    api('/api/campuses?limit=1')
      .then((campusMeta) => {
        if (campusMeta?.overallTotal !== undefined || campusMeta?.stats) {
          const badge = document.getElementById('nav-unuploaded-badge');
          if (badge) badge.textContent = campusMeta.overallTotal ?? campusMeta.stats.total;
        }
      })
      .catch(() => null),
    api('/api/students/approved-dated')
      .then((appMeta) => {
        if (appMeta?.overallTotal !== undefined) {
          const badge = document.getElementById('nav-approved-badge');
          if (badge) badge.textContent = appMeta.overallTotal;
        }
      })
      .catch(() => null),
    refreshDayBadges(),
  ]);
}

async function loadDashboardAndQueue() {
  const params = new URLSearchParams();
  const fQuickSearch = document.getElementById('f-quick-search')?.value?.trim();
  const fDistrict = document.getElementById('f-district').value;
  const fInstitution = document.getElementById('f-institution').value;
  const fStudentName = document.getElementById('f-student-name').value;
  const fRegNo = document.getElementById('f-reg-no').value;
  const fStaff = document.getElementById('f-staff').value;
  const fStatus = document.getElementById('f-status').value;
  const fAttempts = document.getElementById('f-attempts').value;
  const fDateFrom = document.getElementById('f-date-from').value;
  const fDateTo = document.getElementById('f-date-to').value;

  if (fQuickSearch) params.set('search', fQuickSearch);
  if (state.activeSection) params.set('examCategory', state.activeSection);
  if (fDistrict) params.set('district', fDistrict);
  if (fInstitution) params.set('institution', fInstitution);
  if (fStudentName) params.set('studentName', fStudentName);
  if (fRegNo) params.set('registrationNumber', fRegNo);
  if (fStaff) params.set('assignedStaffId', fStaff);
  if (fStatus) params.set('callStatus', fStatus);
  if (fAttempts !== '') params.set('attemptCount', fAttempts);
  if (fDateFrom) params.set('dateFrom', fDateFrom);
  if (fDateTo) params.set('dateTo', fDateTo);

  const [summary, listData] = await Promise.all([
    api(`/api/dashboard/summary?${params.toString()}`),
    api(`/api/students?${params.toString()}`),
  ]);

  state.filtersMeta = summary.filtersMeta;
  state.workflowConfig = summary.workflowConfig;
  state.lastStats = summary.stats;
  state.students = listData.rows;
  document.getElementById('queue-count-badge').textContent = listData.total;
  if (summary.sectionCounts) {
    document.getElementById('cnt-all').textContent = summary.sectionCounts.all;
    document.getElementById('cnt-qirath').textContent = summary.sectionCounts.qirath;
    document.getElementById('cnt-tafseer').textContent = summary.sectionCounts.tafseer;
  }
  populateFilterDropdowns(summary.filtersMeta);

  const dashStaffPills = document.getElementById('dashboard-staff-pills');
  if (dashStaffPills && summary.staffBreakdown && summary.staffBreakdown.length > 0) {
    const activeStaffId = document.getElementById('f-staff')?.value || '';
    const allTotal = summary.overallTotal ?? summary.stats.totalStudentsAssigned;
    const pills = [
      `<button type="button" class="pill-filter ${!activeStaffId ? 'active' : ''}" data-dash-staff="">All (${allTotal})</button>`,
      ...summary.staffBreakdown.map(
        (s) =>
          `<button type="button" class="pill-filter ${String(activeStaffId) === String(s.id) ? 'active' : ''}" data-dash-staff="${s.id}">${escapeHtml(s.full_name)} (${s.count})</button>`
      ),
    ];
    dashStaffPills.innerHTML = pills.join('');
    dashStaffPills.querySelectorAll('.pill-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fStaffSel = document.getElementById('f-staff');
        if (fStaffSel) fStaffSel.value = btn.dataset.dashStaff || '';
        loadDashboardAndQueue();
      });
    });
  }

  renderKpis(summary.stats);
  renderStudentsTable(listData.rows);
}

function populateFilterDropdowns(meta) {
  const distSel = document.getElementById('f-district');
  const prevDist = distSel.value;
  distSel.innerHTML = `<option value="">All Districts</option>${meta.districts
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
    .join('')}`;
  distSel.value = prevDist;

  const staffSel = document.getElementById('f-staff');
  const prevStaff = staffSel.value;
  staffSel.innerHTML = `<option value="">All Assigned Staff</option><option value="unassigned">Unassigned</option>${meta.staffList
    .map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`)
    .join('')}`;
  staffSel.value = prevStaff;

  const statusSel = document.getElementById('f-status');
  const prevStatus = statusSel.value;
  statusSel.innerHTML = `<option value="">All Call / Comm. Statuses</option>
    <optgroup label="Communication Statuses">
      ${meta.communicationStatuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
    </optgroup>
    <optgroup label="Call Outcomes">
      ${meta.callOutcomes.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('')}
    </optgroup>`;
  statusSel.value = prevStatus;

  // Bulk assign & Modal dropdowns
  document.getElementById('bulk-staff-select').innerHTML = `<option value="">Unassign</option>${meta.staffList
    .map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`)
    .join('')}`;

  document.getElementById('log-outcome').innerHTML = `<option value="">Select outcome...</option>${meta.callOutcomes
    .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
    .join('')}`;

  document.getElementById('e-status').innerHTML = `<option value="">Keep current</option>${meta.communicationStatuses
    .map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`)
    .join('')}`;

  document.getElementById('ns-district').innerHTML = meta.districts
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
    .join('');

  document.getElementById('ns-cat').innerHTML = meta.examCategories
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join('');

  document.getElementById('ns-staff').innerHTML = `<option value="">Unassigned</option>${meta.staffList
    .map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`)
    .join('')}`;

  const shBox = document.getElementById('sh-staff-checkboxes');
  if (shBox) {
    shBox.innerHTML = meta.staffList
      .map(
        (s) => `<label class="chk"><input type="checkbox" class="sh-staff-chk" value="${s.id}" ${s.role === 'CALLING_STAFF' ? 'checked' : ''} /> ${escapeHtml(s.full_name)}</label>`
      )
      .join('');
  }
}

function renderKpis(stats) {
  const simpleCards = [
    { label: 'Total Campuses', value: stats.totalStudentsAssigned, cls: '', filterStatus: '' },
    { label: 'Pending Calls', value: stats.followupPending, cls: 'warn', filterStatus: 'PENDING_ALL' },
    { label: 'Attended', value: stats.successfullyContacted, cls: 'success', filterStatus: 'Successfully Contacted' },
    { label: 'Unattended', value: (stats.notReachable || 0) + (stats.noAnswer || 0), cls: 'warn', filterStatus: 'UNATTENDED' },
    { label: 'Auto-Emailed', value: stats.emailNotificationsSent, cls: '', filterStatus: 'Email Notification Sent' },
    { label: 'Calls Made', value: stats.totalCallsAttempted, cls: '', filterStatus: 'CALLS_MADE' },
  ];
  const allCards = [
    { label: 'Students Assigned', value: stats.totalStudentsAssigned, cls: '' },
    { label: 'Total Calls Attempted', value: stats.totalCallsAttempted, cls: '' },
    { label: 'Successfully Contacted', value: stats.successfullyContacted, cls: 'success' },
    { label: 'Not Reachable', value: stats.notReachable, cls: 'warn' },
    { label: 'No Answer', value: stats.noAnswer, cls: 'warn' },
    { label: 'Callbacks Requested', value: stats.callbacksRequested, cls: 'warn' },
    { label: 'Wrong Phone Numbers', value: stats.wrongPhoneNumbers, cls: 'danger' },
    { label: 'Follow-up Pending', value: stats.followupPending, cls: 'warn' },
    { label: 'Email Notices Sent', value: stats.emailNotificationsSent, cls: '' },
    { label: 'Completed Follow-ups', value: stats.completedFollowups, cls: 'success' },
  ];
  const cards = state.showAllKpis ? allCards : simpleCards;
  const activeStatus = document.getElementById('f-status')?.value || '';
  const kpiGrid = document.getElementById('kpi-grid');
  kpiGrid.innerHTML = cards
    .map((c) => {
      const hasFilter = c.filterStatus !== undefined;
      const isActive = hasFilter && activeStatus === c.filterStatus && c.filterStatus !== '';
      return `<div class="kpi-card ${c.cls} ${hasFilter ? 'clickable' : ''} ${isActive ? 'kpi-active' : ''}" ${hasFilter ? `data-kpi-status="${escapeHtml(c.filterStatus)}" title="Click to view ${escapeHtml(c.label)}"` : ''}>
        <div class="kpi-label">${escapeHtml(c.label)}</div>
        <div class="kpi-value">${c.value}</div>
      </div>`;
    })
    .join('');

  kpiGrid.querySelectorAll('.kpi-card.clickable').forEach((card) => {
    card.addEventListener('click', async () => {
      const targetStatus = card.dataset.kpiStatus ?? '';
      const fStatus = document.getElementById('f-status');
      const fAttempts = document.getElementById('f-attempts');
      if (fStatus) {
        if (targetStatus && !Array.from(fStatus.options).some((o) => o.value === targetStatus)) {
          const opt = document.createElement('option');
          opt.value = targetStatus;
          opt.textContent = targetStatus;
          fStatus.appendChild(opt);
        }
        fStatus.value = targetStatus;
      }
      if (fAttempts) fAttempts.value = '';
      document.querySelectorAll('#quick-status-pills .pill-filter').forEach((p) => {
        p.classList.toggle('active', (p.dataset.quickStatus ?? '') === targetStatus);
      });
      await loadDashboardAndQueue();
      document.getElementById('students-tbody')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderStudentsTable(rows) {
  const isSupOrAdmin = state.user.role === 'ADMIN' || state.user.role === 'SUPERVISOR';
  const tbody = document.getElementById('students-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">No records match the active filters.</td></tr>`;
    return;
  }

  // Group rows by institution so the table matches the Institution Winners Status Report model
  const groups = [];
  const groupMap = new Map();
  for (const s of rows) {
    const key = s.institution_id ? `inst:${s.institution_id}` : `name:${s.institution_name}|${s.district}`;
    let g = groupMap.get(key);
    if (!g) {
      g = {
        key,
        institution_name: s.institution_name,
        institution_place: s.institution_place || '',
        district: s.district,
        coordinator_name: s.coordinator_name || '',
        coordinator_mobile: s.coordinator_mobile || '',
        coordinator_email: s.coordinator_email || s.email || '',
        students_count: s.institution_students_count || 1,
        winner_status: s.institution_winner_status || '',
        items: [],
      };
      groupMap.set(key, g);
      groups.push(g);
    }
    g.items.push(s);
  }

  tbody.innerHTML = groups
    .map((g, idx) => {
      // Order category breakdown: Tafsir first, then Recitation (matching the report screenshot)
      const sortedItems = [...g.items].sort((a, b) => {
        if (a.exam_category === b.exam_category) return 0;
        return a.exam_category.includes('Tafsir') ? -1 : 1;
      });
      const primary = sortedItems[0];
      const allIds = sortedItems.map((x) => x.id);
      const checked = allIds.every((id) => state.selectedStudentIds.has(id)) ? 'checked' : '';

      const primaryPhone = primary.student_mobile || primary.parent_mobile || g.coordinator_mobile || '';
      const primaryType = primary.student_mobile ? 'student' : primary.parent_mobile ? 'parent' : 'coordinator';
      const cleanPhone = primaryPhone.replace(/[^\d+]/g, '');

      const locationLine = [g.institution_place, g.district, 'Kerala'].filter(Boolean).join(', ');
      const contactLine = [g.coordinator_mobile || primaryPhone, g.coordinator_email].filter(Boolean).join(' · ');

      const isPartial = String(g.winner_status).toLowerCase().includes('partial');
      const winnerStatusHtml = g.winner_status
        ? `<div class="${isPartial ? 'winner-status-partial' : 'winner-status-done'}">${escapeHtml(g.winner_status)}</div>`
        : `<div class="winner-status-done">Registered</div>`;

      const breakdownHtml = sortedItems
        .map((item) => {
          const isCalled = item.communication_status !== 'Pending First Call' && item.communication_status !== 'Not Assigned';
          return `<div class="cat-breakdown-item">
            <div class="cat-breakdown-label">${escapeHtml(item.exam_category)}:</div>
            <div class="cat-breakdown-winner">
              ${escapeHtml(item.student_name)}
              ${sortedItems.length > 1 ? `<button type="button" class="cat-log-link open-desk-btn" data-id="${item.id}" title="Log call for this category">${isCalled ? escapeHtml(item.communication_status) : 'Log'}</button>` : ''}
            </div>
          </div>`;
        })
        .join('');

      const staffNames = Array.from(new Set(sortedItems.map((i) => i.assigned_staff_name || 'Unassigned'))).join(', ');
      const isOverdue =
        primary.next_followup_at &&
        new Date(primary.next_followup_at.replace(' ', 'T') + 'Z').getTime() < Date.now() &&
        ['Pending Second Call', 'Pending Third Call', 'Callback Scheduled'].includes(primary.communication_status);

      const isAttended =
        primary.communication_status === 'Successfully Contacted' ||
        primary.communication_status === 'Follow-up Completed';
      const actionHtml = isAttended
        ? `<div class="row-action-btns is-attended">
            <button type="button" class="btn btn-sm row-attend-btn attended-done" disabled title="Call marked as Attended">✅ Attended</button>
            <button type="button" class="btn btn-sm row-undo-btn undo-call-row-btn" data-ids="${allIds.join(',')}" title="Undo Attended — Revert to previous status">↩ Undo</button>
          </div>`
        : `<div class="row-action-btns">
            <button type="button" class="btn btn-sm row-attend-btn quick-save-row-btn" data-ids="${allIds.join(',')}" data-contact="${primaryType}" data-outcome="Successfully Contacted" title="Mark call attended and save">✅ Attend</button>
            <button type="button" class="btn btn-sm row-unattend-btn open-unattend-row-btn" data-ids="${allIds.join(',')}" data-contact="${primaryType}" data-label="${escapeHtml(g.institution_name)}" title="Select unattended reason and save">❌ Unattend</button>
          </div>`;

      const pdfMatch = String(primary.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
      const displayNo = pdfMatch ? Number(pdfMatch[1]) : idx + 1;

      return `<tr>
        ${isSupOrAdmin ? `<td data-label="Select"><input type="checkbox" class="row-chk" data-ids="${allIds.join(',')}" ${checked} /></td>` : ''}
        <td data-label="#"><strong>${displayNo}</strong></td>
        <td data-label="Institution">
          <div class="inst-title">${escapeHtml(g.institution_name)}</div>
          <div class="inst-loc">${escapeHtml(locationLine)}</div>
        </td>
        <td data-label="Supervisor & Contact">
          <div class="sup-name">${escapeHtml(g.coordinator_name || primary.student_name)}</div>
          <div class="sup-contact">
            ${cleanPhone ? `<a href="tel:${escapeHtml(cleanPhone)}" class="sup-phone-link" title="Tap to call">📞 ${escapeHtml(primaryPhone)}</a><a href="${escapeHtml(buildWhatsAppUrl(cleanPhone))}" target="_blank" rel="noopener" class="sup-wa-link" title="Send WhatsApp message">💬 WhatsApp</a>` : '<span class="muted">No phone</span>'}
            ${g.coordinator_email ? `<span class="sup-email"> · ${escapeHtml(g.coordinator_email)}</span>` : ''}
          </div>
        </td>
        <td data-label="Students" class="num-col">
          <span class="students-count">${escapeHtml(g.students_count)}</span>
        </td>
        <td data-label="Winner Status" class="center-col">
          ${winnerStatusHtml}
        </td>
        <td data-label="Category Breakdown">
          <div class="cat-breakdown-list">${breakdownHtml}</div>
        </td>
        <td data-label="Call Status & Action">
          <div style="margin-bottom:6px">
            <span class="badge ${statusBadgeClass(primary.communication_status)}">${escapeHtml(primary.communication_status)}</span>
            <span class="badge badge-neutral">${primary.valid_attempt_count}/${state.workflowConfig?.maxAttempts || 2}</span>
            <div class="muted small" style="margin-top:2px">${escapeHtml(staffNames)}</div>
            ${primary.next_followup_at ? `<div class="small ${isOverdue ? 'badge badge-danger' : 'muted'}">Follow-up: ${escapeHtml(primary.next_followup_at)}</div>` : ''}
          </div>
          ${actionHtml}
        </td>
      </tr>`;
    })
    .join('');

  document.querySelectorAll('.open-desk-btn').forEach((btn) => {
    btn.addEventListener('click', () => openCallingDesk(Number(btn.dataset.id)));
  });
  document.querySelectorAll('.quick-save-row-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ids = String(btn.dataset.ids || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      const outcome = btn.dataset.outcome;
      const contactType = btn.dataset.contact || 'coordinator';
      btn.disabled = true;
      try {
        await quickSaveCallOutcome(ids, outcome, contactType);
      } finally {
        btn.disabled = false;
      }
    });
  });
  document.querySelectorAll('.undo-call-row-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const ids = String(btn.dataset.ids || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api('/api/students/undo-calls', {
          method: 'POST',
          body: JSON.stringify({ studentIds: ids }),
        });
        showToast('↩ Call reverted to Pending');
        await loadDashboardAndQueue();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '↩ Undo';
      }
    });
  });
  document.querySelectorAll('.open-unattend-row-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const ids = String(btn.dataset.ids || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      openUnattendPopup({
        studentIds: ids,
        contactType: btn.dataset.contact || 'coordinator',
        callSessionId: null,
        label: btn.dataset.label || '',
      });
    });
  });
  document.querySelectorAll('.row-phone-call').forEach((link) => {
    link.addEventListener('click', () => {
      startPhoneCallFlow(Number(link.dataset.id), link.dataset.contact);
    });
  });
  document.querySelectorAll('.row-chk').forEach((chk) => {
    chk.addEventListener('change', () => {
      const ids = String(chk.dataset.ids || '')
        .split(',')
        .filter(Boolean)
        .map(Number);
      for (const id of ids) {
        if (chk.checked) state.selectedStudentIds.add(id);
        else state.selectedStudentIds.delete(id);
      }
      updateBulkBar();
    });
  });
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-assign-bar');
  const count = state.selectedStudentIds.size;
  document.getElementById('bulk-selected-count').textContent = `${count} selected`;
  bar.classList.toggle('hidden', count === 0);
}

function openUnattendPopup({ studentIds = [], campusId = null, contactType = 'coordinator', callSessionId = null, label = '' }) {
  state.pendingUnattendTarget = { studentIds, campusId, contactType, callSessionId };
  document.getElementById('unattend-target-label').textContent = label
    ? `Institution: ${label}`
    : 'Tap the reason below to save immediately:';
  document.getElementById('unattend-modal').classList.remove('hidden');
}

async function quickSaveCallOutcome(studentIds, callOutcome, contactType = 'coordinator', callSessionId = null) {
  try {
    const results = await Promise.all(
      studentIds.map((sid, idx) =>
        api(`/api/students/${sid}/calls`, {
          method: 'POST',
          body: JSON.stringify({
            callSessionId: idx === 0 ? callSessionId : null,
            contactType,
            callOutcome,
            remarks: callOutcome === 'Successfully Contacted' ? 'Call Attended' : `Unattended (${callOutcome})`,
            isValidAttempt: true,
          }),
        })
      )
    );
    let emailSent = false;
    let emailSimulated = false;
    for (const res of results) {
      if (res.emailResult?.emailRecord?.delivery_status === 'SENT') {
        if (res.emailResult?.emailRecord?.last_error?.includes('SIMULATION_ONLY')) {
          emailSimulated = true;
        } else {
          emailSent = true;
        }
      }
    }
    if (callOutcome === 'Successfully Contacted') {
      showToast('✅ Saved: Attended');
    } else if (emailSent) {
      showToast(`Saved: ${callOutcome} & Auto-email sent to institution`);
    } else if (emailSimulated) {
      showToast(`Saved: ${callOutcome} (⚠️ Dev Mode: configure SMTP in Settings for real email)`);
    } else {
      showToast(`Saved: ${callOutcome}`);
    }
    await loadDashboardAndQueue();
    if (state.activeStudentId && studentIds.includes(state.activeStudentId) && !document.getElementById('calling-drawer').classList.contains('hidden')) {
      await openCallingDesk(state.activeStudentId);
    }
  } catch (err) {
    showToast(err.message);
  }
}

async function startPhoneCallFlow(studentId, contactType = 'student') {
  try {
    const res = await api(`/api/students/${studentId}/click-to-call`, {
      method: 'POST',
      body: JSON.stringify({ contactType, mode: 'device_tel' }),
    });
    await openCallingDesk(studentId, {
      callSessionId: res.callSessionId,
      contactType,
      bannerHtml: `<strong>Phone Call Initiated</strong> (${escapeHtml(res.targetNumber)}) · Log the call outcome below after completing the call. Accidental clicks are not counted.`,
    });
  } catch (err) {
    await openCallingDesk(studentId);
    showToast(err.message);
  }
}

async function openCallingDesk(studentId, activeSession = null) {
  state.activeStudentId = studentId;
  const data = await api(`/api/students/${studentId}`);
  const { student, history, emails } = data;

  const showCloudBtn =
    state.workflowConfig?.telephonyProvider === 'exotel' ||
    state.workflowConfig?.telephonyProvider === 'twilio';
  document.querySelectorAll('.cloud-only').forEach((el) => {
    el.classList.toggle('hidden', !showCloudBtn);
  });

  document.getElementById('d-student-name').textContent = student.student_name;
  document.getElementById('d-reg-cat').textContent = `${student.registration_number} · ${student.exam_category}`;
  const statusEl = document.getElementById('d-comm-status');
  statusEl.textContent = student.communication_status;
  statusEl.className = `badge ${statusBadgeClass(student.communication_status)}`;
  document.getElementById('d-attempt-badge').textContent = `Valid Attempts: ${student.valid_attempt_count}`;
  document.getElementById('d-assigned-staff').textContent = `Owner: ${student.assigned_staff_name || 'Unassigned'}`;

  const parentBox = document.getElementById('box-parent-name');
  if (student.parent_name) {
    parentBox.classList.remove('hidden');
    document.getElementById('d-parent-name').textContent = student.parent_name;
  } else {
    parentBox.classList.add('hidden');
  }
  document.getElementById('d-inst-district').textContent = `${student.institution_name} (${student.district})`;
  document.getElementById('d-coordinator').textContent = `${student.coordinator_name || '-'} · ${student.coordinator_mobile || '-'}`;
  document.getElementById('d-email').textContent = student.email || student.coordinator_email || 'No email on record';

  document.getElementById('d-student-mobile').textContent = student.student_mobile || 'Not provided';
  document.getElementById('d-parent-mobile').textContent = student.parent_mobile || 'Not provided';
  document.getElementById('d-coord-mobile').textContent = student.coordinator_mobile || 'Not provided';

  document.getElementById('c2c-row-student').classList.toggle('hidden', !student.student_mobile);
  document.getElementById('c2c-row-parent').classList.toggle('hidden', !student.parent_mobile);
  document.getElementById('c2c-row-coordinator').classList.toggle('hidden', !student.coordinator_mobile);

  document.getElementById('tel-student').href = student.student_mobile ? `tel:${student.student_mobile.replace(/[^\d+]/g, '')}` : '#';
  document.getElementById('tel-parent').href = student.parent_mobile ? `tel:${student.parent_mobile.replace(/[^\d+]/g, '')}` : '#';
  document.getElementById('tel-coord').href = student.coordinator_mobile ? `tel:${student.coordinator_mobile.replace(/[^\d+]/g, '')}` : '#';

  document.getElementById('e-student-mobile').value = student.student_mobile || '';
  document.getElementById('e-parent-mobile').value = student.parent_mobile || '';
  document.getElementById('e-email').value = student.email || '';
  document.getElementById('e-status').value = '';

  const defaultContactType = student.student_mobile
    ? 'student'
    : student.parent_mobile
      ? 'parent'
      : 'coordinator';
  document.getElementById('log-call-session-id').value = activeSession?.callSessionId || '';
  document.getElementById('log-contact-type').value = activeSession?.contactType || defaultContactType;
  document.getElementById('log-outcome').value = '';
  document.querySelectorAll('.outcome-btn').forEach((b) => b.classList.remove('selected'));
  document.getElementById('log-remarks').value = '';
  document.getElementById('log-duration').value = '';
  document.getElementById('log-followup-date').value = '';
  document.getElementById('log-complete-followup').checked = false;
  const banner = document.getElementById('active-call-banner');
  if (activeSession?.bannerHtml) {
    banner.innerHTML = activeSession.bannerHtml;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  const histEl = document.getElementById('d-call-history');
  histEl.innerHTML = history.length
    ? history
        .map(
          (h) => `<div class="history-item">
            <div style="display:flex;justify-content:space-between;gap:8px">
              <strong>${h.is_valid_attempt ? (h.attempt_number ? `Attempt #${h.attempt_number}` : 'Diagnostic Attempt') : 'Unlogged / Cancelled Initiation'} — ${escapeHtml(h.call_outcome || h.telephony_status)}</strong>
              <span class="muted">${escapeHtml(h.called_at)}</span>
            </div>
            <div class="muted">Staff: ${escapeHtml(h.staff_name)} · Number: ${escapeHtml(h.contact_number_called)} (${escapeHtml(h.contact_type)}) ${h.call_duration_seconds ? `· Duration: ${h.call_duration_seconds}s` : ''}</div>
            ${h.followup_date ? `<div>Follow-up Scheduled: ${escapeHtml(h.followup_date)}</div>` : ''}
            ${h.remarks ? `<div>Remarks: ${escapeHtml(h.remarks)}</div>` : ''}
          </div>`
        )
        .join('')
    : '<div class="muted small">No call attempts logged yet.</div>';

  const emailEl = document.getElementById('d-email-history');
  emailEl.innerHTML = emails.length
    ? emails
        .map(
          (e) => `<div class="history-item">
            <div style="display:flex;justify-content:space-between">
              <strong>Seq #${e.sequence_number} — ${escapeHtml(e.delivery_status)}</strong>
              <span class="muted">${escapeHtml(e.sent_at || e.created_at)}</span>
            </div>
            <div class="muted">To: ${escapeHtml(e.recipient_email || 'None')} · Attempts: ${e.attempt_count}</div>
            ${e.last_error ? `<div style="color:#b42318">${escapeHtml(e.last_error)}</div>` : ''}
          </div>`
        )
        .join('')
    : '<div class="muted small">No automatic email notifications triggered.</div>';

  const isAttended =
    student.communication_status === 'Successfully Contacted' ||
    student.communication_status === 'Follow-up Completed';
  const attendBtn = document.getElementById('quick-attend-btn');
  const unattendBtn = document.getElementById('quick-unattend-btn');
  const undoBtn = document.getElementById('quick-undo-btn');

  if (attendBtn && unattendBtn && undoBtn) {
    if (isAttended) {
      attendBtn.classList.add('attended-done');
      attendBtn.textContent = '✅ Attended';
      attendBtn.disabled = true;
      unattendBtn.classList.add('hidden');
      undoBtn.classList.remove('hidden');
    } else {
      attendBtn.classList.remove('attended-done');
      attendBtn.textContent = '✅ Attend';
      attendBtn.disabled = false;
      unattendBtn.classList.remove('hidden');
      undoBtn.classList.add('hidden');
    }
  }

  document.getElementById('calling-drawer').classList.remove('hidden');
}

async function loadFollowupsView() {
  const { rows } = await api('/api/students?limit=500');
  const callbacks = rows.filter((s) =>
    ['Callback Scheduled', 'Pending Second Call', 'Pending Third Call'].includes(s.communication_status)
  );
  const threeAttempts = rows.filter(
    (s) => s.valid_attempt_count >= 3 || s.manual_followup_required
  );
  const invalidNums = rows.filter(
    (s) => s.invalid_number_flagged || s.communication_status === 'Number Correction Required'
  );

  const renderItem = (s, extra) => `<div class="stack-item">
    <div>
      <div><strong>${escapeHtml(s.student_name)}</strong> (${escapeHtml(s.registration_number)})</div>
      <div class="muted small">${escapeHtml(s.district)} · ${escapeHtml(s.institution_name)}</div>
      <div class="small">${extra}</div>
    </div>
    <button type="button" class="btn btn-outline btn-sm" onclick="openCallingDesk(${s.id})">Open</button>
  </div>`;

  document.getElementById('callbacks-list').innerHTML = callbacks.length
    ? callbacks.map((s) => renderItem(s, `${s.communication_status} · Due: ${s.next_followup_at || 'Unscheduled'}`)).join('')
    : '<div class="muted small">No pending callbacks.</div>';

  document.getElementById('three-attempt-list').innerHTML = threeAttempts.length
    ? threeAttempts.map((s) => renderItem(s, `${s.communication_status} · Attempts: ${s.valid_attempt_count}`)).join('')
    : '<div class="muted small">No three-attempt cases.</div>';

  document.getElementById('invalid-numbers-list').innerHTML = invalidNums.length
    ? invalidNums.map((s) => renderItem(s, `Mobile: ${s.student_mobile || '-'} · ${s.notes_summary || ''}`)).join('')
    : '<div class="muted small">No invalid numbers flagged.</div>';
}

async function loadStaffView() {
  const { staff } = await api('/api/staff/performance');
  const isAdminOrSup = state.user.role === 'ADMIN' || state.user.role === 'SUPERVISOR';
  document.getElementById('staff-perf-tbody').innerHTML = staff
    .map(
      (st) => `<tr>
        <td><strong>${escapeHtml(st.full_name)}</strong><div class="muted small">${escapeHtml(st.email)}</div></td>
        <td><span class="badge badge-neutral">${escapeHtml(st.role)}</span></td>
        <td>
          ${isAdminOrSup ? `<input type="number" class="target-input" data-id="${st.id}" value="${st.daily_target}" style="width:76px" />` : st.daily_target}
        </td>
        <td>${st.assignedContacts}</td>
        <td>${st.callsCompleted}</td>
        <td>${st.callsToday}</td>
        <td>${st.successfulContacts}</td>
        <td>${st.unreachableContacts}</td>
        <td>${st.pendingFollowups}</td>
        <td>${st.threeAttemptCases}</td>
        <td>
          <strong>${st.dailyCompletionPercentage}%</strong>
          <div class="progress-bar"><div class="progress-fill" style="width:${st.dailyCompletionPercentage}%"></div></div>
        </td>
      </tr>`
    )
    .join('');

  document.querySelectorAll('.target-input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      await api(`/api/staff/${inp.dataset.id}/target`, {
        method: 'PATCH',
        body: JSON.stringify({ dailyTarget: Number(inp.value) }),
      });
      showToast('Daily calling target updated');
      loadStaffView();
    });
  });

  const opts = staff.map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)} (${s.pendingFollowups} pending)</option>`).join('');
  document.getElementById('reassign-from').innerHTML = opts;
  document.getElementById('reassign-to').innerHTML = opts;
}

async function loadNotifications() {
  const data = await api('/api/notifications');
  const badge = document.getElementById('nav-notif-badge');
  const topCount = document.getElementById('topbar-notif-count');
  badge.textContent = data.unreadCount;
  topCount.textContent = data.unreadCount;
  badge.classList.toggle('hidden', data.unreadCount === 0);

  const listEl = document.getElementById('notifications-list');
  listEl.innerHTML = data.notifications.length
    ? data.notifications
        .map(
          (n) => `<div class="stack-item ${n.is_read ? '' : 'unread'}">
            <div>
              <div><strong>${escapeHtml(n.title)}</strong> <span class="badge badge-neutral">${escapeHtml(n.type)}</span></div>
              <div class="small">${escapeHtml(n.message)}</div>
              <div class="muted small">${escapeHtml(n.created_at)} · Channels: ${escapeHtml((n.channels || []).join(', '))}</div>
            </div>
            ${!n.is_read ? `<button class="btn btn-outline btn-sm mark-read-btn" data-id="${n.id}">Read</button>` : '<span class="muted small">Read</span>'}
          </div>`
        )
        .join('')
    : '<div class="muted small">No notifications.</div>';

  document.querySelectorAll('.mark-read-btn').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/notifications/${b.dataset.id}/read`, { method: 'POST' });
      loadNotifications();
    });
  });

  if (state.user.role === 'ADMIN' || state.user.role === 'SUPERVISOR') {
    const emailData = await api('/api/emails');
    const failed = emailData.emails.filter((e) => e.delivery_status === 'FAILED');
    const alertEl = document.getElementById('failed-emails-alert');
    if (failed.length > 0) {
      alertEl.textContent = `${failed.length} failed automatic email delivery(ies) require administrator review or resend.`;
      alertEl.classList.remove('hidden');
    } else {
      alertEl.classList.add('hidden');
    }

    document.getElementById('emails-tbody').innerHTML = emailData.emails
      .map(
        (e) => `<tr>
          <td><strong>${escapeHtml(e.student_name)}</strong><div class="muted small">${escapeHtml(e.registration_number)}</div></td>
          <td class="small">${escapeHtml(e.recipient_email || 'No email')}</td>
          <td>
            <span class="badge ${e.delivery_status === 'SENT' ? 'badge-success' : e.delivery_status === 'FAILED' ? 'badge-danger' : 'badge-warn'}">${escapeHtml(e.delivery_status)}</span>
            ${e.last_error ? `<div class="small" style="color:#b42318">${escapeHtml(e.last_error)}</div>` : ''}
          </td>
          <td class="small">${escapeHtml(e.sent_at || '-')} (${e.attempt_count}/${e.max_retries})</td>
          <td>
            ${state.user.role === 'ADMIN' && e.recipient_email ? `<button class="btn btn-outline btn-sm resend-email-btn" data-id="${e.id}">Resend</button>` : ''}
          </td>
        </tr>`
      )
      .join('');

    document.querySelectorAll('.resend-email-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/emails/${btn.dataset.id}/resend`, { method: 'POST' });
          showToast('Email resent');
          loadNotifications();
          loadDashboardAndQueue();
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  }
}

async function loadReport(reportType = state.activeReport) {
  state.activeReport = reportType;
  const report = await api(`/api/reports/${reportType}`);
  state.currentReportData = report;
  document.getElementById('report-title').textContent = report.title;
  document.getElementById('report-thead').innerHTML = `<tr>${report.columns
    .map((c) => `<th>${escapeHtml(c)}</th>`)
    .join('')}</tr>`;
  document.getElementById('report-tbody').innerHTML = report.rows.length
    ? report.rows
        .map(
          (r) => `<tr>${report.columns.map((c) => `<td>${escapeHtml(r[c])}</td>`).join('')}</tr>`
        )
        .join('')
    : `<tr><td colspan="${report.columns.length}" class="muted">No rows for this report.</td></tr>`;
}

async function loadSettingsAndAudit() {
  if (state.user.role !== 'ADMIN' && state.user.role !== 'SUPERVISOR') return;
  const [cfg, audit] = await Promise.all([api('/api/settings'), api('/api/settings/audit-logs?limit=80')]);
  const s = cfg.settings;

  document.getElementById('s-est-name').value = s.establishment_name || 'India Holy Quran Award — Kerala Coordination Office';
  document.getElementById('s-est-hours').value = s.establishment_calling_hours || '09:00 AM - 06:00 PM IST';
  document.getElementById('s-est-start').value = s.establishment_start_hour || 9;
  document.getElementById('s-est-end').value = s.establishment_end_hour || 18;
  document.getElementById('s-max-attempts').value = s.max_attempts || 3;
  document.getElementById('s-retry-hours').value = s.retry_interval_hours || 4;
  document.getElementById('s-email-retries').value = s.email_retry_max || 3;
  document.getElementById('s-retention-days').value = s.data_retention_days || 365;
  document.getElementById('s-telephony-provider').value = s.telephony_provider || 'device_phone';
  document.getElementById('s-email-provider').value = s.email_provider || 'gmail';
  document.getElementById('s-smtp-host').value = s.smtp_host || 'smtp.gmail.com';
  document.getElementById('s-smtp-port').value = s.smtp_port || 587;
  document.getElementById('s-smtp-user').value = s.smtp_user || 'muhammedaflah295@gmail.com';
  document.getElementById('s-smtp-pass').value = s.smtp_pass || '';
  document.getElementById('s-smtp-secure').checked = s.smtp_secure === 'true';
  document.getElementById('s-email-from').value = s.email_from || 'India Holy Quran Award <info@indiaquranaward.com>';
  document.getElementById('s-official-phone').value = s.official_contact_phone || '';
  document.getElementById('s-official-email').value = s.official_contact_email || 'info@indiaquranaward.com';
  document.getElementById('s-official-website').value = s.official_website_url || 'https://indiaquranaward.com';
  document.getElementById('s-auto-email').checked = s.auto_email_on_max_attempts !== 'false';
  document.getElementById('s-auto-unattended-email').checked = s.auto_email_on_unattended === 'true';
  document.getElementById('s-ch-email').checked = s.channel_email_enabled !== 'false';
  document.getElementById('s-ch-inapp').checked = s.channel_in_platform_enabled !== 'false';
  document.getElementById('s-ch-sms').checked = s.channel_sms_enabled === 'true';
  document.getElementById('s-ch-wa').checked = s.channel_whatsapp_enabled === 'true';

  const readyBadge = cfg.credentialsSummary.isRealSmtpReady
    ? '<span style="color:#027a48;font-weight:700">● Real SMTP Configured</span>'
    : '<span style="color:#b54708;font-weight:700">● Dev Simulation Mode (No Real Emails)</span>';

  document.getElementById('creds-summary').innerHTML =
    `Email Delivery: ${readyBadge} · Host: <code>${escapeHtml(cfg.credentialsSummary.smtpHost)}</code> · User: <code>${escapeHtml(cfg.credentialsSummary.smtpUserMasked || 'none')}</code><br>Telephony: <strong>${escapeHtml(cfg.credentialsSummary.telephonyProvider)}</strong> · Exotel: <code>${escapeHtml(cfg.credentialsSummary.exotelSidMasked || 'not set')}</code>`;

  document.getElementById('audit-tbody').innerHTML = audit.rows
    .map(
      (a) => `<tr>
        <td class="small">${escapeHtml(a.created_at)}</td>
        <td class="small">${escapeHtml(a.username || 'system')}</td>
        <td><span class="badge badge-neutral">${escapeHtml(a.action)}</span></td>
        <td class="small">${escapeHtml(a.entity_type)} #${escapeHtml(a.entity_id || '')}</td>
        <td class="small muted">${escapeHtml(a.details_json || '')}</td>
      </tr>`
    )
    .join('');
}

function switchView(viewName) {
  document.querySelectorAll('.view-section').forEach((v) => v.classList.add('hidden'));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  document.getElementById(`view-${viewName}`).classList.remove('hidden');
  document.querySelector(`.nav-item[data-view="${viewName}"]`)?.classList.add('active');

  const titles = {
    dashboard: 'CALL MANAGEMENT — Dashboard & Calling Queue',
    unuploaded: 'Winners Unuploaded Campuses (373 Institutions)',
    'approved-dated': 'Approved Dated — Handled & Attended Calls',
    'call-monday': 'Call for Monday — Scheduled Establishments',
    'call-tuesday': 'Call for Tuesday — Scheduled Establishments',
    followups: 'Callbacks, Three-Attempt & Wrong-Number Follow-Ups',
    staff: 'Calling Staff Management & Daily Performance',
    notifications: 'Central Notification Engine & Email Delivery Log',
    reports: 'Reports & CSV / Excel Exports',
    settings: 'Follow-Up Rules, Telephony Providers & Audit Log',
  };
  document.getElementById('view-title').textContent = titles[viewName] || 'CALL MANAGEMENT';

  if (viewName === 'unuploaded') loadUnuploadedCampuses();
  if (viewName === 'approved-dated') loadApprovedDated();
  if (viewName === 'call-monday') loadScheduledDay('Monday');
  if (viewName === 'call-tuesday') loadScheduledDay('Tuesday');
  if (viewName === 'followups') loadFollowupsView();
  if (viewName === 'staff') loadStaffView();
  if (viewName === 'notifications') loadNotifications();
  if (viewName === 'reports') loadReport();
  if (viewName === 'settings') loadSettingsAndAudit();
}

async function loadApprovedDated() {
  const search = document.getElementById('a-filter-search')?.value.trim() || '';
  const district = document.getElementById('a-filter-district')?.value || '';
  const staffId = state.approvedStaffId || '';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (district) params.set('district', district);
  if (staffId) params.set('staffId', staffId);

  const data = await api(`/api/students/approved-dated?${params.toString()}`);

  const distSel = document.getElementById('a-filter-district');
  if (distSel && data.districts) {
    const prev = distSel.value;
    distSel.innerHTML = `<option value="">All Districts</option>${data.districts
      .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
      .join('')}`;
    distSel.value = prev;
  }

  const pillsEl = document.getElementById('approved-staff-pills');
  if (pillsEl && data.staffBreakdown) {
    const pills = [
      `<button type="button" class="pill-filter ${!staffId ? 'active' : ''}" data-a-staff="">All (${data.overallTotal})</button>`,
      ...data.staffBreakdown.map(
        (s) =>
          `<button type="button" class="pill-filter ${String(staffId) === String(s.id) ? 'active' : ''}" data-a-staff="${s.id}">${escapeHtml(s.full_name)} (${s.count})</button>`
      ),
    ];
    pillsEl.innerHTML = pills.join('');
    pillsEl.querySelectorAll('.pill-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.approvedStaffId = btn.dataset.aStaff || '';
        loadApprovedDated();
      });
    });
  }

  document.getElementById('nav-approved-badge').textContent = data.overallTotal ?? data.total;
  document.getElementById('approved-total-label').textContent = `${data.total} approved`;

  renderApprovedDated(data.rows || []);
}

function renderApprovedDated(rows) {
  const tbody = document.getElementById('approved-tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">No approved / attended calls found yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((s, idx) => {
      const pdfMatch = String(s.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
      const displayNo = pdfMatch ? Number(pdfMatch[1]) : idx + 1;
      const phone = s.coordinator_mobile || s.student_mobile || '';
      const cleanPhone = String(phone).replace(/[^\d+]/g, '');
      const email = s.coordinator_email || s.email || '';
      const locationLine = [s.institution_place, s.district, 'Kerala'].filter(Boolean).join(', ');
      const approvedAt = s.last_called_at || s.updated_at || '';
      const isMon = s.scheduled_call_day === 'Monday';
      const isTue = s.scheduled_call_day === 'Tuesday';

      return `<tr>
        <td data-label="#"><strong>${displayNo}</strong></td>
        <td data-label="Institution">
          <div class="inst-title">${escapeHtml(s.institution_name)}</div>
          <div class="inst-loc">${escapeHtml(locationLine)}</div>
        </td>
        <td data-label="Supervisor & Contact">
          <div class="sup-name">${escapeHtml(s.coordinator_name || s.student_name)}</div>
          <div class="sup-contact">
            ${cleanPhone ? `<a href="tel:${escapeHtml(cleanPhone)}" class="sup-phone-link" title="Tap to call">📞 ${escapeHtml(phone)}</a><a href="${escapeHtml(buildWhatsAppUrl(cleanPhone))}" target="_blank" rel="noopener" class="sup-wa-link" title="Send WhatsApp message">💬 WhatsApp</a>` : '<span class="muted">No phone</span>'}
            ${email ? `<span class="sup-email"> · ${escapeHtml(email)}</span>` : ''}
          </div>
        </td>
        <td data-label="Category & Winner">
          <div class="cat-breakdown-label">${escapeHtml(s.exam_category)}:</div>
          <div class="cat-breakdown-winner">${escapeHtml(s.student_name)}</div>
        </td>
        <td data-label="Handled By">
          <span class="badge badge-neutral">${escapeHtml(s.assigned_staff_name || '-')}</span>
        </td>
        <td data-label="Approved Date">
          <span class="small" style="font-weight:600;color:#065f46">${escapeHtml(approvedAt)}</span>
        </td>
        <td data-label="Status">
          <span class="badge badge-success">✅ Attended</span>
        </td>
        <td data-label="Transfer to Monday or Tuesday">
          <div class="day-transfer-btns ${isMon || isTue ? 'is-scheduled' : ''}">
            ${
              isMon || isTue
                ? `<span class="day-transfer-badge">✓ ${isMon ? 'Monday' : 'Tuesday'}</span>
                   <button type="button" class="btn btn-sm btn-outline btn-transfer-day" data-id="${s.id}" data-day="">Undo</button>`
                : `<button type="button" class="btn btn-sm btn-outline btn-transfer-day" data-id="${s.id}" data-day="Monday">Transfer to Monday</button>
                   <button type="button" class="btn btn-sm btn-outline btn-transfer-day" data-id="${s.id}" data-day="Tuesday">Transfer to Tuesday</button>`
            }
          </div>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('.btn-transfer-day').forEach((btn) => {
    btn.addEventListener('click', () => {
      transferStudentDay(Number(btn.dataset.id), btn.dataset.day || null);
    });
  });
}

async function transferStudentDay(studentId, day) {
  try {
    await api(`/api/students/${studentId}/transfer-day`, {
      method: 'POST',
      body: JSON.stringify({ day }),
    });
    showToast(day ? `Transferred to Call for ${day}` : 'Removed from scheduled day', 'success');
    await Promise.all([
      refreshDayBadges(),
      !document.getElementById('view-approved-dated').classList.contains('hidden') ? loadApprovedDated() : Promise.resolve(),
      !document.getElementById('view-call-monday').classList.contains('hidden') ? loadScheduledDay('Monday') : Promise.resolve(),
      !document.getElementById('view-call-tuesday').classList.contains('hidden') ? loadScheduledDay('Tuesday') : Promise.resolve(),
    ]);
  } catch (err) {
    showToast(err.message || 'Transfer failed', 'error');
  }
}

async function refreshDayBadges() {
  const [monData, tueData] = await Promise.all([
    api('/api/students/scheduled-day?day=Monday').catch(() => null),
    api('/api/students/scheduled-day?day=Tuesday').catch(() => null),
  ]);
  const monCount = Number(monData?.overallTotal ?? 0);
  const tueCount = Number(tueData?.overallTotal ?? 0);

  const monNav = document.getElementById('nav-monday-badge');
  if (monNav) monNav.textContent = monCount;
  const tueNav = document.getElementById('nav-tuesday-badge');
  if (tueNav) tueNav.textContent = tueCount;

  const monSummary = document.getElementById('approved-monday-count');
  if (monSummary) monSummary.textContent = monCount;
  const tueSummary = document.getElementById('approved-tuesday-count');
  if (tueSummary) tueSummary.textContent = tueCount;
  const totalSummary = document.getElementById('approved-montue-total');
  if (totalSummary) totalSummary.textContent = monCount + tueCount;
}

async function loadScheduledDay(day) {
  const key = day.toLowerCase();
  const search = document.getElementById(`${key}-filter-search`)?.value.trim() || '';
  const district = document.getElementById(`${key}-filter-district`)?.value || '';
  const stateKey = day === 'Monday' ? 'mondayStaffId' : 'tuesdayStaffId';
  const staffId = state[stateKey] || '';

  const params = new URLSearchParams({ day });
  if (search) params.set('search', search);
  if (district) params.set('district', district);
  if (staffId) params.set('staffId', staffId);

  const data = await api(`/api/students/scheduled-day?${params.toString()}`);

  const distSel = document.getElementById(`${key}-filter-district`);
  if (distSel && data.districts) {
    const prev = distSel.value;
    distSel.innerHTML = `<option value="">All Districts</option>${data.districts
      .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
      .join('')}`;
    distSel.value = prev;
  }

  const pillsEl = document.getElementById(`${key}-staff-pills`);
  if (pillsEl && data.staffBreakdown) {
    const pills = [
      `<button type="button" class="pill-filter ${!staffId ? 'active' : ''}" data-day-staff="">All (${data.overallTotal})</button>`,
      ...data.staffBreakdown.map(
        (s) =>
          `<button type="button" class="pill-filter ${String(staffId) === String(s.id) ? 'active' : ''}" data-day-staff="${s.id}">${escapeHtml(s.full_name)} (${s.count})</button>`
      ),
    ];
    pillsEl.innerHTML = pills.join('');
    pillsEl.querySelectorAll('.pill-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        state[stateKey] = btn.dataset.dayStaff || '';
        loadScheduledDay(day);
      });
    });
  }

  const navBadge = document.getElementById(`nav-${key}-badge`);
  if (navBadge) navBadge.textContent = data.overallTotal ?? data.total;
  const totalLabel = document.getElementById(`${key}-total-label`);
  if (totalLabel) totalLabel.textContent = `${data.total} scheduled`;

  renderScheduledDay(day, data.rows || []);
}

function renderScheduledDay(day, rows) {
  const key = day.toLowerCase();
  const otherDay = day === 'Monday' ? 'Tuesday' : 'Monday';
  const tbody = document.getElementById(`${key}-tbody`);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="muted">No establishments transferred to Call for ${day} yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((s, idx) => {
      const pdfMatch = String(s.registration_number || '').match(/^IHQA-(?:TAF|QIR)-(\d+)$/);
      const displayNo = pdfMatch ? Number(pdfMatch[1]) : idx + 1;
      const phone = s.coordinator_mobile || s.student_mobile || '';
      const cleanPhone = String(phone).replace(/[^\d+]/g, '');
      const email = s.coordinator_email || s.email || '';
      const locationLine = [s.institution_place, s.district, 'Kerala'].filter(Boolean).join(', ');
      const approvedAt = s.last_called_at || s.updated_at || '';

      return `<tr>
        <td data-label="#"><strong>${displayNo}</strong></td>
        <td data-label="Institution">
          <div class="inst-title">${escapeHtml(s.institution_name)}</div>
          <div class="inst-loc">${escapeHtml(locationLine)}</div>
        </td>
        <td data-label="Supervisor & Contact">
          <div class="sup-name">${escapeHtml(s.coordinator_name || s.student_name)}</div>
          <div class="sup-contact">
            ${cleanPhone ? `<a href="tel:${escapeHtml(cleanPhone)}" class="sup-phone-link" title="Tap to call">📞 ${escapeHtml(phone)}</a><a href="${escapeHtml(buildWhatsAppUrl(cleanPhone))}" target="_blank" rel="noopener" class="sup-wa-link" title="Send WhatsApp message">💬 WhatsApp</a>` : '<span class="muted">No phone</span>'}
            ${email ? `<span class="sup-email"> · ${escapeHtml(email)}</span>` : ''}
          </div>
        </td>
        <td data-label="Category & Winner">
          <div class="cat-breakdown-label">${escapeHtml(s.exam_category)}:</div>
          <div class="cat-breakdown-winner">${escapeHtml(s.student_name)}</div>
        </td>
        <td data-label="Handled By">
          <span class="badge badge-neutral">${escapeHtml(s.assigned_staff_name || '-')}</span>
        </td>
        <td data-label="Approved Date">
          <span class="small" style="font-weight:600;color:#065f46">${escapeHtml(approvedAt)}</span>
        </td>
        <td data-label="Actions">
          <div class="day-transfer-btns">
            <button type="button" class="btn btn-sm btn-outline btn-move-day" data-id="${s.id}" data-day="${otherDay}">Move to ${otherDay}</button>
            <button type="button" class="btn btn-sm btn-outline btn-move-day" data-id="${s.id}" data-day="">Remove</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('.btn-move-day').forEach((btn) => {
    btn.addEventListener('click', () => {
      transferStudentDay(Number(btn.dataset.id), btn.dataset.day || null);
    });
  });
}

async function loadUnuploadedCampuses() {
  const search = document.getElementById('u-filter-search')?.value.trim() || '';
  const district = document.getElementById('u-filter-district')?.value || '';
  const staffId = document.getElementById('u-filter-staff')?.value || '';
  const status = document.getElementById('u-filter-status')?.value || '';

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (district) params.set('district', district);
  if (staffId) params.set('staffId', staffId);
  if (status) params.set('status', status);

  const data = await api(`/api/campuses?${params.toString()}`);

  const distSel = document.getElementById('u-filter-district');
  if (distSel && data.districts) {
    const prev = distSel.value;
    distSel.innerHTML = `<option value="">All Districts</option>${data.districts
      .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`)
      .join('')}`;
    distSel.value = prev;
  }

  const staffSel = document.getElementById('u-filter-staff');
  if (staffSel && data.staffList) {
    const prevStaff = staffSel.value;
    staffSel.innerHTML = `<option value="">All Assigned Staff</option>${data.staffList
      .map((s) => `<option value="${s.id}">${escapeHtml(s.full_name)}</option>`)
      .join('')}`;
    staffSel.value = prevStaff;
  }

  const pillsEl = document.getElementById('unuploaded-staff-pills');
  if (pillsEl && data.staffBreakdown) {
    const allCount = data.overallTotal ?? data.stats.total;
    const pills = [
      `<button type="button" class="pill-filter ${!staffId ? 'active' : ''}" data-staff-id="">All (${allCount})</button>`,
      ...data.staffBreakdown.map(
        (s) =>
          `<button type="button" class="pill-filter ${String(staffId) === String(s.id) ? 'active' : ''}" data-staff-id="${s.id}">${escapeHtml(s.full_name)} (${s.count})</button>`
      ),
    ];
    pillsEl.innerHTML = pills.join('');
    pillsEl.querySelectorAll('.pill-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (staffSel) staffSel.value = btn.dataset.staffId || '';
        loadUnuploadedCampuses();
      });
    });
  }

  document.getElementById('nav-unuploaded-badge').textContent = data.overallTotal ?? data.stats.total;
  document.getElementById('unuploaded-total-label').textContent = `${data.total} campuses`;

  const kpiHtml = [
    { label: 'Total Campuses', value: data.stats.total, cls: '', filterStatus: '' },
    { label: 'Pending Calls', value: data.stats.pending, cls: 'warn', filterStatus: 'PENDING_ALL' },
    { label: 'Attended', value: data.stats.attended, cls: 'success', filterStatus: 'Successfully Contacted' },
    { label: 'Unattended', value: data.stats.unattended, cls: 'warn', filterStatus: 'UNATTENDED' },
    { label: 'Auto-Emailed', value: data.stats.emailSent, cls: '', filterStatus: 'EMAIL_SENT' },
    { label: 'Calls Made', value: data.stats.callsMade || 0, cls: '', filterStatus: 'CALLS_MADE' },
  ]
    .map((c) => {
      const isActive = status === c.filterStatus && c.filterStatus !== '';
      return `<div class="kpi-card clickable ${c.cls} ${isActive ? 'kpi-active' : ''}" data-u-kpi-status="${escapeHtml(c.filterStatus)}" title="Click to view ${escapeHtml(c.label)}">
        <div class="kpi-label">${escapeHtml(c.label)}</div>
        <div class="kpi-value">${c.value}</div>
      </div>`;
    })
    .join('');
  const uKpiGrid = document.getElementById('unuploaded-kpi-grid');
  uKpiGrid.innerHTML = kpiHtml;
  uKpiGrid.querySelectorAll('.kpi-card.clickable').forEach((card) => {
    card.addEventListener('click', async () => {
      const targetStatus = card.dataset.uKpiStatus ?? '';
      const statusSel = document.getElementById('u-filter-status');
      if (statusSel) statusSel.value = targetStatus;
      await loadUnuploadedCampuses();
      document.getElementById('unuploaded-tbody')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  state.unuploadedCampuses = data.rows || [];
  renderUnuploadedCampuses(data.rows);
}

function renderUnuploadedCampuses(rows) {
  const tbody = document.getElementById('unuploaded-tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No unuploaded campuses match the active filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((c) => {
      const cleanPhone = String(c.supervisor_phone || '').replace(/[^\d+]/g, '');
      const locationLine = [c.place, c.district, c.state].filter(Boolean).join(', ');
      const isAttended =
        c.communication_status === 'Successfully Contacted' ||
        c.communication_status === 'Follow-up Completed';

      const actionHtml = isAttended
        ? `<div class="row-action-btns is-attended">
            <button type="button" class="btn btn-sm row-attend-btn attended-done" disabled title="Call marked as Attended">✅ Attended</button>
            <button type="button" class="btn btn-sm row-undo-btn u-undo-btn" data-id="${c.id}" title="Undo Attended — Revert to previous status">↩ Undo</button>
          </div>`
        : `<div class="row-action-btns">
            <button type="button" class="btn btn-sm row-attend-btn u-attend-btn" data-id="${c.id}" title="Mark call attended and save">✅ Attend</button>
            <button type="button" class="btn btn-sm row-unattend-btn u-unattend-btn" data-id="${c.id}" data-label="${escapeHtml(c.institution_name)}" title="Select unattended reason and save">❌ Unattend</button>
          </div>`;

      const subBadgeClass =
        c.submission_status === 'Winner Added'
          ? 'badge-success'
          : c.submission_status === 'Canceled Program'
            ? 'badge-danger'
            : 'badge-warn';

      const subOptionsHtml = isAttended
        ? `<div class="sub-status-actions">
            <button type="button" class="u-sub-btn ${c.submission_status === 'Winner Added' ? 'active-win' : ''}" data-id="${c.id}" data-sub="Winner Added">✅ Winner Added</button>
            <button type="button" class="u-sub-btn ${c.submission_status === 'Canceled Program' ? 'active-cancel' : ''}" data-id="${c.id}" data-sub="Canceled Program">🚫 Canceled Program</button>
          </div>`
        : '';

      return `<tr>
        <td data-label="#"><strong>${c.serial_no}</strong></td>
        <td data-label="Institution">
          <div class="inst-title">${escapeHtml(c.institution_name)}</div>
          <div class="inst-loc">${escapeHtml(locationLine)}</div>
        </td>
        <td data-label="Supervisor & Contact">
          <div class="sup-name">${escapeHtml(c.supervisor_name || '-')}</div>
          <div class="sup-contact">
            ${cleanPhone ? `<a href="tel:${escapeHtml(cleanPhone)}" class="sup-phone-link" title="Tap to call">📞 ${escapeHtml(c.supervisor_phone)}</a><a href="${escapeHtml(buildWhatsAppUrl(cleanPhone))}" target="_blank" rel="noopener" class="sup-wa-link" title="Send WhatsApp message">💬 WhatsApp</a>` : '<span class="muted">No phone</span>'}
            <button type="button" class="sup-edit-btn u-edit-btn" data-id="${c.id}" title="Edit institution or contact details">✏️ Edit</button>
            ${c.supervisor_email ? `<span class="sup-email"> · ${escapeHtml(c.supervisor_email)}</span>` : ''}
          </div>
        </td>
        <td data-label="Enrolled / Winners" class="num-col">
          <span class="students-count">${c.enrolled_students} / ${c.winners_declared}</span>
        </td>
        <td data-label="Submission Status" class="center-col">
          <span class="badge ${subBadgeClass}">${escapeHtml(c.submission_status)}</span>
          ${subOptionsHtml}
        </td>
        <td data-label="Call Status & Action">
          <div style="margin-bottom:6px">
            <span class="badge ${statusBadgeClass(c.communication_status)}">${escapeHtml(c.communication_status)}</span>
            <span class="badge badge-neutral">${c.valid_attempt_count}/${state.workflowConfig?.maxAttempts || 2}</span>
            <div class="muted small" style="margin-top:2px">${escapeHtml(c.assigned_staff_name || 'Unassigned')}</div>
          </div>
          ${actionHtml}
        </td>
      </tr>`;
    })
    .join('');

  document.querySelectorAll('.u-attend-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      await quickSaveCampusCall(Number(btn.dataset.id), 'Successfully Contacted');
      btn.disabled = false;
    });
  });

  document.querySelectorAll('.u-unattend-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      openUnattendPopup({
        campusId: Number(btn.dataset.id),
        label: btn.dataset.label || '',
      });
    });
  });

  document.querySelectorAll('.u-undo-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api(`/api/campuses/${btn.dataset.id}/calls/undo`, { method: 'POST' });
        showToast('↩ Campus call reverted to Pending');
        await loadUnuploadedCampuses();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '↩ Undo';
      }
    });
  });

  document.querySelectorAll('.u-sub-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const nextSub = btn.dataset.sub;
      btn.disabled = true;
      try {
        await api(`/api/campuses/${id}/submission-status`, {
          method: 'PATCH',
          body: JSON.stringify({ submissionStatus: nextSub }),
        });
        showToast(`Updated: ${nextSub}`);
        await loadUnuploadedCampuses();
      } catch (err) {
        showToast(err.message);
      } finally {
        btn.disabled = false;
      }
    });
  });

  document.querySelectorAll('.u-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const campus = (state.unuploadedCampuses || []).find((x) => x.id === id);
      if (!campus) return;
      document.getElementById('ec-id').value = campus.id;
      document.getElementById('ec-institution').value = campus.institution_name || '';
      document.getElementById('ec-place').value = campus.place || '';
      document.getElementById('ec-district').value = campus.district || '';
      document.getElementById('ec-supervisor').value = campus.supervisor_name || '';
      document.getElementById('ec-phone').value = campus.supervisor_phone || '';
      document.getElementById('ec-email').value = campus.supervisor_email || '';
      document.getElementById('edit-campus-modal').classList.remove('hidden');
    });
  });
}

async function quickSaveCampusCall(campusId, callOutcome) {
  try {
    const res = await api(`/api/campuses/${campusId}/calls`, {
      method: 'POST',
      body: JSON.stringify({ callOutcome }),
    });
    if (callOutcome === 'Successfully Contacted') {
      showToast('✅ Saved: Attended');
    } else if (res.emailResult?.sent && !res.emailResult?.simulated) {
      showToast(`Saved: ${callOutcome} & Auto-email sent to supervisor`);
    } else {
      showToast(`Saved: ${callOutcome}`);
    }
    await loadUnuploadedCampuses();
  } catch (err) {
    showToast(err.message);
  }
}

// Event Wiring
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-demo-user]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('login-username').value = btn.dataset.demoUser;
      document.getElementById('login-password').value = btn.dataset.demoPass;
      document.getElementById('login-form').requestSubmit();
    });
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('login-username').value,
          password: document.getElementById('login-password').value,
        }),
      });
      state.user = data.user;
      enterApp();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });

  const doLogout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.user = null;
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  };
  document.getElementById('logout-btn').addEventListener('click', doLogout);
  document.getElementById('topbar-logout-btn')?.addEventListener('click', doLogout);

  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      switchView(item.dataset.view);
      document.querySelector('.sidebar')?.classList.remove('mobile-open');
    });
  });

  document.getElementById('mobile-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
  });

  document.querySelector('.main-content')?.addEventListener('click', () => {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
  });

  document.getElementById('open-notif-btn').addEventListener('click', () => switchView('notifications'));
  document.getElementById('refresh-all-btn').addEventListener('click', () => loadAllData().then(() => showToast('Refreshed')));

  document.querySelectorAll('.section-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.section-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      state.activeSection = tab.dataset.section || '';
      loadDashboardAndQueue();
    });
  });

  document.getElementById('shuffle-view-order-btn').addEventListener('click', () => {
    const arr = [...state.students];
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    state.students = arr;
    renderStudentsTable(arr);
    showToast('Calling list order shuffled');
  });

  document.getElementById('open-shuffle-modal-btn').addEventListener('click', () => {
    document.getElementById('shuffle-modal').classList.remove('hidden');
  });
  document.getElementById('close-shuffle-modal').addEventListener('click', () => {
    document.getElementById('shuffle-modal').classList.add('hidden');
  });
  document.getElementById('shuffle-section-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const staffIds = Array.from(document.querySelectorAll('.sh-staff-chk:checked')).map((c) => Number(c.value));
      const res = await api('/api/students/shuffle-by-section', {
        method: 'POST',
        body: JSON.stringify({
          section: document.getElementById('sh-section').value,
          staffIds,
          onlyPending: document.getElementById('sh-only-pending').checked,
        }),
      });
      document.getElementById('shuffle-modal').classList.add('hidden');
      const summaryText = res.distribution.map((d) => `${d.full_name}: ${d.assignedCount}`).join(' · ');
      showToast(`Shuffled ${res.totalShuffled} contacts (${summaryText})`);
      loadAllData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('toggle-all-kpis-btn').addEventListener('click', (e) => {
    state.showAllKpis = !state.showAllKpis;
    e.target.textContent = state.showAllKpis ? 'Show Summary Only' : 'Show All 10 Stats';
    if (state.lastStats) renderKpis(state.lastStats);
  });

  document.getElementById('toggle-more-filters-btn').addEventListener('click', (e) => {
    const form = document.getElementById('filter-form');
    form.classList.toggle('hidden');
    e.target.textContent = form.classList.contains('hidden') ? 'More Filters' : 'Hide Filters';
  });

  document.getElementById('f-quick-search').addEventListener('input', () => {
    clearTimeout(state.quickSearchTimer);
    state.quickSearchTimer = setTimeout(() => loadDashboardAndQueue(), 220);
  });

  document.querySelectorAll('.pill-filter').forEach((pill) => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.pill-filter').forEach((p) => p.classList.remove('active'));
      pill.classList.add('active');
      document.getElementById('f-status').value = pill.dataset.quickStatus || '';
      document.getElementById('f-attempts').value = pill.dataset.quickAttempts || '';
      loadDashboardAndQueue();
    });
  });

  document.querySelectorAll('.outcome-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.outcome-btn').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('log-outcome').value = btn.dataset.outcome;
    });
  });

  document.getElementById('filter-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadDashboardAndQueue();
  });

  document.getElementById('reset-filters-btn').addEventListener('click', () => {
    document.getElementById('filter-form').reset();
    document.getElementById('f-quick-search').value = '';
    document.querySelectorAll('.pill-filter').forEach((p, idx) => p.classList.toggle('active', idx === 0));
    loadDashboardAndQueue();
  });

  document.getElementById('select-all-students').addEventListener('change', (e) => {
    state.selectedStudentIds.clear();
    if (e.target.checked) state.students.forEach((s) => state.selectedStudentIds.add(s.id));
    renderStudentsTable(state.students);
    updateBulkBar();
  });

  document.getElementById('bulk-assign-btn').addEventListener('click', () => {
    if (state.selectedStudentIds.size === 0) return showToast('Select one or more students first');
    updateBulkBar();
  });

  document.getElementById('cancel-bulk-assign-btn').addEventListener('click', () => {
    state.selectedStudentIds.clear();
    renderStudentsTable(state.students);
    updateBulkBar();
  });

  document.getElementById('confirm-bulk-assign-btn').addEventListener('click', async () => {
    const staffId = document.getElementById('bulk-staff-select').value;
    await api('/api/students/assign', {
      method: 'POST',
      body: JSON.stringify({
        studentIds: Array.from(state.selectedStudentIds),
        staffId: staffId || null,
      }),
    });
    state.selectedStudentIds.clear();
    updateBulkBar();
    showToast('Student assignments updated');
    loadAllData();
  });

  // Calling Drawer controls
  const closeDrawer = () => document.getElementById('calling-drawer').classList.add('hidden');
  document.getElementById('close-drawer-btn').addEventListener('click', closeDrawer);
  document.getElementById('close-drawer-backdrop').addEventListener('click', closeDrawer);

  document.querySelectorAll('.phone-call-btn').forEach((link) => {
    link.addEventListener('click', async (e) => {
      if (link.getAttribute('href') === '#') {
        e.preventDefault();
        return showToast('No phone number available for this contact');
      }
      const contactType = link.dataset.contact;
      await startPhoneCallFlow(state.activeStudentId, contactType);
    });
  });

  document.querySelectorAll('.c2c-api-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const contactType = btn.dataset.contact;
        const res = await api(`/api/students/${state.activeStudentId}/click-to-call`, {
          method: 'POST',
          body: JSON.stringify({ contactType, mode: 'telephony_api' }),
        });
        await openCallingDesk(state.activeStudentId, {
          callSessionId: res.callSessionId,
          contactType,
          bannerHtml: `<strong>Call Initiated</strong> via <em>${escapeHtml(res.provider)}</em> (${escapeHtml(res.telephonyStatus)}) · Call ID: <code>${escapeHtml(res.externalCallId)}</code> · Not counted as attempt until valid outcome is logged.`,
        });
        showToast('Cloud telephony call initiated');
      } catch (err) {
        showToast(err.message);
      }
    });
  });

  document.getElementById('quick-attend-btn').addEventListener('click', async () => {
    await quickSaveCallOutcome(
      [state.activeStudentId],
      'Successfully Contacted',
      document.getElementById('log-contact-type').value || 'coordinator',
      document.getElementById('log-call-session-id').value || null
    );
  });

  document.getElementById('quick-unattend-btn').addEventListener('click', () => {
    openUnattendPopup({
      studentIds: [state.activeStudentId],
      contactType: document.getElementById('log-contact-type').value || 'coordinator',
      callSessionId: document.getElementById('log-call-session-id').value || null,
      label: document.getElementById('d-student-name').textContent || '',
    });
  });

  const deskUndoBtn = document.getElementById('quick-undo-btn');
  if (deskUndoBtn) {
    deskUndoBtn.addEventListener('click', async () => {
      deskUndoBtn.disabled = true;
      deskUndoBtn.textContent = '...';
      try {
        await api(`/api/students/${state.activeStudentId}/calls/undo`, { method: 'POST' });
        showToast('↩ Call reverted to Pending');
        await loadAllData();
        await openCallingDesk(state.activeStudentId);
      } catch (err) {
        showToast(err.message);
      } finally {
        deskUndoBtn.disabled = false;
        deskUndoBtn.textContent = '↩ Undo Attended';
      }
    });
  }

  const unattendModal = document.getElementById('unattend-modal');
  document.getElementById('close-unattend-modal').addEventListener('click', () => {
    unattendModal.classList.add('hidden');
    state.pendingUnattendTarget = null;
  });
  unattendModal.addEventListener('click', (e) => {
    if (e.target === unattendModal) {
      unattendModal.classList.add('hidden');
      state.pendingUnattendTarget = null;
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !unattendModal.classList.contains('hidden')) {
      unattendModal.classList.add('hidden');
      state.pendingUnattendTarget = null;
    }
  });

  document.querySelectorAll('.unattend-choice-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.pendingUnattendTarget) return;
      const { studentIds, campusId, contactType, callSessionId } = state.pendingUnattendTarget;
      const outcome = btn.dataset.outcome;
      document.getElementById('unattend-modal').classList.add('hidden');
      state.pendingUnattendTarget = null;
      if (campusId) {
        await quickSaveCampusCall(campusId, outcome);
      } else {
        await quickSaveCallOutcome(studentIds, outcome, contactType, callSessionId);
      }
    });
  });

  let uSearchTimer = null;
  document.getElementById('u-filter-search')?.addEventListener('input', () => {
    clearTimeout(uSearchTimer);
    uSearchTimer = setTimeout(loadUnuploadedCampuses, 260);
  });
  document.getElementById('u-filter-district')?.addEventListener('change', loadUnuploadedCampuses);
  document.getElementById('u-filter-staff')?.addEventListener('change', loadUnuploadedCampuses);
  document.getElementById('u-filter-status')?.addEventListener('change', loadUnuploadedCampuses);

  let aSearchTimer = null;
  document.getElementById('a-filter-search')?.addEventListener('input', () => {
    clearTimeout(aSearchTimer);
    aSearchTimer = setTimeout(loadApprovedDated, 240);
  });
  document.getElementById('a-filter-district')?.addEventListener('change', loadApprovedDated);
  document.querySelectorAll('[data-jump-view]').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.jumpView));
  });

  let mondaySearchTimer = null;
  document.getElementById('monday-filter-search')?.addEventListener('input', () => {
    clearTimeout(mondaySearchTimer);
    mondaySearchTimer = setTimeout(() => loadScheduledDay('Monday'), 240);
  });
  document.getElementById('monday-filter-district')?.addEventListener('change', () => loadScheduledDay('Monday'));

  let tuesdaySearchTimer = null;
  document.getElementById('tuesday-filter-search')?.addEventListener('input', () => {
    clearTimeout(tuesdaySearchTimer);
    tuesdaySearchTimer = setTimeout(() => loadScheduledDay('Tuesday'), 240);
  });
  document.getElementById('tuesday-filter-district')?.addEventListener('change', () => loadScheduledDay('Tuesday'));

  const editCampusModal = document.getElementById('edit-campus-modal');
  document.getElementById('close-edit-campus-modal')?.addEventListener('click', () => {
    editCampusModal.classList.add('hidden');
  });
  editCampusModal?.addEventListener('click', (e) => {
    if (e.target === editCampusModal) editCampusModal.classList.add('hidden');
  });
  document.getElementById('edit-campus-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('ec-id').value;
    try {
      await api(`/api/campuses/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          institution_name: document.getElementById('ec-institution').value,
          place: document.getElementById('ec-place').value,
          district: document.getElementById('ec-district').value,
          supervisor_name: document.getElementById('ec-supervisor').value,
          supervisor_phone: document.getElementById('ec-phone').value,
          supervisor_email: document.getElementById('ec-email').value,
        }),
      });
      editCampusModal.classList.add('hidden');
      showToast('✅ Campus details updated');
      await loadUnuploadedCampuses();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const ta = document.getElementById('log-remarks');
      ta.value = ta.value ? `${ta.value} ${chip.dataset.note}` : chip.dataset.note;
    });
  });

  document.getElementById('log-call-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const followupVal = document.getElementById('log-followup-date').value;
      const res = await api(`/api/students/${state.activeStudentId}/calls`, {
        method: 'POST',
        body: JSON.stringify({
          callSessionId: document.getElementById('log-call-session-id').value || null,
          contactType: document.getElementById('log-contact-type').value,
          callOutcome: document.getElementById('log-outcome').value,
          callDurationSeconds: document.getElementById('log-duration').value || null,
          followupDate: followupVal ? followupVal.replace('T', ' ') + ':00' : null,
          remarks: document.getElementById('log-remarks').value,
          isValidAttempt: true,
          markFollowupCompleted: document.getElementById('log-complete-followup').checked,
        }),
      });
      showToast(
        res.emailResult?.emailRecord?.delivery_status === 'SENT'
          ? 'Call logged & 3-attempt automatic email sent'
          : 'Call outcome logged'
      );
      await openCallingDesk(state.activeStudentId);
      await loadAllData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('cancel-initiation-btn').addEventListener('click', async () => {
    await api(`/api/students/${state.activeStudentId}/calls`, {
      method: 'POST',
      body: JSON.stringify({
        callSessionId: document.getElementById('log-call-session-id').value || null,
        contactType: document.getElementById('log-contact-type').value,
        isValidAttempt: false,
        remarks: document.getElementById('log-remarks').value || 'Accidental click / failed initiation',
      }),
    });
    showToast('Recorded as cancelled/failed initiation (attempt count unchanged)');
    await openCallingDesk(state.activeStudentId);
    await loadAllData();
  });

  document.getElementById('send-unattended-now-btn').addEventListener('click', async () => {
    try {
      const res = await api(`/api/students/${state.activeStudentId}/send-unattended-email`, { method: 'POST' });
      if (res.duplicatePrevented) showToast('Email already sent for this sequence');
      else if (res.skippedNoEmail) showToast('No valid email on record (flagged for manual follow-up)');
      else showToast(`Email status: ${res.emailRecord?.delivery_status || 'Processed'}`);
      await openCallingDesk(state.activeStudentId);
      await loadAllData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('edit-contact-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api(`/api/students/${state.activeStudentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        studentMobile: document.getElementById('e-student-mobile').value,
        parentMobile: document.getElementById('e-parent-mobile').value,
        email: document.getElementById('e-email').value,
        communicationStatus: document.getElementById('e-status').value || undefined,
      }),
    });
    showToast('Contact record updated');
    await openCallingDesk(state.activeStudentId);
    await loadAllData();
  });

  document.getElementById('reset-invalid-btn').addEventListener('click', async () => {
    await api(`/api/students/${state.activeStudentId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        studentMobile: document.getElementById('e-student-mobile').value,
        parentMobile: document.getElementById('e-parent-mobile').value,
        resetInvalidFlag: true,
      }),
    });
    showToast('Wrong-number flag cleared');
    await openCallingDesk(state.activeStudentId);
    await loadAllData();
  });

  // Modals
  document.getElementById('open-add-student-btn').addEventListener('click', () => document.getElementById('student-modal').classList.remove('hidden'));
  document.getElementById('close-student-modal').addEventListener('click', () => document.getElementById('student-modal').classList.add('hidden'));
  document.getElementById('add-student-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/students', {
        method: 'POST',
        body: JSON.stringify({
          registrationNumber: document.getElementById('ns-reg').value,
          studentName: document.getElementById('ns-name').value,
          parentName: document.getElementById('ns-parent').value,
          district: document.getElementById('ns-district').value,
          studentMobile: document.getElementById('ns-smob').value,
          parentMobile: document.getElementById('ns-pmob').value,
          email: document.getElementById('ns-email').value,
          examCategory: document.getElementById('ns-cat').value,
          institutionName: document.getElementById('ns-inst').value,
          assignedStaffId: document.getElementById('ns-staff').value || null,
        }),
      });
      document.getElementById('student-modal').classList.add('hidden');
      document.getElementById('add-student-form').reset();
      showToast('Student registered');
      loadAllData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('open-add-staff-btn').addEventListener('click', () => document.getElementById('staff-modal').classList.remove('hidden'));
  document.getElementById('close-staff-modal').addEventListener('click', () => document.getElementById('staff-modal').classList.add('hidden'));
  document.getElementById('add-staff-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/staff', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('nst-user').value,
          password: document.getElementById('nst-pass').value,
          fullName: document.getElementById('nst-name').value,
          email: document.getElementById('nst-email').value,
          phone: document.getElementById('nst-phone').value,
          role: document.getElementById('nst-role').value,
          dailyTarget: Number(document.getElementById('nst-target').value),
        }),
      });
      document.getElementById('staff-modal').classList.add('hidden');
      document.getElementById('add-staff-form').reset();
      showToast('Staff account created');
      loadStaffView();
      loadDashboardAndQueue();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('reassign-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await api('/api/staff/reassign-pending', {
      method: 'POST',
      body: JSON.stringify({
        fromStaffId: document.getElementById('reassign-from').value,
        toStaffId: document.getElementById('reassign-to').value,
      }),
    });
    showToast(`Reassigned ${res.updatedCount} pending student(s)`);
    loadStaffView();
    loadAllData();
  });

  document.getElementById('mark-all-read-btn').addEventListener('click', async () => {
    await api('/api/notifications/read-all', { method: 'POST' });
    loadNotifications();
  });

  document.getElementById('send-unattended-emails-btn').addEventListener('click', async () => {
    try {
      const { summary } = await api('/api/emails/send-unattended', { method: 'POST' });
      showToast(
        `Unattended auto-mail: ${summary.sentCount} sent, ${summary.skippedNoEmailCount} no-email, ${summary.failedCount} failed`
      );
      loadNotifications();
      loadAllData();
    } catch (err) {
      showToast(err.message);
    }
  });

  document.getElementById('process-retries-btn').addEventListener('click', async () => {
    const res = await api('/api/emails/process-retries', { method: 'POST' });
    showToast(`Processed ${res.processedCount} email retry(ies)`);
    loadNotifications();
  });

  document.querySelectorAll('#report-tabs .tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#report-tabs .tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadReport(btn.dataset.report);
    });
  });

  document.getElementById('export-csv-btn').addEventListener('click', () => {
    window.location.href = `/api/reports/${state.activeReport}/export?format=csv`;
  });
  document.getElementById('export-excel-btn').addEventListener('click', () => {
    window.location.href = `/api/reports/${state.activeReport}/export?format=excel`;
  });

  document.getElementById('apply-est-preset-btn')?.addEventListener('click', () => {
    document.getElementById('s-est-name').value = 'India Holy Quran Award — Kerala Coordination Office';
    document.getElementById('s-est-hours').value = '09:00 AM - 06:00 PM IST';
    document.getElementById('s-est-start').value = 9;
    document.getElementById('s-est-end').value = 18;
    document.getElementById('s-max-attempts').value = 3;
    document.getElementById('s-retry-hours').value = 4;
    document.getElementById('s-telephony-provider').value = 'device_phone';
    document.getElementById('s-official-email').value = 'info@indiaquranaward.com';
    document.getElementById('s-official-website').value = 'https://indiaquranaward.com';
    document.getElementById('s-auto-email').checked = true;
    document.getElementById('s-auto-unattended-email').checked = true;
    showToast('Loaded Establishment Office defaults — click Save Configuration to apply');
  });

  document.getElementById('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({
        establishment_name: document.getElementById('s-est-name').value,
        establishment_calling_hours: document.getElementById('s-est-hours').value,
        establishment_start_hour: document.getElementById('s-est-start').value,
        establishment_end_hour: document.getElementById('s-est-end').value,
        max_attempts: document.getElementById('s-max-attempts').value,
        retry_interval_hours: document.getElementById('s-retry-hours').value,
        email_retry_max: document.getElementById('s-email-retries').value,
        data_retention_days: document.getElementById('s-retention-days').value,
        telephony_provider: document.getElementById('s-telephony-provider').value,
        email_provider: document.getElementById('s-email-provider').value,
        smtp_host: document.getElementById('s-smtp-host').value,
        smtp_port: document.getElementById('s-smtp-port').value,
        smtp_user: document.getElementById('s-smtp-user').value,
        smtp_pass: document.getElementById('s-smtp-pass').value,
        smtp_secure: String(document.getElementById('s-smtp-secure').checked),
        email_from: document.getElementById('s-email-from').value,
        official_contact_phone: document.getElementById('s-official-phone').value,
        official_contact_email: document.getElementById('s-official-email').value,
        official_website_url: document.getElementById('s-official-website').value,
        auto_email_on_max_attempts: String(document.getElementById('s-auto-email').checked),
        auto_email_on_unattended: String(document.getElementById('s-auto-unattended-email').checked),
        channel_email_enabled: String(document.getElementById('s-ch-email').checked),
        channel_in_platform_enabled: String(document.getElementById('s-ch-inapp').checked),
        channel_sms_enabled: String(document.getElementById('s-ch-sms').checked),
        channel_whatsapp_enabled: String(document.getElementById('s-ch-wa').checked),
      }),
    });
    showToast('Configuration saved');
    loadSettingsAndAudit();
  });

  document.getElementById('btn-send-test-email')?.addEventListener('click', async () => {
    const target = document.getElementById('s-test-email-target').value.trim();
    const resultBox = document.getElementById('test-email-result');
    resultBox.innerHTML = '<span class="muted">⏳ Connecting to mail server and dispatching test email...</span>';
    try {
      const res = await api('/api/settings/test-email', {
        method: 'POST',
        body: JSON.stringify({ to: target }),
      });
      resultBox.innerHTML = `<span style="color:#027a48;font-weight:700">✅ ${escapeHtml(res.message)}</span>`;
      showToast('✅ Test email delivered successfully');
    } catch (err) {
      resultBox.innerHTML = `<span style="color:#b42318;font-weight:700">❌ ${escapeHtml(err.message)}</span>`;
      showToast(`Email Test Failed: ${err.message}`);
    }
  });

  document.getElementById('run-jobs-btn').addEventListener('click', async () => {
    const { summary } = await api('/api/settings/run-jobs', { method: 'POST' });
    showToast(`Sweep complete: ${summary.overdueAlertsCreated} overdue alerts, ${summary.emailRetriesProcessed} email retries`);
    loadNotifications();
    loadSettingsAndAudit();
  });

  checkSession();
});

window.openCallingDesk = openCallingDesk;
