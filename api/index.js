const { initDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seedData');
const { initCloudSync } = require('../src/services/cloudSyncService');
const { createApp } = require('../src/app');

let app = null;
let initPromise = null;

async function ensureApp() {
  if (!app) {
    if (!initPromise) {
      initPromise = (async () => {
        const db = initDatabase();
        seedDatabase(db);
        await initCloudSync();
        app = createApp();
      })();
    }
    await initPromise;
  }
  return app;
}

module.exports = async (req, res) => {
  try {
    const handler = await ensureApp();
    return handler(req, res);
  } catch (err) {
    console.error('Serverless invocation error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
  }
};
