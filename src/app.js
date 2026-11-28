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
const campusRoutes = require('./routes/campusRoutes');
const config = require('./config');
const { pullIfNewer, pushSnapshot } = require('./services/cloudSyncService');

function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Prevent caching of sensitive API responses & sync shared cloud database
  app.use('/api', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (
      req.path === '/health' ||
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/notifications')
    ) {
      return next();
    }

    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    if (isMutation) {
      try {
        await pullIfNewer(true);
      } catch (err) {
        console.warn('Cloud sync pull warning:', err.message);
      }
    } else {
      pullIfNewer(false).catch((err) => console.warn('Cloud sync background pull warning:', err.message));
    }

    if (isMutation) {
      const origJson = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          if (config.isVercel) {
            pushSnapshot(req.user?.username || req.path)
              .catch((err) => console.warn('Cloud sync push warning:', err.message))
              .finally(() => origJson(body));
            return res;
          }
          // On persistent local server, push asynchronously so UI responds in <10ms
          pushSnapshot(req.user?.username || req.path).catch((err) =>
            console.warn('Cloud sync push warning:', err.message)
          );
        }
        return origJson(body);
      };
    }

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
  app.use('/api/campuses', campusRoutes);

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
