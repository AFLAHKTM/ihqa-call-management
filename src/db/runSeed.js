const { initDatabase, closeDb } = require('./database');
const { seedDatabase } = require('./seedData');

const force = process.argv.includes('--force');
const db = initDatabase();
const result = seedDatabase(db, { force });
console.log('Seed result:', result);
closeDb();
