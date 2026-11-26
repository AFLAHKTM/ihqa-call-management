const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { getDb } = require('../db/database');
const {
  listUserNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} = require('../services/notificationService');

const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const unreadOnly = req.query.unreadOnly === 'true';
  const result = listUserNotifications(req.user, { unreadOnly }, getDb());
  res.json(result);
});

router.post('/:id/read', (req, res) => {
  try {
    res.json(markNotificationRead(Number(req.params.id), req.user, getDb()));
  } catch (err) {
    res.status(err.message === 'Forbidden' ? 403 : 404).json({ error: err.message });
  }
});

router.post('/read-all', (req, res) => {
  res.json(markAllNotificationsRead(req.user, getDb()));
});

module.exports = router;
