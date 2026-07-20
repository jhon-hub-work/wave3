# Wave3 Collective PH

**A complete custom e-commerce + business-management platform for a Philippine streetwear brand.**
Custom storefront, a fully custom CMS, real-time inventory, and payment operations — built from scratch, end to end.

🔗 **Live site:** [wave3collectiveph.com](https://wave3collectiveph.com)
📄 **Full case study** (engineering decisions, business impact, and results): [wave3-portfolio.netlify.app](https://wave3-portfolio.netlify.app)

> No Shopify. No WordPress. No Wix. No templates. Every line is custom.

---

## What it is

This isn't a website — it's the operating system for a small brand. The owner runs the entire
business through a purpose-built admin CMS without touching code: products, pricing, inventory,
orders, payments, and every page of content. Version 1 sold out its first production batch.

## Features

### Storefront
- Editorial custom homepage with an interactive, expandable brand-story photo section
- Product catalog + detail pages, product search
- Multi-item shopping cart and checkout with an order-confirmation step
- **Shopee-style stock reservation** — stock is held at order time, a payment window counts down, and unpaid orders auto-expire and restock
- Payment-proof upload → owner verification → shareable receipt page with courier tracking
- Live per-size inventory, per-order shipping fees
- **Multi-currency display (PHP / USD / USDT)** with live FX conversion; records stay in the base currency
- CMS-authored brand story (blog), community links, contact channels

### Admin CMS
- **Dashboard** — orders to verify, pending payments, stock, income, expenses, net profit at a glance (with a privacy toggle that blurs figures for screenshots)
- **Product & inventory management** — add / edit / hide / delete products, per-size stock and measurements, photo uploads
- **Order operations** — verify payments, set shipping fees, add tracking, cancel/reverse (stock & books corrected automatically)
- **Money & reporting** — automatic income + shipping-expense logging on every sale, date-range reports, one-click Excel/CSV export
- **Content studio** — rich-text blog editor (fonts, colors, links, image uploads), hero-image upload, featured-product curation, homepage photo stories, payment channels with QR codes
- Manual / historical order entry, password management

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Node.js + Express (REST API) |
| Frontend | Vanilla JavaScript — no framework |
| Database | [Turso](https://turso.tech) — distributed SQLite via `@libsql/client` (async) |
| Hosting | [Render](https://render.com) (auto-deploy on push) |
| DNS / domain | GoDaddy → custom domain + SSL |

**Why vanilla JS?** To prove the fundamentals — cart, currency, order lifecycle, and UI state are
managed in disciplined plain JavaScript with zero framework overhead. The result is a fast, dependency-light
app (two runtime dependencies total).

## Architecture highlights

- **Race-condition-safe inventory** — stock decrements run inside database transactions at reservation time; verified by simulating two simultaneous buyers competing for the last unit (exactly one wins, every time).
- **Built for ephemeral infrastructure** — all media (payment receipts, QR codes, product photos, blog images) is stored in the database rather than on disk, because the free hosting tier's filesystem doesn't persist between deploys. The app survives every redeploy with zero data loss.
- **Self-healing bookkeeping** — every paid order auto-logs income and its exact shipping cost as an expense; an idempotent boot-time backfill safely repairs historical records.
- **Same code, two environments** — a local file-based SQLite database for development and cloud Turso in production, switched purely by environment variables.
- **Defense at both ends** — every money field and user input is validated client- and server-side; rich-text content is sanitized server-side before storage.

## Data model

`settings` · `products` · `variants` · `orders` · `order_items` · `transactions` · `media`

Orders move through a lifecycle of `pending → proof → paid → shipped`, with `cancelled` and `expired`
branches, each keeping stock and bookkeeping consistent.

## Running locally

```bash
npm install
npm start          # serves on http://localhost:3737
```

With no environment variables set, the app creates and seeds a local SQLite database on first boot
(`data/wave3.db`) — no external services required. The admin dashboard lives at `/admin`.

## Deployment

Production runs on Render with a Turso database. Set two environment variables:

```
DATABASE_URL=libsql://<your-db>.turso.io
DATABASE_AUTH_TOKEN=<token>
```

First boot auto-creates the schema and seed data on an empty database. Full step-by-step instructions
are in [`DEPLOY.md`](./DEPLOY.md).

## Project structure

```
server.js        Express app — all API routes + page serving
db.js            Async data layer + schema, seeds, and migrations
public/          Storefront + admin (HTML, CSS, vanilla JS)
  js/            nav, home, shop, cart, order, admin
render.yaml      Render blueprint
DEPLOY.md        Deployment guide
```

---

Designed, built, deployed, and documented by **Jhon Buerano** — self-taught full-stack developer.
[LinkedIn](https://www.linkedin.com/in/jhon-mycho-buerano)
