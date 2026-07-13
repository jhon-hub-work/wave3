/* Shared header + footer + cart store for all customer pages.
   Exposes: window.W3 = { data: Promise<shopData>, cart, money helpers } */
(() => {
  // ---------- cart (localStorage) ----------
  const CART_KEY = "w3cart";
  function cartGet() {
    try {
      const v = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
      return Array.isArray(v) ? v.filter((i) => i && i.v && i.q > 0) : [];
    } catch {
      return [];
    }
  }
  function cartSet(items) {
    localStorage.setItem(CART_KEY, JSON.stringify(items.filter((i) => i.q > 0)));
    updateBadge();
  }
  function cartAdd(variantId, qty) {
    const items = cartGet();
    const found = items.find((i) => i.v === variantId);
    if (found) found.q += qty;
    else items.push({ v: variantId, q: qty });
    cartSet(items);
  }
  function cartCount() {
    return cartGet().reduce((s, i) => s + i.q, 0);
  }
  function updateBadge() {
    const b = document.getElementById("cart-badge");
    if (!b) return;
    const n = cartCount();
    b.textContent = n;
    b.classList.toggle("hidden", n === 0);
  }

  // ---------- header ----------
  const path = location.pathname;
  const active = (p) => (p === path ? " active" : "");
  const header = document.createElement("div");
  header.innerHTML = `
  <div class="announce" id="announce-bar">
    <span class="announce-text">WAVE 3 IS A FREE TRADING COMMUNITY. EDUCATION. SUPPORT. GROWTH. ALWAYS FREE.</span>
    <a href="#" id="announce-join" class="announce-join hidden" target="_blank" rel="noopener">JOIN THE COMMUNITY <span aria-hidden="true">&#8594;</span></a>
  </div>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="logo-mark" href="/" aria-label="Wave 3 Collective — home">
        <img src="/logo-mark.png" width="34" height="34" alt="" style="display:block;object-fit:contain" />
        <span class="logo-text-2"><span class="l1">WAVE <span class="three">3</span></span><span class="l2">COLLECTIVE</span></span>
      </a>
      <nav class="mainnav" id="mainnav">
        <a href="/" class="navlink${active("/")}">Home</a>
        <a href="/shop" class="navlink${active("/shop")}">Shop</a>
        <a href="/story" class="navlink${active("/story")}">Our Story</a>
        <a href="#" id="nav-community" class="navlink" target="_blank" rel="noopener">Community</a>
        <a href="/track" class="navlink${active("/track")}">Track Order</a>
      </nav>
      <div class="nav-actions">
        <select id="cur-select" autocomplete="off" aria-label="Currency">
          <option value="PHP">&#8369; PHP</option>
          <option value="USD">$ USD</option>
          <option value="USDT">USDT</option>
        </select>
        <button class="icon-btn" id="search-btn" aria-label="Search products">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        </button>
        <a class="icon-btn" href="/cart" aria-label="Cart">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1.6"/><circle cx="19" cy="21" r="1.6"/><path d="M2.5 3h2l2.6 12.4a1.8 1.8 0 0 0 1.8 1.6h9.7a1.8 1.8 0 0 0 1.8-1.5L22 7H6"/></svg>
          <span class="cart-badge hidden" id="cart-badge">0</span>
        </a>
        <button class="icon-btn nav-burger" id="nav-burger" aria-label="Menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
      </div>
    </div>
    <div class="search-bar hidden" id="search-bar">
      <div class="container" style="display:flex; gap:10px; padding-top:10px; padding-bottom:12px;">
        <input type="text" id="search-input" placeholder="Search products by name…" aria-label="Search products" />
        <button class="btn btn-primary btn-sm" id="search-go">Search</button>
      </div>
    </div>
  </header>`;
  document.body.prepend(header);

  // ---------- footer ----------
  const footer = document.createElement("footer");
  footer.className = "site-footer";
  footer.innerHTML = `
    <div class="container">
      <div class="footer-grid">
        <div class="footer-brand">
          <a class="logo-mark" href="/">
            <img src="/logo-mark.png" width="30" height="30" alt="" style="display:block;object-fit:contain" />
            <span class="logo-text-2"><span class="l1">WAVE <span class="three">3</span></span><span class="l2">COLLECTIVE</span></span>
          </a>
          <p class="muted small mt-1">Built on vision.<br/>Designed for the future.<br/>The movement continues.</p>
        </div>
        <div>
          <p class="footer-head">Shop</p>
          <a href="/shop">All Products</a>
          <a href="/cart">Cart</a>
        </div>
        <div>
          <p class="footer-head">Company</p>
          <a href="/story">Our Story</a>
          <a href="#" id="foot-community" target="_blank" rel="noopener">Community</a>
        </div>
        <div>
          <p class="footer-head">Help</p>
          <a href="/track">Track Order</a>
          <span id="foot-contacts"></span>
        </div>
      </div>
      <p class="muted small mt-4" style="text-align:center;">&copy; <span id="foot-year"></span> WAVE3 COLLECTIVE. ALL RIGHTS RESERVED. &nbsp;&#9642;&nbsp; ONE WAVE. ONE GOAL.</p>
    </div>`;
  document.body.appendChild(footer);
  document.getElementById("foot-year").textContent = new Date().getFullYear();

  // ---------- wiring ----------
  document.getElementById("nav-burger").addEventListener("click", () => {
    document.getElementById("mainnav").classList.toggle("open");
  });

  const searchBar = document.getElementById("search-bar");
  document.getElementById("search-btn").addEventListener("click", () => {
    searchBar.classList.toggle("hidden");
    if (!searchBar.classList.contains("hidden")) document.getElementById("search-input").focus();
  });
  function goSearch() {
    const q = document.getElementById("search-input").value.trim();
    window.location.href = "/shop" + (q ? "?q=" + encodeURIComponent(q) : "");
  }
  document.getElementById("search-go").addEventListener("click", goSearch);
  document.getElementById("search-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") goSearch();
  });

  document.getElementById("cur-select").addEventListener("change", () => {
    localStorage.setItem("w3cur", document.getElementById("cur-select").value);
    location.reload();
  });

  updateBadge();

  // ---------- shared data + money ----------
  const CURS = { PHP: "₱", USD: "$", USDT: "USDT " };
  const symToCode = (s) => (s === "$" ? "USD" : s === "USDT" ? "USDT" : "PHP");
  const state = { baseCode: "PHP", fx: { PHP: 58, USD: 1, USDT: 1 } };

  const data = fetch("/api/shop")
    .then((r) => r.json())
    .then((shop) => {
      state.baseCode = symToCode(shop.settings.currency || "₱");
      if (shop.settings.fx) state.fx = shop.settings.fx;
      const viewCode = localStorage.getItem("w3cur");
      document.getElementById("cur-select").value =
        viewCode && CURS[viewCode] ? viewCode : state.baseCode;

      // community links
      const discord = shop.settings.discord;
      for (const id of ["nav-community", "foot-community", "announce-join"]) {
        const el = document.getElementById(id);
        if (discord) {
          el.href = discord;
          el.classList.remove("hidden");
        } else if (id !== "nav-community") {
          el.classList.add("hidden");
        } else {
          el.style.display = "none";
        }
      }
      // footer contacts
      const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      document.getElementById("foot-contacts").innerHTML = (shop.contacts || [])
        .map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.label)}</a>`)
        .join("");
      return shop;
    });

  window.W3 = {
    data,
    cart: { get: cartGet, set: cartSet, add: cartAdd, count: cartCount, updateBadge },
    money(n) {
      const viewCode = localStorage.getItem("w3cur");
      const v = viewCode && CURS[viewCode] ? viewCode : state.baseCode;
      const amt = v === state.baseCode ? Number(n) : (Number(n) / state.fx[state.baseCode]) * state.fx[v];
      const str = amt.toLocaleString("en-PH", {
        maximumFractionDigits: 2,
        minimumFractionDigits: v === "PHP" ? 0 : 2
      });
      return (v !== state.baseCode ? "≈" : "") + CURS[v] + str;
    },
    esc: (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]))
  };
})();
