// MealSwap server: routes, login, bookings and mess verification.
require("dotenv").config();

const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helmet = require("helmet");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({
  contentSecurityPolicy: false // Simple MVP; configure a strict policy before production.
}));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: path.join(__dirname, "data") }),
  secret: process.env.SESSION_SECRET || "local-development-secret-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, "public")));

function requireLogin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Please log in first." });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "mess_admin") {
    return res.status(403).json({ error: "Only mess staff can do this." });
  }
  next();
}

function cleanUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

function makeCode() {
  return crypto.randomBytes(24).toString("hex");
}

// Create an account.
app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Name, email and password are required." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
    if (exists) return res.status(409).json({ error: "This email is already registered." });

    const bcrypt = require("bcryptjs");
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'student')"
    ).run(String(name).trim(), normalizedEmail, passwordHash);

    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    req.session.user = cleanUser(user);
    res.json({ user: req.session.user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create account." });
  }
});

// Log in.
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
  const bcrypt = require("bcryptjs");

  if (!user || !(await bcrypt.compare(password || "", user.password_hash))) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }

  req.session.user = cleanUser(user);
  res.json({ user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ message: "Logged out." }));
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

// Public marketplace. Only available meals are shown.
app.get("/api/meals", (req, res) => {
  const meals = db.prepare(`
    SELECT meals.*, users.name AS seller_name
    FROM meals JOIN users ON users.id = meals.seller_id
    WHERE meals.status = 'available'
    ORDER BY meals.created_at DESC
  `).all();
  res.json({ meals });
});

// Student lists an unused meal.
app.post("/api/meals", requireLogin, (req, res) => {
  const { title, meal_type, date, time, price, location, description } = req.body;

  if (!title || !meal_type || !date || !time || !price || !location) {
    return res.status(400).json({ error: "Please fill all required meal details." });
  }
  if (!["Breakfast", "Lunch", "Snacks", "Dinner"].includes(meal_type)) {
    return res.status(400).json({ error: "Choose a valid meal type." });
  }
  if (!Number.isFinite(Number(price)) || Number(price) <= 0 || Number(price) > 1000) {
    return res.status(400).json({ error: "Enter a valid price." });
  }

  const result = db.prepare(`
    INSERT INTO meals (seller_id, title, meal_type, meal_date, meal_time, price, location, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.user.id, String(title).trim(), meal_type, date, time,
    Number(price), String(location).trim(), String(description || "").trim()
  );

  res.json({ message: "Meal listed successfully.", mealId: result.lastInsertRowid });
});

// Book a meal. QR token is created on the server and is not editable by the browser.
app.post("/api/meals/:id/book", requireLogin, (req, res) => {
  const mealId = Number(req.params.id);
  const buyerId = req.session.user.id;

  const bookMeal = db.transaction(() => {
    const meal = db.prepare("SELECT * FROM meals WHERE id = ?").get(mealId);
    if (!meal || meal.status !== "available") throw new Error("This meal is no longer available.");
    if (meal.seller_id === buyerId) throw new Error("You cannot book your own meal.");

    const token = makeCode();
    const result = db.prepare(`
      INSERT INTO bookings (meal_id, buyer_id, seller_id, qr_token, payment_status)
      VALUES (?, ?, ?, ?, 'pay_at_counter')
    `).run(mealId, buyerId, meal.seller_id, token);

    db.prepare("UPDATE meals SET status = 'booked' WHERE id = ?").run(mealId);
    return { bookingId: result.lastInsertRowid, token };
  });

  try {
    const booking = bookMeal();
    res.json({ message: "Meal booked. Show this QR code at the mess counter.", ...booking });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// A logged-in user can see bookings they bought or sold.
app.get("/api/bookings", requireLogin, (req, res) => {
  const bookings = db.prepare(`
    SELECT bookings.id, bookings.status, bookings.payment_status, bookings.created_at,
           bookings.redeemed_at, meals.title, meals.meal_type, meals.meal_date,
           meals.meal_time, meals.price, meals.location,
           buyer.name AS buyer_name, seller.name AS seller_name,
           CASE WHEN bookings.buyer_id = ? THEN 'buyer' ELSE 'seller' END AS my_role
    FROM bookings
    JOIN meals ON meals.id = bookings.meal_id
    JOIN users buyer ON buyer.id = bookings.buyer_id
    JOIN users seller ON seller.id = bookings.seller_id
    WHERE bookings.buyer_id = ? OR bookings.seller_id = ?
    ORDER BY bookings.created_at DESC
  `).all(req.session.user.id, req.session.user.id, req.session.user.id);
  res.json({ bookings });
});

// QR image is generated from a random server-side token.
app.get("/api/bookings/:id/qr", requireLogin, async (req, res) => {
  const booking = db.prepare(`
    SELECT * FROM bookings WHERE id = ? AND (buyer_id = ? OR seller_id = ?)
  `).get(Number(req.params.id), req.session.user.id, req.session.user.id);

  if (!booking) return res.status(404).json({ error: "Booking not found." });
  if (booking.status === "redeemed") return res.status(400).json({ error: "This meal has already been used." });

  const qrData = await QRCode.toDataURL(booking.qr_token);
  res.json({ qr: qrData, status: booking.status });
});

// Mess staff verify QR token. Redemption is one-time and done on the server.
app.post("/api/admin/redeem", requireAdmin, (req, res) => {
  const token = String(req.body.token || "").trim();
  if (!token) return res.status(400).json({ error: "Scan a valid QR code." });

  const redeem = db.transaction(() => {
    const booking = db.prepare(`
      SELECT bookings.*, meals.title, meals.meal_type, meals.meal_date,
             buyer.name AS buyer_name, seller.name AS seller_name
      FROM bookings
      JOIN meals ON meals.id = bookings.meal_id
      JOIN users buyer ON buyer.id = bookings.buyer_id
      JOIN users seller ON seller.id = bookings.seller_id
      WHERE bookings.qr_token = ?
    `).get(token);

    if (!booking) throw new Error("Invalid QR code.");
    if (booking.status === "redeemed") throw new Error("This QR code has already been used.");
    if (booking.status !== "active") throw new Error("This booking is not active.");

    db.prepare("UPDATE bookings SET status = 'redeemed', redeemed_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(booking.id);
    return booking;
  });

  try {
    const booking = redeem();
    res.json({
      message: "Meal verified successfully.",
      booking: {
        id: booking.id,
        title: booking.title,
        mealType: booking.meal_type,
        date: booking.meal_date,
        buyer: booking.buyer_name,
        seller: booking.seller_name
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create a mess-staff account using a one-time setup command (see README).
app.post("/api/setup-admin", async (req, res) => {
  const setupKey = process.env.ADMIN_SETUP_KEY;
  if (!setupKey || req.body.setupKey !== setupKey) {
    return res.status(403).json({ error: "Admin setup is disabled or the key is incorrect." });
  }
  const { name, email, password } = req.body;
  if (!name || !email || !password || String(password).length < 8) {
    return res.status(400).json({ error: "Provide name, email and a password of at least 8 characters." });
  }
  const bcrypt = require("bcryptjs");
  const hash = await bcrypt.hash(password, 12);
  try {
    db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'mess_admin')")
      .run(String(name).trim(), String(email).trim().toLowerCase(), hash);
    res.json({ message: "Mess admin account created. Log in normally." });
  } catch {
    res.status(409).json({ error: "That email may already exist." });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`MealSwap is running at http://localhost:${PORT}`);
});
