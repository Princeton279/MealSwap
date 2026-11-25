// SQLite database. Tables are created automatically the first time the server starts.
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const dataFolder = path.join(__dirname, "data");
if (!fs.existsSync(dataFolder)) fs.mkdirSync(dataFolder);

const db = new Database(path.join(dataFolder, "mealswap.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    meal_date TEXT NOT NULL,
    meal_time TEXT NOT NULL,
    price REAL NOT NULL,
    location TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'available',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (seller_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meal_id INTEGER NOT NULL,
    buyer_id INTEGER NOT NULL,
    seller_id INTEGER NOT NULL,
    qr_token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',
    payment_status TEXT NOT NULL DEFAULT 'pay_at_counter',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    redeemed_at TEXT,
    FOREIGN KEY (meal_id) REFERENCES meals(id),
    FOREIGN KEY (buyer_id) REFERENCES users(id),
    FOREIGN KEY (seller_id) REFERENCES users(id)
  );
`);

module.exports = db;
