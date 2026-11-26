const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { generateReport, reportToCsv, reportToExcelXml } = require('../services/reportService');
const { logAudit } = require('../services/auditService');

const router = express.Router();

router.use(requireAuth);

router.get('/:type', (req, res) => {
  try {
    const report = generateReport(req.params.type, req.user, getDb());
    res.json(report);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:type/export', (req, res) => {
  const format = String(req.query.format || 'csv').toLowerCase();
  try {
    const db = getDb();
    const report = generateReport(req.params.type, req.user, db);

    logAudit(
      {
        user: req.user,
        action: 'REPORT_EXPORTED',
        entityType: 'report',
        entityId: req.params.type,
        details: { format, rowCount: report.rows.length },
        ipAddress: req.ip,
      },
      db
    );

    if (format === 'excel' || format === 'xls') {
      const xml = reportToExcelXml(report);
      res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="ihqa-${req.params.type}-report.xls"`);
      return res.send(xml);
    }

    const csv = reportToCsv(report);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ihqa-${req.params.type}-report.csv"`);
    return res.send(csv);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
