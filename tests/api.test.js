process.env.DISABLE_CLOUD_SYNC = 'true';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { initDatabase, closeDb, setDb } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seedData');
const { createApp } = require('../src/app');

async function req(baseUrl, path, { method = 'GET', body = null, cookie = '' } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text, setCookie, headers: res.headers };
}

describe('API Endpoints, RBAC, Click-to-Call Webhook & Exports', () => {
  let server;
  let baseUrl;
  let adminCookie = '';
  let staffArjunCookie = '';

  before(async () => {
    const db = initDatabase(':memory:');
    setDb(db);
    seedDatabase(db, { force: true });
    const app = createApp();
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
  });

  it('blocks unauthenticated access to student contact records', async () => {
    const res = await req(baseUrl, '/api/students');
    assert.equal(res.status, 401);
    const dash = await req(baseUrl, '/api/dashboard/summary');
    assert.equal(dash.status, 401);
  });

  it('authenticates admin and calling staff with HTTP-only cookies', async () => {
    const adminLogin = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@2026' },
    });
    assert.equal(adminLogin.status, 200);
    assert.equal(adminLogin.json.user.role, 'ADMIN');
    adminCookie = adminLogin.setCookie.split(';')[0];

    const staffLogin = await req(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { username: 'saeed_adany', password: 'Staff@2026' },
    });
    assert.equal(staffLogin.status, 200);
    assert.equal(staffLogin.json.user.role, 'CALLING_STAFF');
    staffArjunCookie = staffLogin.setCookie.split(';')[0];
  });

  it('enforces strict RBAC isolation so calling staff cannot view other staff students', async () => {
    const arjunList = await req(baseUrl, '/api/students', { cookie: staffArjunCookie });
    assert.equal(arjunList.status, 200);
    assert.ok(arjunList.json.rows.length > 0);
    for (const st of arjunList.json.rows) {
      assert.equal(st.assigned_staff_username, 'saeed_adany');
    }

    // Find a student assigned to shahid_adany via admin
    const adminList = await req(baseUrl, '/api/students', { cookie: adminCookie });
    const ayshaStudent = adminList.json.rows.find((s) => s.assigned_staff_username === 'shahid_adany');
    assert.ok(ayshaStudent);

    const forbiddenView = await req(baseUrl, `/api/students/${ayshaStudent.id}`, { cookie: staffArjunCookie });
    assert.equal(forbiddenView.status, 403);

    const forbiddenAssign = await req(baseUrl, '/api/students/assign', {
      method: 'POST',
      cookie: staffArjunCookie,
      body: { studentIds: [ayshaStudent.id], staffId: 3 },
    });
    assert.equal(forbiddenAssign.status, 403);
  });

  it('supports click-to-call initiation + telephony webhook without prematurely counting attempts', async () => {
    const list = await req(baseUrl, '/api/students?limit=1', { cookie: adminCookie });
    const student = list.json.rows[0];
    assert.ok(student);
    const beforeAttempts = student.valid_attempt_count;

    const c2c = await req(baseUrl, `/api/students/${student.id}/click-to-call`, {
      method: 'POST',
      cookie: adminCookie,
      body: { contactType: 'coordinator', mode: 'telephony_api' },
    });
    assert.equal(c2c.status, 200);
    assert.equal(c2c.json.countedAsAttempt, false);
    assert.equal(c2c.json.recordingEnabled, false);

    // Webhook updates duration without counting until outcome logged
    const webhook = await req(baseUrl, '/api/telephony/webhook/exotel', {
      method: 'POST',
      headers: { 'x-ihqa-webhook-secret': 'ihqa-webhook-secret' },
      body: { CallSid: c2c.json.externalCallId, Status: 'completed', Duration: '84' },
    });
    assert.equal(webhook.status, 200);
    assert.equal(webhook.json.matched, true);
    assert.equal(webhook.json.durationSeconds, 84);

    const afterWebhook = await req(baseUrl, `/api/students/${student.id}`, { cookie: adminCookie });
    assert.equal(afterWebhook.json.student.valid_attempt_count, beforeAttempts);
  });

  it('serves all 8 reports in JSON, CSV, and Excel (.xls) formats', async () => {
    const reportTypes = [
      'district',
      'institution',
      'staff',
      'daily',
      'three_attempt',
      'email',
      'callbacks',
      'invalid_contacts',
    ];
    for (const type of reportTypes) {
      const jsonRep = await req(baseUrl, `/api/reports/${type}`, { cookie: adminCookie });
      assert.equal(jsonRep.status, 200, `Expected 200 for report ${type}`);
      assert.ok(Array.isArray(jsonRep.json.columns));
      assert.ok(Array.isArray(jsonRep.json.rows));
    }

    const csvRes = await req(baseUrl, '/api/reports/district/export?format=csv', { cookie: adminCookie });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type'), /text\/csv/);
    assert.match(csvRes.text, /District,Total Students/);

    const xlsRes = await req(baseUrl, '/api/reports/institution/export?format=excel', { cookie: adminCookie });
    assert.equal(xlsRes.status, 200);
    assert.match(xlsRes.headers.get('content-type'), /application\/vnd\.ms-excel/);
    assert.match(xlsRes.text, /<Workbook/);
  });

  it('filters and shuffles students by Qirath and Tafseer sections', async () => {
    const qirathRes = await req(baseUrl, '/api/students?examCategory=Holy%20Quran%20Recitation', { cookie: adminCookie });
    assert.equal(qirathRes.status, 200);
    assert.equal(qirathRes.json.total, 235);

    const tafseerRes = await req(
      baseUrl,
      '/api/students?examCategory=Complete%20Memorization%20of%20the%20Holy%20Quran%20with%20Tafsir',
      { cookie: adminCookie }
    );
    assert.equal(tafseerRes.status, 200);
    assert.equal(tafseerRes.json.total, 101);

    const shuf = await req(baseUrl, '/api/students/shuffle-by-section', {
      method: 'POST',
      cookie: adminCookie,
      body: { section: 'tafseer', onlyPending: true },
    });
    assert.equal(shuf.status, 200);
    assert.equal(shuf.json.totalShuffled, 101);
  });
});
