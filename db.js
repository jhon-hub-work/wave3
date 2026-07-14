// Data layer for Wave3.
// Runs on libSQL so the SAME code works locally (a file) and in production (Turso).
//   local  -> DATABASE_URL unset, defaults to file:./data/wave3.db
//   Turso  -> DATABASE_URL=libsql://...  + DATABASE_AUTH_TOKEN=...
const { createClient } = require("@libsql/client");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

// Local default: a file anchored to THIS folder (not the launch cwd), so the
// database is deterministic no matter where `node` is started from.
// Production sets DATABASE_URL to a Turso libsql:// url instead.
let url = process.env.DATABASE_URL;
if (!url) {
  const dir = path.join(__dirname, "data");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  url = "file:" + path.join(dir, "wave3.db").replace(/\\/g, "/");
}

const client = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  intMode: "number"
});

// ---- row helpers: return clean plain objects (libsql rows are array-like) ----
function toObj(columns, row) {
  const o = {};
  for (let i = 0; i < columns.length; i++) o[columns[i]] = row[i];
  return o;
}
function shape(rs) {
  return rs.rows.map((row) => toObj(rs.columns, row));
}

async function all(sql, args = []) {
  return shape(await client.execute({ sql, args }));
}
async function get(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rs.rows.length ? toObj(rs.columns, rs.rows[0]) : null;
}
async function run(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return {
    rowsAffected: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null
  };
}

// ---- interactive transactions (used for stock reservation, mark paid, etc.) ----
async function tx() {
  return client.transaction("write");
}
async function txAll(t, sql, args = []) {
  return shape(await t.execute({ sql, args }));
}
async function txGet(t, sql, args = []) {
  const rs = await t.execute({ sql, args });
  return rs.rows.length ? toObj(rs.columns, rs.rows[0]) : null;
}
async function txRun(t, sql, args = []) {
  const rs = await t.execute({ sql, args });
  return {
    rowsAffected: rs.rowsAffected,
    lastInsertRowid: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : null
  };
}

// ---- settings ----
async function getSetting(key, fallback = null) {
  const row = await get("SELECT value FROM settings WHERE key = ?", [key]);
  return row ? row.value : fallback;
}
async function setSetting(key, value) {
  await run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, String(value)]
  );
}
async function allSettingsMap() {
  const rows = await all("SELECT key, value FROM settings");
  const m = {};
  for (const r of rows) m[r.key] = r.value;
  return m;
}

function hashPassword(pw) {
  return crypto.createHash("sha256").update(String(pw)).digest("hex");
}

// ---- media (payment screenshots + QR codes) live in the DB so they survive
//      restarts on hosts with an ephemeral disk (Render free tier) ----
async function saveMedia(dataUrl) {
  const id = "m" + crypto.randomBytes(9).toString("hex");
  await run("INSERT INTO media (id, data, created_at) VALUES (?, ?, datetime('now'))", [id, dataUrl]);
  return id;
}
async function getMedia(id) {
  if (!id) return null;
  return get("SELECT data FROM media WHERE id = ?", [id]);
}
async function deleteMedia(id) {
  if (id) await run("DELETE FROM media WHERE id = ?", [id]);
}

// ---- schema + seed ----
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS variants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    size TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    length_in REAL,
    width_in REAL,
    sleeves_in REAL,
    sort INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    address TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    shipping_fee REAL NOT NULL DEFAULT 0,
    proof_file TEXT,
    proof_at TEXT,
    paid_at TEXT,
    tracking TEXT,
    quoted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    variant_id INTEGER NOT NULL REFERENCES variants(id),
    product_name TEXT NOT NULL,
    size TEXT NOT NULL,
    qty INTEGER NOT NULL,
    unit_price REAL NOT NULL
  );
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK (type IN ('income','expense')),
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL,
    order_id INTEGER,
    tx_date TEXT NOT NULL DEFAULT (date('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS media (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

async function seed() {
  if (await getSetting("seeded")) return;

  await setSetting("business_name", "WAVE3");
  await setSetting("business_sub", "WAVE3 COLLECTIVE");
  await setSetting("tagline", "THE MOVEMENT CONTINUES.");
  await setSetting("currency", "₱");
  await setSetting("shipping_fee", "125"); // default flat fee; admin can override per order (0 = quote per order)
  await setSetting("payment_window_hours", "24");
  await setSetting(
    "payment_note",
    "Once you’ve completed your payment, kindly send your proof of payment so I can verify it and prepare your order for shipment. Thank you!"
  );
  await setSetting("admin_password_hash", hashPassword("wave3admin"));
  await setSetting("contact_channels", "[]");
  await setSetting(
    "payment_channels",
    JSON.stringify([
      { label: "Metrobank", kind: "bank",
        lines: ["Account Number: 1283128442368", "Account Name: MARY DEE S. RUZGAL"] },
      { label: "BDO", kind: "bank",
        lines: ["Account Number: 010890086338", "Account Name: MARY DEE S. RUZGAL"] },
      { label: "GCash", kind: "gcash",
        lines: ["Number: 09456086925", "Account Name: MARY DEE S. RUZGAL"] },
      { label: "USDT (BEP20 – Binance Smart Chain)", kind: "crypto",
        lines: ["Wallet Address: 0x41f4dbbacb103509300ee59dc96c629dc037ff9c"] }
    ])
  );

  const p = await run("INSERT INTO products (name, description, price) VALUES (?, ?, ?)", [
    "Wave 3 Embroidered Tee",
    "Premium embroidered details. 100% cotton, 230-240 GSM heavyweight fabric, pre-shrunk, rib knit cuffs, side-seamed stitching, pro club fit. Built with purpose. Worn with pride.",
    999
  ]);
  const productId = p.lastInsertRowid;
  const variants = [
    ["XS", 3, 27, 22, 9.5, 0],
    ["S", 5, 28, 23, 10, 1],
    ["M", 12, 29, 24, 10.5, 2],
    ["L", 25, 30, 25, 11, 3],
    ["XL", 5, 31, 26, 11.5, 4]
  ];
  for (const [size, stock, l, w, s, sort] of variants)
    await run(
      "INSERT INTO variants (product_id, size, stock, length_in, width_in, sleeves_in, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [productId, size, stock, l, w, s, sort]
    );

  await setSetting("seeded", "1");
}

async function init() {
  await client.executeMultiple(SCHEMA);
  // additive migrations (safe to run every boot)
  for (const alter of [
    "ALTER TABLE orders ADD COLUMN tracking TEXT",
    // quoted_at: when the total (incl. shipping) was confirmed. The payment
    // countdown runs from here, NOT from order time — so it never starts while
    // the customer is still waiting to know their shipping fee.
    "ALTER TABLE orders ADD COLUMN quoted_at TEXT",
    // product photo (a media id), uploadable from the dashboard
    "ALTER TABLE products ADD COLUMN image TEXT",
    // homepage Featured Drops: owner picks which products show and their badge
    "ALTER TABLE products ADD COLUMN featured INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE products ADD COLUMN badge TEXT"
  ]) {
    try {
      await client.execute(alter);
    } catch {
      /* column already exists */
    }
  }
  await seed();
}

module.exports = {
  init, client,
  get, all, run,
  tx, txGet, txAll, txRun,
  getSetting, setSetting, allSettingsMap, hashPassword,
  saveMedia, getMedia, deleteMedia
};
