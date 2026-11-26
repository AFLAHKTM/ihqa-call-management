const path = require('node:path');
const express = require('express');
const authRoutes = require('./routes/authRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const studentRoutes = require('./routes/studentRoutes');
const staffRoutes = require('./routes/staffRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const emailRoutes = require('./routes/emailRoutes');
const reportRoutes = require('./routes/reportRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const telephonyRoutes = require('./routes/telephonyRoutes');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Prevent caching of sensitive API responses
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'IHQA Kerala Call Management System' });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/students', studentRoutes);
  app.use('/api/staff', staffRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/emails', emailRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/telephony', telephonyRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'API route not found' });
    }
    const indexPath = path.join(__dirname, '..', 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
      if (err && !res.headersSent) {
        res.redirect(302, '/index.html');
      }
    });
  });

  return app;
}

module.exports = { createApp };
