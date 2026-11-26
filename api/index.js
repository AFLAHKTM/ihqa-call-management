const { initDatabase } = require('../src/db/database');
const { seedDatabase } = require('../src/db/seedData');
const { createApp } = require('../src/app');

let app = null;

function ensureApp() {
  if (!app) {
    const db = initDatabase();
    seedDatabase(db);
    app = createApp();
  }
  return app;
}

module.exports = (req, res) => {
  try {
    const handler = ensureApp();
    return handler(req, res);
  } catch (err) {
    console.error('Serverless invocation error:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || 'Internal Server Error' }));
  }
};
