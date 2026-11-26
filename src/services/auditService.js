const { getDb } = require('../db/database');

function logAudit({ user = null, action, entityType, entityId = null, details = null, ipAddress = null }, db = getDb()) {
  const stmt = db.prepare(`
    INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details_json, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    user?.id ?? null,
    user?.username ?? (user ? String(user) : 'system'),
    action,
    entityType,
    entityId !== null && entityId !== undefined ? String(entityId) : null,
    details ? JSON.stringify(details) : null,
    ipAddress || null
  );
}

function listAuditLogs({ limit = 100, offset = 0, action = '', entityType = '', userId = '' } = {}, db = getDb()) {
  const where = [];
  const params = [];
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (entityType) {
    where.push('entity_type = ?');
    params.push(entityType);
  }
  if (userId) {
    where.push('user_id = ?');
    params.push(Number(userId));
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM audit_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(limit), Number(offset));
  const totalRow = db
    .prepare(`SELECT COUNT(*) as total FROM audit_logs ${whereClause}`)
    .get(...params);

  return {
    rows: rows.map((r) => ({
      ...r,
      details: r.details_json ? JSON.parse(r.details_json) : null,
    })),
    total: totalRow.total,
  };
}

module.exports = {
  logAudit,
  listAuditLogs,
};
