const { getDb, getSettingsMap } = require('../db/database');
const { sendGenericEmail } = require('./emailService');

function dispatchNotification(
  {
    type,
    title,
    message,
    severity = 'info',
    targetUserId = null,
    targetRole = null,
    studentId = null,
    channels = null,
  },
  db = getDb()
) {
  const settings = getSettingsMap(db);
  const activeChannels = channels || [];
  if (!channels) {
    if (settings.channel_in_platform_enabled !== 'false') activeChannels.push('in_platform');
    if (settings.channel_email_enabled === 'true') activeChannels.push('email');
    if (settings.channel_sms_enabled === 'true') activeChannels.push('sms');
    if (settings.channel_whatsapp_enabled === 'true') activeChannels.push('whatsapp');
    if (activeChannels.length === 0) activeChannels.push('in_platform');
  }

  const deliveryResults = {};

  if (activeChannels.includes('in_platform')) {
    deliveryResults.in_platform = 'delivered';
  }
  if (activeChannels.includes('sms')) {
    deliveryResults.sms =
      settings.channel_sms_enabled === 'true'
        ? `queued (${settings.sms_provider_name || 'authorized-provider'})`
        : 'disabled';
  }
  if (activeChannels.includes('whatsapp')) {
    deliveryResults.whatsapp =
      settings.channel_whatsapp_enabled === 'true'
        ? `queued (${settings.whatsapp_provider_name || 'authorized-provider'})`
        : 'disabled';
  }

  let recipientIds = [];
  if (targetUserId) {
    recipientIds = [targetUserId];
  } else if (targetRole) {
    recipientIds = db
      .prepare('SELECT id, email FROM users WHERE role = ? AND is_active = 1')
      .all(targetRole)
      .map((u) => u.id);
  } else {
    recipientIds = db
      .prepare("SELECT id FROM users WHERE role IN ('ADMIN', 'SUPERVISOR') AND is_active = 1")
      .all()
      .map((u) => u.id);
  }

  const insertStmt = db.prepare(`
    INSERT INTO notifications (
      type, title, message, severity, target_user_id, target_role, student_id, channels_json, delivery_results_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const createdIds = [];
  if (recipientIds.length === 0) {
    const info = insertStmt.run(
      type,
      title,
      message,
      severity,
      null,
      targetRole,
      studentId,
      JSON.stringify(activeChannels),
      JSON.stringify(deliveryResults)
    );
    createdIds.push(Number(info.lastInsertRowid));
  } else {
    for (const uid of recipientIds) {
      const info = insertStmt.run(
        type,
        title,
        message,
        severity,
        uid,
        targetRole,
        studentId,
        JSON.stringify(activeChannels),
        JSON.stringify(deliveryResults)
      );
      createdIds.push(Number(info.lastInsertRowid));
    }
  }

  // Best-effort async email alert to staff/supervisor if channel_email_enabled and critical/warning alert
  if (activeChannels.includes('email') && (severity === 'error' || severity === 'warning') && recipientIds.length > 0) {
    const userRows = db
      .prepare(`SELECT email FROM users WHERE id IN (${recipientIds.map(() => '?').join(',')})`)
      .all(...recipientIds);
    for (const u of userRows) {
      if (u.email) {
        sendGenericEmail({ to: u.email, subject: `[IHQA Alert] ${title}`, text: message }, db).catch(() => {});
      }
    }
  }

  return createdIds;
}

function listUserNotifications(user, { unreadOnly = false, limit = 50 } = {}, db = getDb()) {
  const where = ['(n.target_user_id = ? OR (n.target_user_id IS NULL AND n.target_role = ?))'];
  const params = [user.id, user.role];
  if (unreadOnly) {
    where.push('n.is_read = 0');
  }
  const rows = db
    .prepare(
      `SELECT n.*, s.registration_number, s.student_name
       FROM notifications n
       LEFT JOIN students s ON s.id = n.student_id
       WHERE ${where.join(' AND ')}
       ORDER BY n.id DESC
       LIMIT ?`
    )
    .all(...params, Number(limit));

  const unreadCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM notifications
       WHERE (target_user_id = ? OR (target_user_id IS NULL AND target_role = ?)) AND is_read = 0`
    )
    .get(user.id, user.role).c;

  return {
    notifications: rows.map((r) => ({
      ...r,
      channels: JSON.parse(r.channels_json || '[]'),
      deliveryResults: r.delivery_results_json ? JSON.parse(r.delivery_results_json) : null,
    })),
    unreadCount,
  };
}

function markNotificationRead(notificationId, user, db = getDb()) {
  const existing = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  if (!existing) throw new Error('Notification not found');
  if (existing.target_user_id && existing.target_user_id !== user.id && user.role !== 'ADMIN') {
    throw new Error('Forbidden');
  }
  db.prepare(`UPDATE notifications SET is_read = 1, read_at = datetime('now') WHERE id = ?`).run(notificationId);
  return { ok: true };
}

function markAllNotificationsRead(user, db = getDb()) {
  db.prepare(
    `UPDATE notifications
     SET is_read = 1, read_at = datetime('now')
     WHERE (target_user_id = ? OR (target_user_id IS NULL AND target_role = ?)) AND is_read = 0`
  ).run(user.id, user.role);
  return { ok: true };
}

module.exports = {
  dispatchNotification,
  listUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
};
