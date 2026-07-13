/* Shop page: product grid -> product detail -> add to cart / buy now. */
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
  let product = null; // currently open product
  const qty = new Map(); // variant_id -> qty for the open product
  const money = (n) => W3.money(n);
  const esc = W3.esc;

  const params = new URLSearchParams(location.search);
  const searchQ = (params.get("q") || "").trim().toLowerCase();
  const openId = Number(params.get("p")) || 0;

  function stockNote(stock) {
    if (stock <= 0) return '<span class="stock-note stock-out">SOLD OUT</span>';
    if (stock <= 5) return `<span class="stock-note stock-low">Only ${stock} left</span>`;
    return `<span class="stock-note stock-ok">${stock} in stock</span>`;
  }

  function renderGrid() {
    const grid = $("#product-grid");
    let list = shop.products;
    if (searchQ) {
      list = list.filter((p) => p.name.toLowerCase().includes(searchQ));
      $("#search-note").textContent = `Results for "${searchQ}" — ${list.length} found`;
    }
    $("#no-products").classList.toggle("hidden", list.length > 0);
    grid.innerHTML = list
      .map((p) => {
        const img = p.image ? "/media/" + encodeURIComponent(p.image) : "/tshirt.svg";
        const inStock = p.variants.some((v) => v.stock > 0);
        return `
        <a class="product-card" href="/shop?p=${p.id}">
          <div class="ph"><img src="${img}" alt="${esc(p.name)}" loading="lazy" /></div>
          <div class="info">
            <div class="nm">${esc(p.name)}</div>
            <div class="pr">${money(p.price)}</div>
            ${inStock ? "" : '<div class="soldout-note">SOLD OUT</div>'}
          </div>
        </a>`;
      })
      .join("");
  }

  function openDetail(p) {
    product = p;
    qty.clear();
    $("#list-view").classList.add("hidden");
    $("#detail-view").classList.remove("hidden");

    $("#product-photo").src = p.image ? "/media/" + encodeURIComponent(p.image) : "/tshirt.svg";
    $("#product-name").textContent = p.name;
    $("#product-price").textContent = money(p.price);
    $("#product-desc").textContent = p.description;
    document.title = `${p.name} — WAVE3 Collective`;

    const rowsEl = $("#size-rows");
    rowsEl.innerHTML = "";
    for (const v of p.variants) {
      const row = document.createElement("div");
      row.className = "size-row" + (v.stock <= 0 ? " soldout" : "");
      row.dataset.vid = v.id;
      const meta = [v.length_in && `L ${v.length_in}"`, v.width_in && `W ${v.width_in}"`, v.sleeves_in && `SL ${v.sleeves_in}"`]
        .filter(Boolean)
        .join(" · ");
      row.innerHTML = `
        <span class="size-label">${esc(v.size)}</span>
        <span class="size-meta">${meta}</span>
        ${stockNote(v.stock)}
        <span class="qty-stepper">
          <button type="button" class="dec" aria-label="Decrease ${esc(v.size)} quantity" ${v.stock <= 0 ? "disabled" : ""}>−</button>
          <span class="qty" data-qty="${v.id}">0</span>
          <button type="button" class="inc" aria-label="Increase ${esc(v.size)} quantity" ${v.stock <= 0 ? "disabled" : ""}>+</button>
        </span>`;
      row.querySelector(".inc").addEventListener("click", () => bump(v, 1));
      row.querySelector(".dec").addEventListener("click", () => bump(v, -1));
      rowsEl.appendChild(row);
    }

    const hasChart = p.variants.some((v) => v.length_in || v.width_in || v.sleeves_in);
    document.querySelector("details.size-chart").style.display = hasChart ? "" : "none";
    $("#size-chart-table tbody").innerHTML = p.variants
      .map(
        (v) =>
          `<tr><td><strong>${esc(v.size)}</strong></td><td>${v.length_in ?? "—"}"</td><td>${v.width_in ?? "—"}"</td><td>${v.sleeves_in ?? "—"}"</td></tr>`
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
    for (const [vid, q] of qty) if (q > 0) out.push({ v: vid, q });
    return out;
  }

  function updateSummary() {
    let count = 0;
    let total = 0;
    for (const [, q] of qty) {
      if (q <= 0) continue;
      count += q;
      total += q * product.price;
    }
    $("#sum-items").textContent = count
      ? `${count} pc${count > 1 ? "s" : ""} — ${money(total)}`
      : "None selected";
    const fee = shop.settings.shipping_fee;
    $("#sum-shipping").textContent = fee > 0 ? money(fee) : "To be confirmed";
  }

  function addSelectionToCart() {
    const items = selectedItems();
    if (items.length === 0) {
      toast("Pick a size and quantity first.", true);
      return false;
    }
    for (const it of items) W3.cart.add(it.v, it.q);
    qty.clear();
    document.querySelectorAll(".size-row .qty").forEach((el) => (el.textContent = "0"));
    document.querySelectorAll(".size-row").forEach((el) => el.classList.remove("selected"));
    updateSummary();
    return true;
  }

  $("#add-cart-btn").addEventListener("click", () => {
    if (addSelectionToCart()) toast("Added to cart ✓");
  });
  $("#buy-now-btn").addEventListener("click", () => {
    if (addSelectionToCart()) window.location.href = "/cart";
  });

  W3.data
    .then((data) => {
      shop = data;
      const p = openId ? shop.products.find((x) => x.id === openId) : null;
      if (p) openDetail(p);
      else renderGrid();
    })
    .catch(() => toast("Could not load the shop. Refresh the page.", true));
})();
