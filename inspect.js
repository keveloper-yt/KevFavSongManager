const Database = require("better-sqlite3");
const db = new Database("user_data.db");

const rows = db.prepare("SELECT * FROM favorites").all();
console.log(rows);
