const express = require("express");
const crypto = require("node:crypto");
const path = require("node:path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3737;

app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname, "public")));

// crash-safe wrapper for async route handlers
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Server error. Please try again." });
  });

// ---------- helpers ----------
const ORDER_STATUSES = ["pending", "proof", "paid", "shipped", "cancelled", "expired"];

function fmtSqlUtc(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function computeExpiresAt(createdAt, hours) {
  const d = new Date(String(createdAt).replace(" ", "T") + "Z");
  if (isNaN(d)) return null;
  d.setUTCHours(d.getUTCHours() + hours);
  return fmtSqlUtc(d);
}

async function paymentWindowHours() {
  const v = Number(await db.getSetting("payment_window_hours", "24"));
  return Number.isFinite(v) && v > 0 ? v : 24;
}

// live PHP<->USD rate, cached 12h, last good value persisted as fallback
let fxCache = { at: 0, phpPerUsd: null };
async function getFx() {
  if (fxCache.phpPerUsd && Date.now() - fxCache.at < 12 * 3600e3) return fxCache;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/USD");
    const d = await r.json();
    const v = Number(d && d.rates && d.rates.PHP);
    if (v > 0) {
      fxCache = { at: Date.now(), phpPerUsd: v };
      await db.setSetting("fx_php_per_usd", v);
      return fxCache;
    }
  } catch {}
  const saved = Number(await db.getSetting("fx_php_per_usd", "58"));
  fxCache = { at: Date.now(), phpPerUsd: saved > 0 ? saved : 58 };
  return fxCache;
}

async function publicSettings() {
  const s = await db.allSettingsMap();
  const fx = await getFx();
  const wh = Number(s.payment_window_hours);
  return {
    business_name: s.business_name || "WAVE3",
    business_sub: s.business_sub || "WAVE3 COLLECTIVE",
    tagline: s.tagline || "",
    currency: s.currency || "₱",
    shipping_fee: Number(s.shipping_fee || 0),
    payment_note: s.payment_note || "",
    payment_window_hours: Number.isFinite(wh) && wh > 0 ? wh : 24,
    story: s.story_text || "",
    discord: s.discord_url || "",
    hero: s.hero_image || "",
    coming_soon: parseJsonSetting(s.coming_soon || '["Wave 3 Hoodie","Wave 3 Pro Jersey","Wave 3 Tumbler"]'),
    movement: [1, 2, 3, 4].map((i) => s["movement_story_" + i] || ""),
    // units per 1 USD — clients convert: amount / fx[base] * fx[target]
    fx: { PHP: fx.phpPerUsd, USD: 1, USDT: 1 }
  };
}

function parseJsonSetting(value) {
  try {
    const v = JSON.parse(value || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
async function paymentChannels() {
  return parseJsonSetting(await db.getSetting("payment_channels", "[]"));
}
async function contactChannels() {
  return parseJsonSetting(await db.getSetting("contact_channels", "[]"));
}

// an order is "awaiting a shipping quote" while it's pending with no quoted_at.
// the payment countdown only runs AFTER the seller confirms the total (quoted_at),
// so a customer never races a clock before they even know their shipping fee.
function decorate(order, items, hours) {
  const itemsTotal = items.reduce((s, it) => s + it.unit_price * it.qty, 0);
  const awaitingQuote = order.status === "pending" && !order.quoted_at;
  return {
    ...order,
    items,
    items_total: itemsTotal,
    total: itemsTotal + order.shipping_fee,
    awaiting_quote: awaitingQuote,
    expires_at:
      order.status === "pending" && order.quoted_at
        ? computeExpiresAt(order.quoted_at, hours)
        : null
  };
}

// single order with items + computed expiry
async function orderWithItems(order, hours) {
  if (hours == null) hours = await paymentWindowHours();
  const items = await db.all("SELECT * FROM order_items WHERE order_id = ?", [order.id]);
  return decorate(order, items, hours);
}

// many orders + items in ONE extra query (avoids per-order round trips to Turso)
async function ordersWithItems(orders, hours) {
  if (!orders.length) return [];
  if (hours == null) hours = await paymentWindowHours();
  const ids = orders.map((o) => o.id);
  const ph = ids.map(() => "?").join(",");
  const allItems = await db.all(`SELECT * FROM order_items WHERE order_id IN (${ph})`, ids);
  const byOrder = new Map();
  for (const it of allItems) {
    if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
    byOrder.get(it.order_id).push(it);
  }
  return orders.map((o) => decorate(o, byOrder.get(o.id) || [], hours));
}

async function restockOrder(t, orderId) {
  const items = await db.txAll(t, "SELECT * FROM order_items WHERE order_id = ?", [orderId]);
  for (const it of items)
    await db.txRun(t, "UPDATE variants SET stock = stock + ? WHERE id = ?", [it.qty, it.variant_id]);
}

// Shopee-style: unpaid orders whose payment window lapsed auto-expire and
// release their stock. The window is measured from quoted_at (when the total was
// confirmed), so orders still awaiting a shipping quote never expire.
async function expireStaleOrders() {
  const hours = await paymentWindowHours();
  const stale = await db.all(
    `SELECT id FROM orders
       WHERE status = 'pending'
         AND quoted_at IS NOT NULL
         AND datetime(quoted_at, '+' || ? || ' hours') <= datetime('now')`,
    [hours]
  );
  for (const row of stale) {
    const t = await db.tx();
    try {
      await restockOrder(t, row.id);
      await db.txRun(t, "UPDATE orders SET status = 'expired' WHERE id = ?", [row.id]);
      await t.commit();
    } catch {
      try { await t.rollback(); } catch {}
    }
  }
  return stale.length;
}

async function makeOrderCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 20; attempt++) {
    let code = "W3-";
    const bytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += alphabet[bytes[i] % alphabet.length];
    if (!(await db.get("SELECT 1 AS x FROM orders WHERE code = ?", [code]))) return code;
  }
  throw new Error("Could not generate order code");
}

function sendMedia(res, row, cacheable) {
  if (!row) return res.status(404).end();
  const m = String(row.data).match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  if (!m) return res.status(404).end();
  res.setHeader("Content-Type", m[1]);
  if (cacheable) res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(Buffer.from(m[2], "base64"));
}

// ---------- admin sessions (in-memory; admin re-logs in after a restart) ----------
const sessions = new Map(); // token -> expiry ms
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function isAdmin(req) {
  const token = parseCookies(req).w3sid;
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(token);
    return false;
  }
  return true;
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: "Not logged in" });
  next();
}

// ---------- public API ----------
app.get("/api/shop", wrap(async (req, res) => {
  await expireStaleOrders();
  const products = await db.all("SELECT * FROM products WHERE active = 1 ORDER BY id");
  for (const p of products)
    p.variants = await db.all("SELECT * FROM variants WHERE product_id = ? ORDER BY sort, id", [p.id]);
  res.json({ settings: await publicSettings(), products, contacts: await contactChannels() });
}));

// public media: payment QR codes + product photos (ids are unguessable)
const servePublicMedia = wrap(async (req, res) => {
  const id = String(req.params.id);
  if (!/^m[0-9a-f]+$/.test(id)) return res.status(404).end();
  sendMedia(res, await db.getMedia(id), true);
});
app.get("/qr/:id", servePublicMedia);
app.get("/media/:id", servePublicMedia);

app.post("/api/orders", wrap(async (req, res) => {
  const { customer, items } = req.body || {};
  if (!customer || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Missing order details." });

  const name = String(customer.name || "").trim();
  const phone = String(customer.phone || "").trim();
  const address = String(customer.address || "").trim();
  const contact = String(customer.contact || "").trim();
  const notes = String(customer.notes || "").trim();
  if (!name || !phone || !address)
    return res.status(400).json({ error: "Name, phone, and address are required." });
  if (!/^[0-9+\-\s()]+$/.test(phone) || (phone.match(/\d/g) || []).length < 7)
    return res.status(400).json({ error: "Please enter a valid mobile number (digits only)." });

  const cleaned = [];
  for (const it of items) {
    const variantId = Number(it.variant_id);
    const qty = Math.floor(Number(it.qty));
    if (!variantId || !qty || qty < 1 || qty > 99)
      return res.status(400).json({ error: "Invalid item quantity." });
    cleaned.push({ variantId, qty });
  }

  await expireStaleOrders(); // release stock held by lapsed orders before selling
  const code = await makeOrderCode();
  const shippingFee = Number(await db.getSetting("shipping_fee", "0")) || 0;

  const t = await db.tx();
  try {
    // Shopee-style reservation: hold stock now, auto-release if unpaid past the window
    const rows = [];
    for (const { variantId, qty } of cleaned) {
      const v = await db.txGet(
        t,
        `SELECT variants.*, products.name AS product_name, products.price, products.active
         FROM variants JOIN products ON products.id = variants.product_id
         WHERE variants.id = ?`,
        [variantId]
      );
      if (!v || !v.active) throw new Error("Item not found.");
      const upd = await db.txRun(
        t,
        "UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?",
        [qty, variantId, qty]
      );
      if (upd.rowsAffected === 0)
        throw new Error(`Not enough stock for size ${v.size}. Only ${v.stock} left.`);
      rows.push({ v, qty });
    }

    // If a flat shipping fee is configured (> 0), the total is known right away and
    // the countdown starts now. If shipping is "to be confirmed" (0), quoted_at stays
    // NULL and the timer waits until the seller sets the per-order fee.
    const o = await db.txRun(
      t,
      `INSERT INTO orders (code, customer_name, phone, address, contact, notes, status, shipping_fee, quoted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, CASE WHEN ? > 0 THEN datetime('now') ELSE NULL END)`,
      [code, name, phone, address, contact, notes, shippingFee, shippingFee]
    );
    const orderId = o.lastInsertRowid;
    for (const { v, qty } of rows)
      await db.txRun(
        t,
        `INSERT INTO order_items (order_id, variant_id, product_name, size, qty, unit_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, v.id, v.product_name, v.size, qty, v.price]
      );

    await t.commit();
    res.json({ code });
  } catch (err) {
    try { await t.rollback(); } catch {}
    res.status(400).json({ error: err.message || "Could not place order." });
  }
}));

app.get("/api/orders/:code", wrap(async (req, res) => {
  await expireStaleOrders();
  const order = await db.get("SELECT * FROM orders WHERE code = ?", [String(req.params.code).toUpperCase()]);
  if (!order) return res.status(404).json({ error: "Order not found." });

  const full = await orderWithItems(order);
  const payload = {
    code: full.code,
    status: full.status,
    customer_name: full.customer_name,
    phone: full.phone,
    address: full.address,
    items: full.items.map((it) => ({
      product_name: it.product_name,
      size: it.size,
      qty: it.qty,
      unit_price: it.unit_price
    })),
    items_total: full.items_total,
    shipping_fee: full.shipping_fee,
    total: full.total,
    has_proof: Boolean(full.proof_file),
    created_at: full.created_at,
    paid_at: full.paid_at,
    expires_at: full.expires_at,
    awaiting_quote: full.awaiting_quote,
    tracking: full.status === "paid" || full.status === "shipped" ? full.tracking : null,
    settings: await publicSettings(),
    contacts: await contactChannels()
  };
  // only reveal payment details once the total is confirmed (not while awaiting a quote)
  if (full.status === "proof" || (full.status === "pending" && !full.awaiting_quote))
    payload.payment_channels = await paymentChannels();
  res.json(payload);
}));

app.post("/api/orders/:code/proof", wrap(async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE code = ?", [String(req.params.code).toUpperCase()]);
  if (!order) return res.status(404).json({ error: "Order not found." });
  if (order.status !== "pending" && order.status !== "proof")
    return res.status(400).json({ error: "This order is no longer awaiting payment." });
  if (order.status === "pending" && !order.quoted_at)
    return res.status(400).json({ error: "Please wait for the seller to confirm your total (shipping fee) before uploading your payment." });

  const image = String((req.body || {}).image || "");
  const m = image.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Please upload a PNG, JPG, or WEBP image." });
  if (Buffer.from(m[2], "base64").length > 12 * 1024 * 1024)
    return res.status(400).json({ error: "Image too large (max 12 MB)." });

  const mediaId = await db.saveMedia(image);
  await db.deleteMedia(order.proof_file); // remove the previous screenshot if any
  await db.run(
    "UPDATE orders SET proof_file = ?, proof_at = datetime('now'), status = 'proof' WHERE id = ?",
    [mediaId, order.id]
  );
  res.json({ ok: true });
}));

// ---------- admin API ----------
app.post("/api/admin/login", wrap(async (req, res) => {
  const pw = String((req.body || {}).password || "");
  if (db.hashPassword(pw) !== (await db.getSetting("admin_password_hash")))
    return res.status(401).json({ error: "Wrong password." });
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_TTL);
  res.setHeader(
    "Set-Cookie",
    `w3sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`
  );
  res.json({ ok: true });
}));

app.post("/api/admin/logout", (req, res) => {
  const token = parseCookies(req).w3sid;
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", "w3sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  res.json({ ok: true });
});

app.get("/api/admin/me", (req, res) => res.json({ admin: isAdmin(req) }));

app.get("/api/admin/overview", requireAdmin, wrap(async (req, res) => {
  await expireStaleOrders();
  const counts = await db.all("SELECT status, COUNT(*) AS n FROM orders GROUP BY status");
  const cmap = {};
  for (const r of counts) cmap[r.status] = r.n;
  const money = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
     FROM transactions`
  );
  const stock = await db.get("SELECT COALESCE(SUM(stock),0) AS total FROM variants");
  const lowStock = await db.all(
    `SELECT variants.*, products.name AS product_name FROM variants
     JOIN products ON products.id = variants.product_id
     WHERE products.active = 1 AND variants.stock <= 3 ORDER BY variants.stock`
  );
  const recentRows = await db.all("SELECT * FROM orders ORDER BY id DESC LIMIT 8");
  const recent = await ordersWithItems(recentRows);
  res.json({
    pending: cmap.pending || 0,
    proof: cmap.proof || 0,
    paid: cmap.paid || 0,
    shipped: cmap.shipped || 0,
    income: money.income,
    expense: money.expense,
    profit: money.income - money.expense,
    stock_total: stock.total,
    low_stock: lowStock,
    recent
  });
}));

app.get("/api/admin/orders", requireAdmin, wrap(async (req, res) => {
  await expireStaleOrders();
  const status = String(req.query.status || "");
  const rows = ORDER_STATUSES.includes(status)
    ? await db.all("SELECT * FROM orders WHERE status = ? ORDER BY id DESC", [status])
    : await db.all("SELECT * FROM orders ORDER BY id DESC");
  res.json({ orders: await ordersWithItems(rows) });
}));

app.post("/api/admin/orders/:id/action", requireAdmin, wrap(async (req, res) => {
  const order = await db.get("SELECT * FROM orders WHERE id = ?", [Number(req.params.id)]);
  if (!order) return res.status(404).json({ error: "Order not found." });
  const { action, shipping_fee } = req.body || {};

  if (action === "shipping") {
    // must be an actual number — reject null/NaN/letters so a typo can't become free shipping
    if (typeof shipping_fee !== "number" || !Number.isFinite(shipping_fee) || shipping_fee < 0)
      return res.status(400).json({ error: "Shipping fee must be a number (e.g. 125)." });
    const fee = shipping_fee;
    // Confirming the fee also confirms the total: start the payment countdown now
    // if it hasn't started yet (only for orders still awaiting a quote).
    await db.run(
      "UPDATE orders SET shipping_fee = ?, quoted_at = COALESCE(quoted_at, datetime('now')) WHERE id = ?",
      [fee, order.id]
    );
  } else if (action === "paid") {
    if (order.status !== "pending" && order.status !== "proof")
      return res.status(400).json({ error: "Order is not awaiting verification." });
    const full = await orderWithItems(order);
    const t = await db.tx();
    try {
      // stock was already reserved when the order was placed
      await db.txRun(t, "UPDATE orders SET status = 'paid', paid_at = datetime('now') WHERE id = ?", [order.id]);
      await db.txRun(
        t,
        `INSERT INTO transactions (type, category, description, amount, order_id)
         VALUES ('income', 'Sales', ?, ?, ?)`,
        [`Order ${order.code} — ${order.customer_name}`, full.total, order.id]
      );
      // auto-log THIS order's shipping as an expense (what you pay the courier)
      if (order.shipping_fee > 0)
        await db.txRun(
          t,
          `INSERT INTO transactions (type, category, description, amount, order_id)
           VALUES ('expense', 'Shipping', ?, ?, ?)`,
          [`Order ${order.code} — shipping cost`, order.shipping_fee, order.id]
        );
      await t.commit();
    } catch (err) {
      try { await t.rollback(); } catch {}
      return res.status(500).json({ error: err.message });
    }
  } else if (action === "ship") {
    if (order.status !== "paid")
      return res.status(400).json({ error: "Only paid orders can be shipped." });
    await db.run("UPDATE orders SET status = 'shipped' WHERE id = ?", [order.id]);
  } else if (action === "tracking") {
    if (order.status !== "paid" && order.status !== "shipped")
      return res.status(400).json({ error: "Add tracking after the order is paid." });
    const value = String((req.body || {}).tracking || "").trim().slice(0, 300);
    await db.run("UPDATE orders SET tracking = ? WHERE id = ?", [value || null, order.id]);
  } else if (action === "cancel") {
    if (order.status === "cancelled" || order.status === "expired")
      return res.status(400).json({ error: "Already cancelled." });
    const t = await db.tx();
    try {
      if (order.status !== "shipped") await restockOrder(t, order.id); // shipped items already left
      await db.txRun(t, "DELETE FROM transactions WHERE order_id = ?", [order.id]);
      await db.txRun(t, "UPDATE orders SET status = 'cancelled' WHERE id = ?", [order.id]);
      await t.commit();
    } catch (err) {
      try { await t.rollback(); } catch {}
      return res.status(500).json({ error: err.message });
    }
  } else if (action === "revert") {
    if (order.status !== "paid")
      return res.status(400).json({ error: "Only paid orders can be reverted." });
    const t = await db.tx();
    try {
      // stock stays reserved; only the logged income is rolled back
      await db.txRun(t, "DELETE FROM transactions WHERE order_id = ?", [order.id]);
      await db.txRun(t, "UPDATE orders SET status = 'proof', paid_at = NULL WHERE id = ?", [order.id]);
      await t.commit();
    } catch (err) {
      try { await t.rollback(); } catch {}
      return res.status(500).json({ error: err.message });
    }
  } else if (action === "delete") {
    // permanently remove the order and all its records
    const t = await db.tx();
    try {
      // return reserved stock only if this order still holds it (not shipped/cancelled/expired)
      if (["pending", "proof", "paid"].includes(order.status)) await restockOrder(t, order.id);
      await db.txRun(t, "DELETE FROM transactions WHERE order_id = ?", [order.id]);
      await db.txRun(t, "DELETE FROM order_items WHERE order_id = ?", [order.id]);
      await db.txRun(t, "DELETE FROM orders WHERE id = ?", [order.id]);
      await t.commit();
    } catch (err) {
      try { await t.rollback(); } catch {}
      return res.status(500).json({ error: err.message });
    }
    await db.deleteMedia(order.proof_file);
    return res.json({ deleted: true });
  } else {
    return res.status(400).json({ error: "Unknown action." });
  }

  const fresh = await db.get("SELECT * FROM orders WHERE id = ?", [order.id]);
  res.json({ order: await orderWithItems(fresh) });
}));

app.get("/api/admin/proof/:id", requireAdmin, wrap(async (req, res) => {
  sendMedia(res, await db.getMedia(String(req.params.id)), false);
}));

// manual orders (walk-in / DM / historical sales)
app.post("/api/admin/manual-order", requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const c = b.customer || {};
  const name = String(c.name || "").trim();
  if (!name) return res.status(400).json({ error: "Customer name is required." });

  const cleaned = [];
  for (const it of Array.isArray(b.items) ? b.items : []) {
    const variantId = Number(it.variant_id);
    const qty = Math.floor(Number(it.qty));
    if (variantId && qty >= 1 && qty <= 99) cleaned.push({ variantId, qty });
  }
  if (cleaned.length === 0) return res.status(400).json({ error: "Add at least one item." });

  const paid = b.paid !== false;
  const deduct = !paid || b.deduct_stock !== false;
  let fee = Number(b.shipping_fee);
  if (!Number.isFinite(fee) || fee < 0) fee = 0;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? b.date : null;
  const code = await makeOrderCode();

  const t = await db.tx();
  try {
    const rows = [];
    for (const { variantId, qty } of cleaned) {
      const v = await db.txGet(
        t,
        `SELECT variants.*, products.name AS product_name, products.price
         FROM variants JOIN products ON products.id = variants.product_id
         WHERE variants.id = ?`,
        [variantId]
      );
      if (!v) throw new Error("Item not found.");
      if (deduct) {
        const upd = await db.txRun(
          t,
          "UPDATE variants SET stock = stock - ? WHERE id = ? AND stock >= ?",
          [qty, variantId, qty]
        );
        if (upd.rowsAffected === 0)
          throw new Error(`Not enough stock for size ${v.size}. Only ${v.stock} left.`);
      }
      rows.push({ v, qty });
    }

    // manual orders: the seller already knows the total, so mark it quoted
    const o = await db.txRun(
      t,
      `INSERT INTO orders (code, customer_name, phone, address, contact, notes, status, shipping_fee, quoted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now'))`,
      [code, name, String(c.phone || "").trim() || "—", String(c.address || "").trim() || "—",
       String(c.contact || "").trim(), String(c.notes || "").trim(), fee]
    );
    const orderId = o.lastInsertRowid;
    let itemsTotal = 0;
    for (const { v, qty } of rows) {
      await db.txRun(
        t,
        `INSERT INTO order_items (order_id, variant_id, product_name, size, qty, unit_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, v.id, v.product_name, v.size, qty, v.price]
      );
      itemsTotal += v.price * qty;
    }
    if (date)
      await db.txRun(t, "UPDATE orders SET created_at = ? WHERE id = ?", [date + " 00:00:00", orderId]);
    if (paid) {
      const paidAt = date ? date + " 00:00:00" : null;
      await db.txRun(
        t,
        "UPDATE orders SET status = 'paid', paid_at = COALESCE(?, datetime('now')) WHERE id = ?",
        [paidAt, orderId]
      );
      await db.txRun(
        t,
        `INSERT INTO transactions (type, category, description, amount, order_id, tx_date)
         VALUES ('income', 'Sales', ?, ?, ?, COALESCE(?, date('now')))`,
        [`Order ${code} — ${name} (manual)`, itemsTotal + fee, orderId, date]
      );
      // auto-log this order's shipping cost as an expense on the same date
      if (fee > 0)
        await db.txRun(
          t,
          `INSERT INTO transactions (type, category, description, amount, order_id, tx_date)
           VALUES ('expense', 'Shipping', ?, ?, ?, COALESCE(?, date('now')))`,
          [`Order ${code} — shipping cost`, fee, orderId, date]
        );
    }
    await t.commit();
    res.json({ code });
  } catch (err) {
    try { await t.rollback(); } catch {}
    res.status(400).json({ error: err.message || "Could not add order." });
  }
}));

// summary report for a date range
app.get("/api/admin/report", requireAdmin, wrap(async (req, res) => {
  const valid = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? s : null);
  const today = new Date().toISOString().slice(0, 10);
  const from = valid(req.query.from) || today.slice(0, 8) + "01";
  const to = valid(req.query.to) || today;

  const money = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
     FROM transactions WHERE tx_date BETWEEN ? AND ?`,
    [from, to]
  );
  const byCategory = await db.all(
    `SELECT type, category, COALESCE(SUM(amount),0) AS total, COUNT(*) AS n
     FROM transactions WHERE tx_date BETWEEN ? AND ?
     GROUP BY type, category ORDER BY type DESC, total DESC`,
    [from, to]
  );
  const sold = await db.all(
    `SELECT oi.product_name, oi.size, SUM(oi.qty) AS qty, SUM(oi.qty * oi.unit_price) AS amount
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status IN ('paid','shipped') AND date(o.paid_at) BETWEEN ? AND ?
     GROUP BY oi.product_name, oi.size ORDER BY oi.product_name, qty DESC`,
    [from, to]
  );
  const ordersPaid = (await db.get(
    `SELECT COUNT(*) AS n FROM orders
     WHERE status IN ('paid','shipped') AND date(paid_at) BETWEEN ? AND ?`,
    [from, to]
  )).n;

  res.json({
    from, to,
    gross_sales: money.income,
    expenses: money.expense,
    profit: money.income - money.expense,
    orders_paid: ordersPaid,
    items_sold: sold.reduce((s, r) => s + r.qty, 0),
    sold,
    by_category: byCategory
  });
}));

// CSV exports (open directly in Excel)
function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function sendCsv(res, filename, header, rows) {
  const body = "﻿" + [header, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(body);
}

app.get("/api/admin/export/orders.csv", requireAdmin, wrap(async (req, res) => {
  const orders = await ordersWithItems(await db.all("SELECT * FROM orders ORDER BY id"));
  const rows = orders.map((o) => [
    o.code, o.created_at, o.status, o.customer_name, o.phone, o.address, o.contact,
    o.items.map((it) => `${it.size} x${it.qty}`).join(" | "),
    o.items_total, o.shipping_fee, o.total, o.paid_at || "", o.tracking || "", o.notes
  ]);
  sendCsv(res, "wave3-orders.csv",
    ["Order Code", "Created", "Status", "Customer", "Phone", "Address", "Social", "Items", "Items Total", "Shipping", "Total", "Paid At", "Tracking", "Notes"],
    rows);
}));

app.get("/api/admin/export/transactions.csv", requireAdmin, wrap(async (req, res) => {
  const rows = (await db.all(
    `SELECT t.*, o.code AS order_code FROM transactions t
     LEFT JOIN orders o ON o.id = t.order_id ORDER BY t.tx_date, t.id`
  )).map((t) => [
    t.tx_date, t.type, t.category, t.description,
    t.type === "income" ? t.amount : "", t.type === "expense" ? t.amount : "",
    t.order_code || ""
  ]);
  sendCsv(res, "wave3-money.csv",
    ["Date", "Type", "Category", "Description", "Income", "Expense", "Order Code"],
    rows);
}));

// products & inventory
app.get("/api/admin/inventory", requireAdmin, wrap(async (req, res) => {
  const products = await db.all("SELECT * FROM products ORDER BY id");
  for (const p of products)
    p.variants = await db.all("SELECT * FROM variants WHERE product_id = ? ORDER BY sort, id", [p.id]);
  res.json({ products });
}));

app.post("/api/admin/products", requireAdmin, wrap(async (req, res) => {
  const { id, name, description, price, active } = req.body || {};
  const nm = String(name || "").trim();
  const pr = Number(price);
  if (!nm || !Number.isFinite(pr) || pr < 0)
    return res.status(400).json({ error: "Name and a valid price are required." });
  if (id) {
    await db.run("UPDATE products SET name = ?, description = ?, price = ?, active = ? WHERE id = ?",
      [nm, String(description || ""), pr, active ? 1 : 0, Number(id)]);
    res.json({ id: Number(id) });
  } else {
    const r = await db.run("INSERT INTO products (name, description, price) VALUES (?, ?, ?)",
      [nm, String(description || ""), pr]);
    res.json({ id: r.lastInsertRowid });
  }
}));

// upload / replace / remove a product photo (stored in the DB like QRs)
app.post("/api/admin/products/:id/photo", requireAdmin, wrap(async (req, res) => {
  const p = await db.get("SELECT * FROM products WHERE id = ?", [Number(req.params.id)]);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const image = String((req.body || {}).image || "");
  if (!image) {
    await db.deleteMedia(p.image);
    await db.run("UPDATE products SET image = NULL WHERE id = ?", [p.id]);
    return res.json({ ok: true });
  }
  const m = image.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "Please upload a PNG, JPG, or WEBP image." });
  if (Buffer.from(m[2], "base64").length > 8 * 1024 * 1024)
    return res.status(400).json({ error: "Image too large (max 8 MB)." });
  const id = await db.saveMedia(image);
  await db.deleteMedia(p.image);
  await db.run("UPDATE products SET image = ? WHERE id = ?", [id, p.id]);
  res.json({ image: id });
}));

// delete a whole product (only if none of its sizes have ever been ordered)
app.delete("/api/admin/products/:id", requireAdmin, wrap(async (req, res) => {
  const p = await db.get("SELECT * FROM products WHERE id = ?", [Number(req.params.id)]);
  if (!p) return res.status(404).json({ error: "Product not found." });
  const used = await db.get(
    `SELECT 1 AS x FROM order_items oi JOIN variants v ON v.id = oi.variant_id
     WHERE v.product_id = ? LIMIT 1`, [p.id]);
  if (used)
    return res.status(400).json({ error: "This product has orders — untick 'Visible in store' to hide it instead." });
  await db.run("DELETE FROM variants WHERE product_id = ?", [p.id]);
  await db.deleteMedia(p.image);
  await db.run("DELETE FROM products WHERE id = ?", [p.id]);
  res.json({ ok: true });
}));

app.post("/api/admin/variants", requireAdmin, wrap(async (req, res) => {
  const { id, product_id, size, stock, length_in, width_in, sleeves_in } = req.body || {};
  const st = Math.floor(Number(stock));
  if (!Number.isFinite(st) || st < 0)
    return res.status(400).json({ error: "Stock must be 0 or more." });
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  if (id) {
    await db.run(
      "UPDATE variants SET size = ?, stock = ?, length_in = ?, width_in = ?, sleeves_in = ? WHERE id = ?",
      [String(size || "").trim(), st, num(length_in), num(width_in), num(sleeves_in), Number(id)]
    );
    res.json({ id: Number(id) });
  } else {
    if (!product_id || !String(size || "").trim())
      return res.status(400).json({ error: "Product and size are required." });
    const maxSort = (await db.get("SELECT COALESCE(MAX(sort), -1) AS s FROM variants WHERE product_id = ?", [Number(product_id)])).s;
    const r = await db.run(
      "INSERT INTO variants (product_id, size, stock, length_in, width_in, sleeves_in, sort) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [Number(product_id), String(size).trim(), st, num(length_in), num(width_in), num(sleeves_in), maxSort + 1]
    );
    res.json({ id: r.lastInsertRowid });
  }
}));

app.delete("/api/admin/variants/:id", requireAdmin, wrap(async (req, res) => {
  const used = await db.get("SELECT 1 AS x FROM order_items WHERE variant_id = ? LIMIT 1", [Number(req.params.id)]);
  if (used)
    return res.status(400).json({ error: "This size has orders — set its stock to 0 instead." });
  await db.run("DELETE FROM variants WHERE id = ?", [Number(req.params.id)]);
  res.json({ ok: true });
}));

// money
app.get("/api/admin/transactions", requireAdmin, wrap(async (req, res) => {
  const rows = await db.all("SELECT * FROM transactions ORDER BY tx_date DESC, id DESC LIMIT 500");
  const money = await db.get(
    `SELECT
       COALESCE(SUM(CASE WHEN type='income' THEN amount END), 0) AS income,
       COALESCE(SUM(CASE WHEN type='expense' THEN amount END), 0) AS expense
     FROM transactions`
  );
  // shipping portion of collected income (per-order fee, only orders whose income is logged)
  const ship = await db.get(
    `SELECT COALESCE(SUM(o.shipping_fee), 0) AS s
     FROM transactions t JOIN orders o ON o.id = t.order_id
     WHERE t.type = 'income'`
  );
  res.json({
    transactions: rows,
    income: money.income,
    expense: money.expense,
    profit: money.income - money.expense,
    shipping_collected: ship.s,
    merch_sales: money.income - ship.s
  });
}));

app.post("/api/admin/transactions", requireAdmin, wrap(async (req, res) => {
  const { type, category, description, amount, tx_date } = req.body || {};
  if (type !== "income" && type !== "expense")
    return res.status(400).json({ error: "Type must be income or expense." });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0)
    return res.status(400).json({ error: "Amount must be greater than 0." });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(tx_date || "")) ? tx_date : new Date().toISOString().slice(0, 10);
  const r = await db.run(
    "INSERT INTO transactions (type, category, description, amount, tx_date) VALUES (?, ?, ?, ?, ?)",
    [type, String(category || "Other").trim() || "Other", String(description || "").trim(), amt, date]
  );
  res.json({ id: r.lastInsertRowid });
}));

app.delete("/api/admin/transactions/:id", requireAdmin, wrap(async (req, res) => {
  await db.run("DELETE FROM transactions WHERE id = ?", [Number(req.params.id)]);
  res.json({ ok: true });
}));

// settings
app.get("/api/admin/settings", requireAdmin, wrap(async (req, res) => {
  res.json({
    settings: await publicSettings(),
    payment_channels: await paymentChannels(),
    contact_channels: await contactChannels(),
    products: await db.all("SELECT id, name, featured, badge FROM products ORDER BY id")
  });
}));

app.post("/api/admin/settings", requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.business_name !== undefined) await db.setSetting("business_name", String(b.business_name).trim());
  if (b.business_sub !== undefined) await db.setSetting("business_sub", String(b.business_sub).trim());
  if (b.tagline !== undefined) await db.setSetting("tagline", String(b.tagline).trim());
  if (b.currency !== undefined) await db.setSetting("currency", String(b.currency).trim() || "₱");
  if (b.shipping_fee !== undefined) {
    const fee = Number(b.shipping_fee);
    if (!Number.isFinite(fee) || fee < 0)
      return res.status(400).json({ error: "Invalid shipping fee." });
    await db.setSetting("shipping_fee", fee);
  }
  if (b.payment_note !== undefined) await db.setSetting("payment_note", String(b.payment_note));
  if (b.story_text !== undefined) await db.setSetting("story_text", String(b.story_text).slice(0, 20000));
  for (const i of [1, 2, 3, 4])
    if (b["movement_story_" + i] !== undefined)
      await db.setSetting("movement_story_" + i, String(b["movement_story_" + i]).slice(0, 2000));
  // hero image: base64 upload replaces it, empty string resets to the default
  if (b.hero_data !== undefined) {
    const old = await db.getSetting("hero_image", "");
    if (b.hero_data === "") {
      await db.deleteMedia(old);
      await db.setSetting("hero_image", "");
    } else {
      const m = String(b.hero_data).match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: "Hero image must be a PNG, JPG, or WEBP." });
      if (Buffer.from(m[2], "base64").length > 8 * 1024 * 1024)
        return res.status(400).json({ error: "Hero image too large (max 8 MB)." });
      const id = await db.saveMedia(String(b.hero_data));
      await db.deleteMedia(old);
      await db.setSetting("hero_image", id);
    }
  }
  if (b.coming_soon !== undefined) {
    if (!Array.isArray(b.coming_soon))
      return res.status(400).json({ error: "Invalid coming-soon list." });
    const cleaned = b.coming_soon.map((n) => String(n).trim()).filter(Boolean).slice(0, 12);
    await db.setSetting("coming_soon", JSON.stringify(cleaned));
  }
  if (b.featured !== undefined) {
    if (!Array.isArray(b.featured))
      return res.status(400).json({ error: "Invalid featured list." });
    for (const f of b.featured) {
      if (!f || !Number.isFinite(Number(f.id))) continue;
      await db.run("UPDATE products SET featured = ?, badge = ? WHERE id = ?",
        [f.featured ? 1 : 0, String(f.badge || "").trim().slice(0, 40) || null, Number(f.id)]);
    }
  }
  if (b.discord_url !== undefined) {
    let url = String(b.discord_url).trim();
    if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
    await db.setSetting("discord_url", url);
  }
  if (b.payment_window_hours !== undefined) {
    const h = Number(b.payment_window_hours);
    if (!Number.isFinite(h) || h < 1 || h > 168)
      return res.status(400).json({ error: "Payment window must be between 1 and 168 hours." });
    await db.setSetting("payment_window_hours", h);
  }
  if (b.payment_channels !== undefined) {
    if (!Array.isArray(b.payment_channels))
      return res.status(400).json({ error: "Invalid payment channels." });
    const oldQrIds = (await paymentChannels()).map((c) => c.qr).filter(Boolean);
    const cleaned = [];
    for (const c of b.payment_channels) {
      const ch = {
        label: String(c.label || "").trim(),
        kind: ["bank", "gcash", "crypto", "other"].includes(c.kind) ? c.kind : "other",
        lines: Array.isArray(c.lines)
          ? c.lines.map((l) => String(l).trim()).filter(Boolean)
          : String(c.lines || "").split("\n").map((l) => l.trim()).filter(Boolean),
        // keep an existing QR (a media id) unless replaced or removed
        qr: typeof c.qr === "string" && /^m[0-9a-f]+$/.test(c.qr) ? c.qr : null
      };
      if (typeof c.qr_data === "string") {
        const m = c.qr_data.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/);
        if (!m) return res.status(400).json({ error: "QR must be a PNG, JPG, or WEBP image." });
        if (Buffer.from(m[2], "base64").length > 5 * 1024 * 1024)
          return res.status(400).json({ error: "QR image too large (max 5 MB)." });
        ch.qr = await db.saveMedia(c.qr_data);
      }
      if (ch.label) cleaned.push(ch);
    }
    await db.setSetting("payment_channels", JSON.stringify(cleaned));
    // clean up QR images no longer referenced
    const newQrIds = cleaned.map((c) => c.qr).filter(Boolean);
    for (const id of oldQrIds) if (!newQrIds.includes(id)) await db.deleteMedia(id);
  }
  if (b.contact_channels !== undefined) {
    if (!Array.isArray(b.contact_channels))
      return res.status(400).json({ error: "Invalid contact channels." });
    const cleaned = b.contact_channels
      .map((c) => {
        let url = String(c.url || "").trim();
        if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
        return { label: String(c.label || "").trim(), url };
      })
      .filter((c) => c.label && c.url);
    await db.setSetting("contact_channels", JSON.stringify(cleaned));
  }
  res.json({ ok: true });
}));

app.post("/api/admin/password", requireAdmin, wrap(async (req, res) => {
  const { current, next } = req.body || {};
  if (db.hashPassword(String(current || "")) !== (await db.getSetting("admin_password_hash")))
    return res.status(400).json({ error: "Current password is wrong." });
  if (String(next || "").length < 6)
    return res.status(400).json({ error: "New password must be at least 6 characters." });
  await db.setSetting("admin_password_hash", db.hashPassword(String(next)));
  res.json({ ok: true });
}));

// ---------- pages ----------
app.get("/order/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "order.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/shop", (req, res) => res.sendFile(path.join(__dirname, "public", "shop.html")));
app.get("/story", (req, res) => res.sendFile(path.join(__dirname, "public", "story.html")));
app.get("/track", (req, res) => res.sendFile(path.join(__dirname, "public", "track.html")));
app.get("/cart", (req, res) => res.sendFile(path.join(__dirname, "public", "cart.html")));

// one-time repair, every boot (idempotent): any paid/shipped order missing its
// auto shipping expense gets it logged, dated to when it was paid
async function backfillShippingExpenses() {
  const rows = await db.all(
    `SELECT o.id, o.code, o.shipping_fee, o.paid_at FROM orders o
     WHERE o.status IN ('paid','shipped') AND o.shipping_fee > 0
       AND NOT EXISTS (
         SELECT 1 FROM transactions t
         WHERE t.order_id = o.id AND t.type = 'expense' AND t.category = 'Shipping'
       )`
  );
  for (const o of rows)
    await db.run(
      `INSERT INTO transactions (type, category, description, amount, order_id, tx_date)
       VALUES ('expense', 'Shipping', ?, ?, ?, COALESCE(date(?), date('now')))`,
      [`Order ${o.code} — shipping cost`, o.shipping_fee, o.id, o.paid_at]
    );
  if (rows.length) console.log(`Backfilled shipping expenses for ${rows.length} order(s).`);
}

// ---------- boot ----------
db.init()
  .then(() => {
    backfillShippingExpenses().catch((e) => console.error("backfill:", e));
    // sweep expired orders every 5 minutes
    setInterval(() => expireStaleOrders().catch((e) => console.error("expire sweep:", e)), 5 * 60 * 1000);
    app.listen(PORT, () => {
      console.log(`Wave3 shop running at http://localhost:${PORT}`);
      console.log(`Admin dashboard:      http://localhost:${PORT}/admin`);
    });
  })
  .catch((err) => {
    console.error("Failed to start — database init error:", err);
    process.exit(1);
  });
