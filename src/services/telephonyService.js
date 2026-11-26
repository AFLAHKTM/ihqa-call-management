const crypto = require('node:crypto');
const config = require('../config');
const { getDb, getSettingsMap } = require('../db/database');
const { sanitizePhone } = require('../utils/security');
const { logAudit } = require('./auditService');

async function initiateClickToCall(
  { studentId, contactType = 'student', mode = 'telephony_api', staffUser },
  db = getDb()
) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId);
  if (!student) throw new Error('Student not found');

  let targetNumber = '';
  if (contactType === 'parent') targetNumber = student.parent_mobile;
  else if (contactType === 'coordinator') targetNumber = student.coordinator_mobile;
  else targetNumber = student.student_mobile;

  const cleanNumber = sanitizePhone(targetNumber);
  if (!cleanNumber) {
    throw new Error(`No phone number available for ${contactType}`);
  }

  const settings = getSettingsMap(db);
  const provider = settings.telephony_provider || config.telephony.provider;
  const recordingEnabled = false; // Strictly disabled by default per Section M

  // Device phone fallback (tel: link) does not count as completed attempt until staff logs outcome
  if (mode === 'device_tel') {
    const info = db
      .prepare(
        `INSERT INTO call_attempts (
          student_id, staff_id, attempt_number, is_valid_attempt, initiation_mode,
          telephony_provider, telephony_status, contact_type, contact_number_called, remarks
        ) VALUES (?, ?, NULL, 0, 'device_tel', 'device_phone', 'initiated_device_tel', ?, ?, 'Dialed via device phone app; awaiting outcome logging.')`
      )
      .run(student.id, staffUser.id, contactType, cleanNumber);

    logAudit(
      {
        user: staffUser,
        action: 'CALL_INITIATED_DEVICE_TEL',
        entityType: 'call_attempt',
        entityId: Number(info.lastInsertRowid),
        details: { studentId: student.id, contactType, cleanNumber },
      },
      db
    );

    return {
      callSessionId: Number(info.lastInsertRowid),
      mode: 'device_tel',
      provider: 'device_phone',
      telUri: `tel:${cleanNumber}`,
      targetNumber: cleanNumber,
      telephonyStatus: 'initiated_device_tel',
      recordingEnabled,
      countedAsAttempt: false,
    };
  }

  // Cloud Telephony API Integration (Exotel / Twilio / Simulated Sandbox)
  let externalCallId = `${provider.toUpperCase()}-${crypto.randomUUID().slice(0, 8)}`;
  let telephonyStatus = 'initiated';

  if (provider === 'exotel' && config.telephony.exotel.sid && config.telephony.exotel.apiKey) {
    const { sid, apiKey, apiToken, callerId, subdomain } = config.telephony.exotel;
    const staffPhone = sanitizePhone(staffUser.phone || callerId);
    const url = `https://${encodeURIComponent(apiKey)}:${encodeURIComponent(apiToken)}@${subdomain}/v1/Accounts/${sid}/Calls/connect.json`;
    const body = new URLSearchParams({
      From: staffPhone,
      To: cleanNumber,
      CallerId: callerId,
      Record: 'false', // Call recording disabled by default
    });
    const res = await fetch(url, { method: 'POST', body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.RestException?.Message || `Exotel API error (${res.status})`);
    }
    externalCallId = data?.Call?.Sid || externalCallId;
    telephonyStatus = data?.Call?.Status || 'in-progress';
  } else if (provider === 'twilio' && config.telephony.twilio.accountSid && config.telephony.twilio.authToken) {
    const { accountSid, authToken, fromNumber } = config.telephony.twilio;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`;
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const body = new URLSearchParams({
      To: cleanNumber,
      From: fromNumber,
      Record: 'false',
      Url: 'http://demo.twilio.com/docs/voice.xml',
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.message || `Twilio API error (${res.status})`);
    }
    externalCallId = data?.sid || externalCallId;
    telephonyStatus = data?.status || 'queued';
  } else {
    // Simulated cloud telephony sandbox when live Exotel/Twilio credentials are not configured
    telephonyStatus = 'ringing_simulated';
  }

  // IMPORTANT (Section E): Initiating a call creates a pending call session with is_valid_attempt = 0.
  // Accidental clicks or failed call initiations do NOT count as completed attempts!
  const info = db
    .prepare(
      `INSERT INTO call_attempts (
        student_id, staff_id, attempt_number, is_valid_attempt, initiation_mode,
        telephony_provider, external_call_id, telephony_status, contact_type, contact_number_called, remarks
      ) VALUES (?, ?, NULL, 0, 'telephony_api', ?, ?, ?, ?, ?, 'Click-to-call initiated; awaiting call outcome.')`
    )
    .run(student.id, staffUser.id, provider, externalCallId, telephonyStatus, contactType, cleanNumber);

  logAudit(
    {
      user: staffUser,
      action: 'CALL_INITIATED_TELEPHONY',
      entityType: 'call_attempt',
      entityId: Number(info.lastInsertRowid),
      details: { studentId: student.id, provider, externalCallId, contactType },
    },
    db
  );

  return {
    callSessionId: Number(info.lastInsertRowid),
    mode: 'telephony_api',
    provider,
    externalCallId,
    targetNumber: cleanNumber,
    telUri: `tel:${cleanNumber}`,
    telephonyStatus,
    recordingEnabled,
    countedAsAttempt: false,
  };
}

function handleTelephonyWebhook({ provider, payload }, db = getDb()) {
  const externalCallId = payload.CallSid || payload.Sid || payload.externalCallId;
  const rawStatus = String(payload.Status || payload.CallStatus || payload.status || '').toLowerCase();
  const duration = Number(payload.Duration || payload.CallDuration || payload.durationSeconds || 0);

  if (!externalCallId) {
    throw new Error('Missing CallSid / externalCallId in webhook payload');
  }

  const session = db
    .prepare('SELECT * FROM call_attempts WHERE external_call_id = ?')
    .get(externalCallId);

  if (!session) {
    return { matched: false, externalCallId };
  }

  db.prepare(
    `UPDATE call_attempts
     SET telephony_status = ?,
         call_duration_seconds = CASE WHEN ? > 0 THEN ? ELSE call_duration_seconds END
     WHERE id = ?`
  ).run(rawStatus || 'updated', duration, duration, session.id);

  logAudit(
    {
      action: 'TELEPHONY_WEBHOOK_RECEIVED',
      entityType: 'call_attempt',
      entityId: session.id,
      details: { provider, externalCallId, rawStatus, duration },
    },
    db
  );

  return {
    matched: true,
    callSessionId: session.id,
    telephonyStatus: rawStatus,
    durationSeconds: duration,
    isValidAttempt: Boolean(session.is_valid_attempt),
  };
}

module.exports = {
  initiateClickToCall,
  handleTelephonyWebhook,
};
