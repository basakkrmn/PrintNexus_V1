import db from './database.js';
console.log(db.prepare('SELECT id, username, role FROM users').all());