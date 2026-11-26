const express = require('express');
const config = require('../config');
const { getDb } = require('../db/database');
const { handleTelephonyWebhook } = require('../services/telephonyService');

const router = express.Router();

// Webhook receiver for Exotel / Twilio call status updates
router.post('/webhook/:provider', (req, res) => {
  const secretHeader = req.headers['x-ihqa-webhook-secret'] || req.query.secret;
  if (config.telephony.webhookSecret && secretHeader && secretHeader !== config.telephony.webhookSecret) {
    return res.status(403).json({ error: 'Invalid webhook secret' });
  }

  try {
    const result = handleTelephonyWebhook(
      {
        provider: req.params.provider,
        payload: req.body || {},
      },
      getDb()
    );
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
