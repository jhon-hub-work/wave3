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
orders, payments, and every page of content.

> **Outcome:** Version 1 shipped to production and **sold out its first product batch** — real
> customers, real payments, real fulfillment. The owner now operates the entire business through
> the CMS with no developer in the loop.

## Project preview

**Storefront**

| | |
|---|---|
| ![Home page](docs/screenshots/home.jpg) | ![Product page](docs/screenshots/product.jpg) |
| **Home page** | **Product page** |
| ![Shopping cart](docs/screenshots/cart.jpg) | ![Checkout](docs/screenshots/checkout.jpg) |
| **Shopping cart** | **Checkout** |

**Admin CMS**

| | |
|---|---|
| ![Admin dashboard](docs/screenshots/dashboard.jpg) | ![Inventory management](docs/screenshots/inventory.jpg) |
| **Dashboard** | **Inventory management** |
| ![Product management](docs/screenshots/product-management.jpg) | ![Order &amp; payment verification](docs/screenshots/order-verification.jpg) |
| **Product management** | **Order &amp; payment verification** |

> Customer details in the admin screenshots are intentionally blurred — this repo is public.
> The [full case study](https://wave3-portfolio.netlify.app) has the complete gallery, including mobile views.

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
managed in disciplined plain JavaScript with zero framework overhead. The result is a fast,
dependency-light app (two runtime dependencies total). It's a deliberate constraint for a project of
this size, not a limitation: a component framework would earn its keep once the UI grows shared,
stateful views, but here it would have added build tooling and weight for no user-facing benefit.

## Architecture

A single Node/Express service renders the storefront and the admin CMS from the same `public/`
directory and backs both with one REST API and one database. The storefront is public; every admin
route sits behind a session cookie.

```mermaid
flowchart LR
    C["Customer UI<br/>(storefront)"] -->|"public API"| API
    A["Admin CMS<br/>(cookie-authed)"] -->|"admin API"| API
    API["Node.js + Express<br/>REST API"] --> DB[("Turso<br/>distributed SQLite")]
    subgraph Render["Render (hosting)"]
        C
        A
        API
    end
    API -.->|"env vars"| DB
```

## Architecture highlights

- **Race-condition-safe inventory** — stock decrements run inside database transactions at reservation time; verified by simulating two simultaneous buyers competing for the last unit (exactly one wins, every time).
- **Built for ephemeral infrastructure** — all media (payment receipts, QR codes, product photos, blog images) is stored in the database rather than on disk, because the free hosting tier's filesystem doesn't persist between deploys. Object storage (S3/R2) is the textbook answer at scale, but for a small catalog on a zero-cost tier it would have added a paid dependency for no real gain — storing media in SQLite trades a little query weight for guaranteed durability across redeploys and keeps the whole system on one free database.
- **Self-healing bookkeeping** — every paid order auto-logs income and its exact shipping cost as an expense; an idempotent boot-time backfill safely repairs historical records.
- **Same code, two environments** — a local file-based SQLite database for development and cloud Turso in production, switched purely by environment variables.
- **Defense at both ends** — every money field and user input is validated client- and server-side; rich-text content is sanitized server-side before storage.

## Data model

Seven tables. A product has many sized `variants`; an order captures many `order_items`, each a
snapshot of the variant bought (name, size, qty, unit price) so history stays accurate even if the
product later changes. `transactions` is the ledger — sales and expenses, optionally linked back to
the order that produced them. `media` holds every uploaded image, referenced by opaque id from
products, orders, and settings. `settings` is a key/value store for all CMS-editable content.

```mermaid
erDiagram
    products  ||--o{ variants     : "has sizes"
    products  ||--o{ order_items  : "snapshotted in"
    variants  ||--o{ order_items  : "ordered as"
    orders    ||--o{ order_items  : "contains"
    orders    ||--o| transactions : "may log"
    media     }o--o{ products     : "referenced by id"
    settings  }o--o{ media        : "references by id"
```

Orders move through a lifecycle of `pending → proof → paid → shipped`, with `cancelled` and `expired`
branches — every transition keeps stock counts and the ledger consistent (a cancellation restocks and
reverses its bookkeeping; an expiry releases reserved stock automatically).

## API overview

One REST API serves both sides. Routes are grouped by audience and responsibility rather than
sprawled flat — the goal below is to show that organization, not to list every endpoint.

**Public storefront** — no auth
| Endpoint | Purpose |
|---|---|
| `GET /api/shop` | Catalog, live stock, and CMS content for the storefront |
| `POST /api/orders` · `GET /api/orders/:code` | Place an order; look one up by its public code |
| `POST /api/orders/:code/proof` | Upload payment proof for an order |
| `GET /media/:id` · `GET /qr/:id` | Serve stored images (product photos, QR codes) |

**Admin** — behind a session cookie (`/api/admin/*`)
| Group | Responsibility |
|---|---|
| `login` · `logout` · `me` | Session auth |
| `overview` · `orders` · `orders/:id/action` | Dashboard + order operations (verify, ship, cancel, reverse) |
| `inventory` · `products` · `variants` | Catalog & stock management |
| `transactions` · `report` · `export/*.csv` | Ledger, reporting, and Excel/CSV exports |
| `settings` · `media` · `password` | CMS content, image uploads, credentials |

Mutations return JSON and are validated server-side; admin writes to money, stock, and content all
run through this single guarded surface.

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
server.js        HTTP layer — every REST route, auth guard, and page-serving handler
db.js            Data layer — schema, seeds, idempotent migrations, and all query helpers
public/          Everything the browser gets — storefront + admin, no build step
  *.html         One file per page (home, shop, cart, order, story, track, admin)
  styles.css     Shared design system
  js/            Page controllers — nav (shared), home, shop, cart, order, admin
render.yaml      Render deployment blueprint (build + start + env)
DEPLOY.md        Step-by-step production setup (Render + Turso + DNS)
docs/            Screenshots and supporting docs
```

Two files hold the whole backend: `server.js` (what the web exposes) and `db.js` (what the data
does). The frontend ships as static files with no bundler — what you read is what runs.

---

Designed, built, deployed, and documented by **Jhon Buerano** — self-taught full-stack developer.
[LinkedIn](https://www.linkedin.com/in/jhon-mycho-buerano)
