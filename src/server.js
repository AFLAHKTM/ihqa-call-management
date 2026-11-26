const config = require('./config');
const { initDatabase } = require('./db/database');
const { seedDatabase } = require('./db/seedData');
const { startScheduler } = require('./services/jobScheduler');
const { createApp } = require('./app');

const db = initDatabase();
const seedResult = seedDatabase(db);
if (seedResult.seeded) {
  console.log('Initialized & seeded Kerala Initial Screening dataset:', seedResult);
}

startScheduler(60000);

const app = createApp();
app.listen(config.port, () => {
  console.log(`IHQA Kerala Call Management System listening on http://localhost:${config.port}`);
});
