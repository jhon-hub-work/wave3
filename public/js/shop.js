(() => {
  const $ = (s) => document.querySelector(s);
  const toastEl = $("#toast");
  let toastTimer;
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("error", isError);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
  }

  let shop = null;
  const qty = new Map(); // variant_id -> qty
  let currency = "₱";

  // customer currency: prices are stored in the base currency; the shopper's
  // pick converts on the fly with live rates (fx = units per 1 USD)
  const CURS = { PHP: "₱", USD: "$", USDT: "USDT " };
  const symToCode = (s) => (s === "$" ? "USD" : s === "USDT" ? "USDT" : "PHP");
  let baseCode = "PHP";
  let fx = { PHP: 58, USD: 1, USDT: 1 };
  let viewCode = localStorage.getItem("w3cur");

  const money = (n) => {
    const v = viewCode && CURS[viewCode] ? viewCode : baseCode;
    const amt = v === baseCode ? Number(n) : (Number(n) / fx[baseCode]) * fx[v];
    const str = amt.toLocaleString("en-PH", {
      maximumFractionDigits: 2,
      minimumFractionDigits: v === "PHP" ? 0 : 2
    });
    return (v !== baseCode ? "≈" : "") + CURS[v] + str;
  };

  function stockNote(stock) {
    if (stock <= 0) return '<span class="stock-note stock-out">SOLD OUT</span>';
    if (stock <= 5) return `<span class="stock-note stock-low">Only ${stock} left</span>`;
    return `<span class="stock-note stock-ok">${stock} in stock</span>`;
  }

  function render() {
    const product = shop.products[0];
    if (!product) return;
    currency = shop.settings.currency || "₱";
    baseCode = symToCode(currency);
    if (shop.settings.fx) fx = shop.settings.fx;
    $("#cur-select").value = viewCode && CURS[viewCode] ? viewCode : baseCode;

    // uploaded product photo (falls back to the bundled tshirt.svg)
    if (product.image) $("#product-photo").src = "/media/" + encodeURIComponent(product.image);
    $("#product-name").textContent = product.name;
    $("#product-price").textContent = money(product.price);
    $("#product-desc").textContent = product.description;
    if (shop.settings.tagline) $("#tagline").textContent = shop.settings.tagline;
    document.title = `${shop.settings.business_sub || "WAVE3"} — Official Store`;

    // marquee
    const words = ["Premium embroidery", "240 GSM heavyweight", "Limited stock", "First paid first served", "The movement continues"];
    $("#marquee").innerHTML = Array(3)
      .fill(words.map((w) => `<span>${w}</span><span class="dot">◆</span>`).join(""))
      .join("");

    // size rows
    const rowsEl = $("#size-rows");
    rowsEl.innerHTML = "";
    for (const v of product.variants) {
      const row = document.createElement("div");
      row.className = "size-row" + (v.stock <= 0 ? " soldout" : "");
      row.dataset.vid = v.id;
      const meta = [v.length_in && `L ${v.length_in}"`, v.width_in && `W ${v.width_in}"`, v.sleeves_in && `SL ${v.sleeves_in}"`]
        .filter(Boolean)
        .join(" · ");
      row.innerHTML = `
        <span class="size-label">${v.size}</span>
        <span class="size-meta">${meta}</span>
        ${stockNote(v.stock)}
        <span class="qty-stepper">
          <button type="button" class="dec" aria-label="Decrease ${v.size} quantity" ${v.stock <= 0 ? "disabled" : ""}>−</button>
          <span class="qty" data-qty="${v.id}">0</span>
          <button type="button" class="inc" aria-label="Increase ${v.size} quantity" ${v.stock <= 0 ? "disabled" : ""}>+</button>
        </span>`;
      row.querySelector(".inc").addEventListener("click", () => bump(v, 1));
      row.querySelector(".dec").addEventListener("click", () => bump(v, -1));
      rowsEl.appendChild(row);
    }

    // size chart
    const tbody = $("#size-chart-table tbody");
    tbody.innerHTML = product.variants
      .map(
        (v) =>
          `<tr><td><strong>${v.size}</strong></td><td>${v.length_in ?? "—"}"</td><td>${v.width_in ?? "—"}"</td><td>${v.sleeves_in ?? "—"}"</td></tr>`
      )
      .join("");

    // contact channels
    const contacts = shop.contacts || [];
    $("#contact-box").classList.toggle("hidden", contacts.length === 0);
    $("#contact-row").innerHTML = contacts
      .map(
        (c) =>
          `<a class="btn btn-ghost btn-sm" href="${String(c.url).replace(/"/g, "&quot;")}" target="_blank" rel="noopener">${String(c.label).replace(/[<>&]/g, "")}</a>`
      )
      .join("");

    updateSummary();
  }

  function bump(variant, delta) {
    const current = qty.get(variant.id) || 0;
    const next = Math.max(0, Math.min(variant.stock, current + delta));
    if (next === current && delta > 0) toast(`Only ${variant.stock} pcs left for size ${variant.size}.`, true);
    qty.set(variant.id, next);
    const el = document.querySelector(`[data-qty="${variant.id}"]`);
    if (el) el.textContent = next;
    const row = document.querySelector(`.size-row[data-vid="${variant.id}"]`);
    if (row) row.classList.toggle("selected", next > 0);
    updateSummary();
  }

  function selectedItems() {
    const out = [];
    for (const [vid, q] of qty) if (q > 0) out.push({ variant_id: vid, qty: q });
    return out;
  }

  function updateSummary() {
    const product = shop.products[0];
    let count = 0;
    let total = 0;
    for (const [vid, q] of qty) {
      if (q <= 0) continue;
      count += q;
      total += q * product.price;
    }
    $("#sum-items").textContent = count
      ? `${count} pc${count > 1 ? "s" : ""} — ${money(total)}`
      : "None selected";
    const fee = shop.settings.shipping_fee;
    $("#sum-shipping").textContent = fee > 0 ? money(fee) : "To be confirmed";
    $("#sum-total").textContent = money(total + (fee > 0 ? fee : 0)) + (fee > 0 ? "" : " + shipping");
  }

  async function load() {
    const res = await fetch("/api/shop");
    shop = await res.json();
    render();
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function placeOrder(items, customer) {
    const btn = $("#submit-btn");
    btn.disabled = true;
    btn.textContent = "Placing order…";
    try {
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items, customer })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not place order.");
      window.location.href = `/order/${data.code}`;
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Place order";
      load(); // refresh stock in case it changed
    }
  }

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const items = selectedItems();
    if (items.length === 0) return toast("Pick a size and quantity first.", true);

    const name = $("#f-name").value.trim();
    const phone = $("#f-phone").value.trim();
    const address = $("#f-address").value.trim();
    if (!name || !phone || !address)
      return toast("Please fill in your name, mobile number, and address.", true);
    const customer = { name, phone, address, contact: $("#f-contact").value.trim(), notes: $("#f-notes").value.trim() };

    // build the confirmation summary
    const product = shop.products[0];
    const fee = shop.settings.shipping_fee;
    let itemsTotal = 0;
    const lines = items
      .map((it) => {
        const v = product.variants.find((x) => x.id === it.variant_id);
        itemsTotal += product.price * it.qty;
        return `<div class="summary-line"><span class="muted">${esc(product.name)} — ${esc(v.size)} × ${it.qty}</span><span>${money(product.price * it.qty)}</span></div>`;
      })
      .join("");
    $("#cf-items").innerHTML =
      lines +
      `<div class="summary-line"><span class="muted">Shipping</span><span>${fee > 0 ? money(fee) : "To be confirmed"}</span></div>` +
      `<div class="summary-line summary-total"><span>Total</span><span>${money(itemsTotal + (fee > 0 ? fee : 0))}${fee > 0 ? "" : " + shipping"}</span></div>`;
    $("#cf-details").innerHTML =
      `<div><strong>${esc(name)}</strong></div>
       <div class="muted small">${esc(phone)}</div>
       <div class="muted small">${esc(address)}</div>` +
      (customer.contact ? `<div class="muted small">${esc(customer.contact)}</div>` : "") +
      (customer.notes ? `<div class="muted small">📝 ${esc(customer.notes)}</div>` : "");

    $("#confirm-modal").classList.remove("hidden");
    $("#cf-place").onclick = () => {
      $("#confirm-modal").classList.add("hidden");
      placeOrder(items, customer);
    };
  });
  $("#cf-edit").addEventListener("click", () => $("#confirm-modal").classList.add("hidden"));

  function goTrack() {
    // the W3- prefix is fixed in the UI; the input holds only the 6-char tail
    const tail = $("#track-input").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (tail.length !== 6) return toast("Order codes have 6 characters after W3- (e.g. W3-ABC123).", true);
    window.location.href = `/order/${encodeURIComponent("W3-" + tail)}`;
  }
  $("#track-btn").addEventListener("click", goTrack);
  $("#track-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") goTrack();
  });
  $("#track-input").addEventListener("input", () => {
    const el = $("#track-input");
    // letters and numbers only; if someone pastes a full W3-ABC123 code, keep the tail
    let v = el.value.toUpperCase();
    if (v.startsWith("W3-")) v = v.slice(3);
    v = v.replace(/[^A-Z0-9]/g, "").slice(0, 6);
    if (v !== el.value) el.value = v;
  });

  // mobile number field: digits (and + - space parentheses) only
  $("#f-phone").addEventListener("input", () => {
    const el = $("#f-phone");
    const clean = el.value.replace(/[^0-9+\-\s()]/g, "");
    if (clean !== el.value) el.value = clean;
  });

  $("#cur-select").addEventListener("change", () => {
    localStorage.setItem("w3cur", $("#cur-select").value);
    location.reload();
  });

  $("#year").textContent = new Date().getFullYear();
  load().catch(() => toast("Could not load the shop. Refresh the page.", true));
})();
