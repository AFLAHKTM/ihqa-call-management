const config = require('./config');
const { initDatabase } = require('./db/database');
const { seedDatabase } = require('./db/seedData');
const { startScheduler } = require('./services/jobScheduler');
const { initCloudSync } = require('./services/cloudSyncService');
const { createApp } = require('./app');

let cachedApp = null;

function getInitializedApp() {
  if (!cachedApp) {
    const db = initDatabase();
    const seedResult = seedDatabase(db);
    if (seedResult.seeded) {
      console.log('Initialized & seeded Kerala Initial Screening dataset:', seedResult);
    }
    cachedApp = createApp();
  }
  return cachedApp;
}

if (require.main === module) {
  const app = getInitializedApp();
  initCloudSync().then((syncRes) => {
    if (syncRes.enabled) {
      console.log('Supabase Cloud Sync active:', syncRes);
    }
  });
  startScheduler(60000);
  app.listen(config.port, () => {
    console.log(`IHQA Kerala Call Management System listening on http://localhost:${config.port}`);
  });
}

module.exports = (req, res) => getInitializedApp()(req, res);
