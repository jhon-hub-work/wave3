/* Cart page: review items, edit quantities, checkout (multi-item order). */
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

  const money = (n) => W3.money(n);
  const esc = W3.esc;
  let shop = null;
  let lines = []; // resolved cart lines: {variant, product, q}

  function resolveCart() {
    const raw = W3.cart.get();
    const vmap = new Map();
    for (const p of shop.products) for (const v of p.variants) vmap.set(v.id, { v, p });
    const resolved = [];
    let dropped = 0;
    let clamped = 0;
    for (const item of raw) {
      const hit = vmap.get(item.v);
      if (!hit || hit.v.stock <= 0) {
        dropped++;
        continue;
      }
      let q = item.q;
      if (q > hit.v.stock) {
        q = hit.v.stock;
        clamped++;
      }
      resolved.push({ variant: hit.v, product: hit.p, q });
    }
    // write back the cleaned cart so the badge stays honest
    W3.cart.set(resolved.map((l) => ({ v: l.variant.id, q: l.q })));
    const notes = [];
    if (dropped) notes.push(`${dropped} item${dropped > 1 ? "s" : ""} removed (no longer available)`);
    if (clamped) notes.push("some quantities reduced to available stock");
    $("#cart-note").textContent = notes.join(" · ");
    return resolved;
  }

  function render() {
    lines = resolveCart();
    const empty = lines.length === 0;
    $("#empty-cart").classList.toggle("hidden", !empty);
    $("#cart-grid").classList.toggle("hidden", empty);
    if (empty) return;

    $("#cart-lines").innerHTML = lines
      .map((l, i) => {
        const img = l.product.image ? "/media/" + encodeURIComponent(l.product.image) : "/tshirt.svg";
        return `
        <div class="cart-line" data-i="${i}">
          <div class="ph"><img src="${img}" alt="" /></div>
          <div>
            <div class="line-name">${esc(l.product.name)} — ${esc(l.variant.size)}</div>
            <div class="line-meta">${money(l.product.price)} each · ${l.variant.stock} in stock</div>
            <button type="button" class="line-remove">Remove</button>
          </div>
          <span class="qty-stepper line-right">
            <button type="button" class="dec" aria-label="Decrease quantity">−</button>
            <span class="qty">${l.q}</span>
            <button type="button" class="inc" aria-label="Increase quantity">+</button>
          </span>
          <strong class="line-right">${money(l.product.price * l.q)}</strong>
        </div>`;
      })
      .join("");

    document.querySelectorAll(".cart-line").forEach((row) => {
      const i = Number(row.dataset.i);
      row.querySelector(".inc").addEventListener("click", () => bump(i, 1));
      row.querySelector(".dec").addEventListener("click", () => bump(i, -1));
      row.querySelector(".line-remove").addEventListener("click", () => {
        lines.splice(i, 1);
        save();
        render();
      });
    });

    updateSummary();
  }

  function bump(i, delta) {
    const l = lines[i];
    const next = Math.max(0, Math.min(l.variant.stock, l.q + delta));
    if (next === l.q && delta > 0) return toast(`Only ${l.variant.stock} pcs left for size ${l.variant.size}.`, true);
    l.q = next;
    if (l.q === 0) lines.splice(i, 1);
    save();
    render();
  }

  function save() {
    W3.cart.set(lines.map((l) => ({ v: l.variant.id, q: l.q })));
  }

  function totals() {
    let count = 0;
    let total = 0;
    for (const l of lines) {
      count += l.q;
      total += l.q * l.product.price;
    }
    return { count, total };
  }

  function updateSummary() {
    const { count, total } = totals();
    $("#sum-items").textContent = `${count} pc${count > 1 ? "s" : ""} — ${money(total)}`;
    const fee = shop.settings.shipping_fee;
    $("#sum-shipping").textContent = fee > 0 ? money(fee) : "To be confirmed";
    $("#sum-total").textContent = money(total + (fee > 0 ? fee : 0)) + (fee > 0 ? "" : " + shipping");
  }

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
      W3.cart.set([]);
      window.location.href = `/order/${data.code}`;
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
      btn.textContent = "Place order";
      // refresh stock in case it changed under us
      shop = await fetch("/api/shop").then((r) => r.json());
      render();
    }
  }

  $("#order-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (lines.length === 0) return toast("Your cart is empty.", true);

    const name = $("#f-name").value.trim();
    const phone = $("#f-phone").value.trim();
    const address = $("#f-address").value.trim();
    if (!name || !phone || !address)
      return toast("Please fill in your name, mobile number, and address.", true);
    const customer = { name, phone, address, contact: $("#f-contact").value.trim(), notes: $("#f-notes").value.trim() };
    const items = lines.map((l) => ({ variant_id: l.variant.id, qty: l.q }));

    const fee = shop.settings.shipping_fee;
    const { total } = totals();
    $("#cf-items").innerHTML =
      lines
        .map(
          (l) =>
            `<div class="summary-line"><span class="muted">${esc(l.product.name)} — ${esc(l.variant.size)} × ${l.q}</span><span>${money(l.product.price * l.q)}</span></div>`
        )
        .join("") +
      `<div class="summary-line"><span class="muted">Shipping</span><span>${fee > 0 ? money(fee) : "To be confirmed"}</span></div>` +
      `<div class="summary-line summary-total"><span>Total</span><span>${money(total + (fee > 0 ? fee : 0))}${fee > 0 ? "" : " + shipping"}</span></div>`;
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

  $("#f-phone").addEventListener("input", () => {
    const el = $("#f-phone");
    const clean = el.value.replace(/[^0-9+\-\s()]/g, "");
    if (clean !== el.value) el.value = clean;
  });

  W3.data
    .then((data) => {
      shop = data;
      render();
    })
    .catch(() => toast("Could not load your cart. Refresh the page.", true));
})();
