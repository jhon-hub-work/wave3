(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const toastEl = $("#toast");
  let toastTimer;
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("error", isError);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 4000);
  }

  let currency = "₱";
  const money = (n) =>
    currency + (currency.length > 1 ? " " : "") + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 });

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      showLogin(true);
      throw new Error("Please log in.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function fmtWhen(sqliteUtc) {
    if (!sqliteUtc) return "—";
    const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
    return d.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  }
  function hoursAgo(sqliteUtc) {
    return (Date.now() - new Date(sqliteUtc.replace(" ", "T") + "Z").getTime()) / 36e5;
  }

  const STATUS_LABEL = {
    pending: "Awaiting payment",
    proof: "To verify",
    paid: "Paid",
    shipped: "Shipped",
    cancelled: "Cancelled",
    expired: "Expired"
  };

  const badge = (st) => `<span class="badge badge-${st}">${STATUS_LABEL[st] || st}</span>`;

  // ---------- login ----------
  function showLogin(show) {
    $("#login-screen").classList.toggle("hidden", !show);
  }

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/login", { method: "POST", body: { password: $("#login-pw").value } });
      showLogin(false);
      $("#login-pw").value = "";
      boot();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" }).catch(() => {});
    showLogin(true);
  });

  // ---------- navigation ----------
  let currentPage = "dashboard";
  $$(".nav-btn").forEach((b) =>
    b.addEventListener("click", () => {
      currentPage = b.dataset.page;
      $$(".nav-btn").forEach((x) => x.classList.toggle("active", x === b));
      ["dashboard", "orders", "inventory", "money", "settings"].forEach((p) =>
        $(`#page-${p}`).classList.toggle("hidden", p !== currentPage)
      );
      loadPage();
    })
  );

  function loadPage() {
    if (currentPage === "dashboard") loadDashboard();
    else if (currentPage === "orders") loadOrders();
    else if (currentPage === "inventory") loadInventory();
    else if (currentPage === "money") loadMoney();
    else if (currentPage === "settings") loadSettings();
  }

  // ---------- dashboard ----------
  async function loadDashboard() {
    const d = await api("/api/admin/overview");
    updateBadge(d);
    $("#dash-stats").innerHTML = `
      <div class="stat amber"><div class="lbl">To verify</div><div class="num">${d.proof}</div></div>
      <div class="stat"><div class="lbl">Awaiting payment</div><div class="num">${d.pending}</div></div>
      <div class="stat blue"><div class="lbl">Stock remaining</div><div class="num">${d.stock_total}</div></div>
      <div class="stat green"><div class="lbl">Income</div><div class="num">${money(d.income)}</div></div>
      <div class="stat red"><div class="lbl">Expenses</div><div class="num">${money(d.expense)}</div></div>
      <div class="stat ${d.profit >= 0 ? "green" : "red"}"><div class="lbl">Profit</div><div class="num">${money(d.profit)}</div></div>`;

    $("#dash-low-stock").innerHTML = d.low_stock.length
      ? `<div class="card" style="border-color:#6b511d">
           <h3 style="font-size:16px; color: var(--amber); margin-bottom: 8px;">Low stock</h3>
           ${d.low_stock
             .map(
               (v) =>
                 `<span class="badge badge-low" style="margin: 0 6px 6px 0;">${esc(v.product_name)} ${esc(v.size)} — ${v.stock} left</span>`
             )
             .join("")}
         </div>`
      : "";

    $("#dash-recent").innerHTML =
      d.recent.map((o) => orderCard(o, true)).join("") ||
      '<p class="muted">No orders yet. Share your store link to start selling!</p>';
    wireOrderActions($("#dash-recent"));
  }

  function updateBadge(overview) {
    const n = overview.proof + overview.pending;
    const el = $("#orders-badge");
    el.textContent = n;
    el.classList.toggle("hidden", n === 0);
    document.title = (overview.proof > 0 ? `(${overview.proof} to verify) ` : "") + "WAVE3 Admin";
  }

  // ---------- orders ----------
  let orderFilter = "";
  $$("#order-tabs .tab").forEach((t) =>
    t.addEventListener("click", () => {
      orderFilter = t.dataset.status;
      $$("#order-tabs .tab").forEach((x) => x.classList.toggle("active", x === t));
      loadOrders();
    })
  );

  function orderCard(o, compact = false) {
    const itemsStr = o.items
      .map((it) => `${esc(it.size)} × ${it.qty}`)
      .join(", ");
    let stale = "";
    if (o.status === "pending" && o.awaiting_quote) {
      stale = `<span class="badge badge-proof">⚠ Needs shipping quote</span>`;
    } else if (o.status === "pending" && o.expires_at) {
      const msLeft = new Date(o.expires_at.replace(" ", "T") + "Z").getTime() - Date.now();
      const hLeft = Math.max(0, msLeft / 36e5);
      stale =
        hLeft <= 6
          ? `<span class="badge badge-low">Expires in ${hLeft < 1 ? Math.ceil(hLeft * 60) + "m" : Math.floor(hLeft) + "h"}</span>`
          : `<span class="badge badge-pending">Expires in ${Math.floor(hLeft)}h</span>`;
    }
    const proof = o.proof_file
      ? `<img class="proof-thumb" src="/api/admin/proof/${encodeURIComponent(o.proof_file)}" alt="Payment proof for ${esc(o.code)}" data-proof="${encodeURIComponent(o.proof_file)}" loading="lazy" />`
      : o.status === "pending"
        ? '<span class="muted small">No proof uploaded yet</span>'
        : "";

    const actions = [];
    // shipping quote is the first step for orders that still need it
    if (o.status === "pending" && o.awaiting_quote)
      actions.push(`<button class="btn btn-primary btn-sm" data-act="fee" data-id="${o.id}" data-fee="${o.shipping_fee}">Set shipping fee &amp; start timer</button>`);
    if (o.status === "proof" || o.status === "pending")
      actions.push(`<button class="btn btn-success btn-sm" data-act="paid" data-id="${o.id}">✓ Mark as PAID</button>`);
    if (o.status === "paid")
      actions.push(`<button class="btn btn-primary btn-sm" data-act="ship" data-id="${o.id}">Mark as shipped</button>`,
                   `<button class="btn btn-ghost btn-sm" data-act="revert" data-id="${o.id}">Undo paid</button>`);
    if (o.status === "paid" || o.status === "shipped")
      actions.push(`<button class="btn btn-ghost btn-sm" data-act="track" data-id="${o.id}" data-tracking="${esc(o.tracking || "")}">${o.tracking ? "Edit tracking" : "Add tracking"}</button>`);
    if (o.status !== "cancelled" && o.status !== "shipped")
      actions.push(`<button class="btn btn-danger btn-sm" data-act="cancel" data-id="${o.id}">Cancel order</button>`);
    // once quoted, still allow editing the fee (but not shown again as the primary above)
    if ((o.status === "pending" && !o.awaiting_quote) || o.status === "proof")
      actions.push(`<button class="btn btn-ghost btn-sm" data-act="fee" data-id="${o.id}" data-fee="${o.shipping_fee}">Edit shipping fee</button>`);
    // permanent delete (removes the record entirely) — available on any order
    actions.push(`<button class="btn btn-ghost btn-sm" data-act="delete" data-id="${o.id}" style="opacity:.65">🗑 Delete</button>`);

    return `
      <div class="order-card">
        <div class="head">
          <span class="code">${esc(o.code)}</span>
          ${badge(o.status)}
          ${stale}
          <span class="when">${fmtWhen(o.created_at)}</span>
        </div>
        <div class="order-body">
          <div>
            <strong>${esc(o.customer_name)}</strong> · <a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>
            ${o.contact ? `<span class="muted small"> · ${esc(o.contact)}</span>` : ""}
            <div class="muted small">${esc(o.address)}</div>
            ${o.notes ? `<div class="muted small">📝 ${esc(o.notes)}</div>` : ""}
            <div class="mt-1">
              <strong>${itemsStr}</strong>
              <span class="muted small"> · items ${money(o.items_total)} + shipping ${o.shipping_fee > 0 ? money(o.shipping_fee) : "TBC"} = </span>
              <strong style="color: var(--blue-bright)">${money(o.total)}</strong>
            </div>
            <div class="mt-1">${proof}</div>
            ${o.tracking ? `<div class="small mt-1">📦 Tracking: <strong>${esc(o.tracking)}</strong></div>` : ""}
            <div class="muted small mt-1">Customer link: <a href="/order/${esc(o.code)}" target="_blank" rel="noopener">/order/${esc(o.code)}</a></div>
          </div>
          ${compact ? "" : `<div class="order-actions">${actions.join("")}</div>`}
          ${compact && actions.length ? `<div class="order-actions">${actions.slice(0, 1).join("")}</div>` : ""}
        </div>
      </div>`;
  }

  async function loadOrders() {
    const d = await api(`/api/admin/orders${orderFilter ? `?status=${orderFilter}` : ""}`);
    $("#orders-list").innerHTML =
      d.orders.map((o) => orderCard(o)).join("") ||
      '<p class="muted mt-3">Nothing here yet.</p>';
    wireOrderActions($("#orders-list"));
  }

  function wireOrderActions(root) {
    root.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.dataset.id;
        const act = b.dataset.act;
        try {
          if (act === "fee") {
            const raw = prompt("Shipping fee for this order (in " + currency + "). Numbers only — enter 0 for free shipping:", b.dataset.fee || "125");
            if (raw === null) return;
            const cleaned = raw.trim();
            if (!/^\d+(\.\d{1,2})?$/.test(cleaned))
              return toast("Please enter a number only, e.g. 125.", true);
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "shipping", shipping_fee: Number(cleaned) } });
            toast("Total confirmed — the customer can now see it and pay. Their payment countdown has started. 💙");
          } else if (act === "cancel") {
            if (!confirm("Cancel this order and return its items to stock?")) return;
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "cancel" } });
            toast("Order cancelled — stock released.");
          } else if (act === "delete") {
            if (!confirm("Permanently DELETE this order and its records? This cannot be undone. (If it was still active, its items return to stock.)")) return;
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "delete" } });
            toast("Order deleted.");
          } else if (act === "track") {
            const t = prompt("Tracking number or tracking link (leave empty to remove):", b.dataset.tracking || "");
            if (t === null) return;
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "tracking", tracking: t } });
            toast(t.trim() ? "Tracking saved — the customer can now see it on their order page." : "Tracking removed.");
          } else if (act === "paid") {
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "paid" } });
            toast("Marked as PAID — income logged & receipt is live for the customer. 💙");
          } else if (act === "ship") {
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "ship" } });
            toast("Marked as shipped.");
          } else if (act === "revert") {
            if (!confirm("Undo the paid status? The logged income for this order will be removed.")) return;
            await api(`/api/admin/orders/${id}/action`, { method: "POST", body: { action: "revert" } });
            toast("Reverted to 'To verify'.");
          }
          loadPage();
        } catch (err) {
          toast(err.message, true);
        }
      })
    );
    root.querySelectorAll("[data-proof]").forEach((img) =>
      img.addEventListener("click", () => {
        const bd = document.createElement("div");
        bd.className = "modal-backdrop";
        bd.innerHTML = `<img src="/api/admin/proof/${img.dataset.proof}" alt="Payment proof full view" />`;
        bd.addEventListener("click", () => bd.remove());
        document.body.appendChild(bd);
      })
    );
  }

  // ---------- inventory ----------
  async function loadInventory() {
    const d = await api("/api/admin/inventory");
    $("#inventory-list").innerHTML = d.products
      .map(
        (p) => `
      <div class="card mb-2" data-pid="${p.id}">
        <div class="spread" style="flex-wrap:wrap;">
          <div style="flex:1; min-width: 240px;">
            <input type="text" class="p-name" value="${esc(p.name)}" style="width:100%; font-weight:700;" aria-label="Product name" />
            <textarea class="p-desc mt-1" style="min-height:60px; font-size: 13px;" aria-label="Product description">${esc(p.description)}</textarea>
          </div>
          <div style="min-width: 150px;">
            <label class="field-label">Price</label>
            <input type="number" class="p-price" value="${p.price}" min="0" step="1" />
            <label class="flex mt-1 small" style="cursor:pointer;"><input type="checkbox" class="p-active" ${p.active ? "checked" : ""} style="width:auto;" /> Visible in store</label>
          </div>
        </div>
        <table class="w3 inv-table mt-2">
          <thead><tr><th>Size</th><th>Stock</th><th>Length"</th><th>Width"</th><th>Sleeves"</th><th></th></tr></thead>
          <tbody>
            ${p.variants
              .map(
                (v) => `
              <tr data-vid="${v.id}">
                <td><input type="text" class="v-size" value="${esc(v.size)}" aria-label="Size name" /></td>
                <td><input type="number" class="v-stock" value="${v.stock}" min="0" step="1" aria-label="Stock" ${v.stock <= 3 ? 'style="border-color:#6b511d"' : ""} /></td>
                <td><input type="number" class="v-len" value="${v.length_in ?? ""}" step="0.5" aria-label="Length" /></td>
                <td><input type="number" class="v-wid" value="${v.width_in ?? ""}" step="0.5" aria-label="Width" /></td>
                <td><input type="number" class="v-slv" value="${v.sleeves_in ?? ""}" step="0.5" aria-label="Sleeves" /></td>
                <td><button class="btn btn-danger btn-sm v-del" aria-label="Delete size ${esc(v.size)}">✕</button></td>
              </tr>`
              )
              .join("")}
          </tbody>
        </table>
        <div class="flex mt-2" style="flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm p-add-size">+ Add size</button>
          <button class="btn btn-primary btn-sm p-save">Save product</button>
          ${p.image ? `<img src="/media/${esc(p.image)}" alt="Product photo" style="width:44px;height:44px;object-fit:cover;border-radius:8px;border:1px solid var(--border-strong);" />
            <button class="btn btn-danger btn-sm p-photo-remove">Remove photo</button>` : ""}
          <label class="btn btn-ghost btn-sm" style="cursor:pointer;">${p.image ? "Replace" : "+ Upload"} product photo<input type="file" class="p-photo-file hidden" accept="image/png,image/jpeg,image/webp" /></label>
          <button class="btn btn-danger btn-sm p-delete" style="margin-left:auto;">🗑 Delete product</button>
        </div>
      </div>`
      )
      .join("");

    // wire
    $$("#inventory-list [data-pid]").forEach((card) => {
      const pid = Number(card.dataset.pid);
      card.querySelector(".p-save").addEventListener("click", async () => {
        try {
          await api("/api/admin/products", {
            method: "POST",
            body: {
              id: pid,
              name: card.querySelector(".p-name").value,
              description: card.querySelector(".p-desc").value,
              price: Number(card.querySelector(".p-price").value),
              active: card.querySelector(".p-active").checked
            }
          });
          for (const row of card.querySelectorAll("tr[data-vid]")) {
            await api("/api/admin/variants", {
              method: "POST",
              body: {
                id: Number(row.dataset.vid),
                size: row.querySelector(".v-size").value,
                stock: Number(row.querySelector(".v-stock").value),
                length_in: row.querySelector(".v-len").value,
                width_in: row.querySelector(".v-wid").value,
                sleeves_in: row.querySelector(".v-slv").value
              }
            });
          }
          toast("Product saved.");
          loadInventory();
        } catch (err) {
          toast(err.message, true);
        }
      });
      const photoFile = card.querySelector(".p-photo-file");
      photoFile.addEventListener("change", () => {
        const file = photoFile.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) return toast("Image too large (max 8 MB).", true);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            await api(`/api/admin/products/${pid}/photo`, { method: "POST", body: { image: reader.result } });
            toast("Product photo updated — it's live on the store.");
            loadInventory();
          } catch (err) {
            toast(err.message, true);
          }
        };
        reader.readAsDataURL(file);
      });
      const photoRemove = card.querySelector(".p-photo-remove");
      if (photoRemove)
        photoRemove.addEventListener("click", async () => {
          if (!confirm("Remove this product's photo?")) return;
          await api(`/api/admin/products/${pid}/photo`, { method: "POST", body: { image: "" } });
          loadInventory();
        });
      card.querySelector(".p-delete").addEventListener("click", async () => {
        const name = card.querySelector(".p-name").value;
        if (!confirm(`Delete "${name}" completely? Its sizes and photo will be removed too. This cannot be undone.`)) return;
        try {
          await api(`/api/admin/products/${pid}`, { method: "DELETE" });
          toast("Product deleted.");
          loadInventory();
        } catch (err) {
          toast(err.message, true);
        }
      });
      card.querySelector(".p-add-size").addEventListener("click", async () => {
        const size = prompt("New size name (e.g. 2XL):");
        if (!size) return;
        try {
          await api("/api/admin/variants", { method: "POST", body: { product_id: pid, size, stock: 0 } });
          loadInventory();
        } catch (err) {
          toast(err.message, true);
        }
      });
      card.querySelectorAll(".v-del").forEach((b) =>
        b.addEventListener("click", async () => {
          const row = b.closest("tr");
          if (!confirm("Delete this size?")) return;
          try {
            await api(`/api/admin/variants/${row.dataset.vid}`, { method: "DELETE" });
            loadInventory();
          } catch (err) {
            toast(err.message, true);
          }
        })
      );
    });
  }

  $("#add-product-btn").addEventListener("click", async () => {
    const name = prompt("Product name:");
    if (!name) return;
    const price = Number(prompt("Price:", "999"));
    try {
      await api("/api/admin/products", { method: "POST", body: { name, price: Number.isFinite(price) ? price : 0, description: "" } });
      toast("Product added — now add its sizes and stock.");
      loadInventory();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- manual orders ----------
  const moModal = $("#manual-modal");

  async function openManualModal() {
    const d = await api("/api/admin/inventory");
    $("#mo-items").innerHTML = d.products
      .filter((p) => p.variants.length)
      .map(
        (p) => `
        <div style="border:1px solid var(--border); border-radius:10px; padding:10px 12px; margin-bottom:8px;">
          <strong class="small">${esc(p.name)} — ${money(p.price)}</strong>
          <div class="flex mt-1" style="flex-wrap:wrap;">
            ${p.variants
              .map(
                (v) => `
              <label class="small" style="display:flex; flex-direction:column; align-items:center; gap:2px;">
                <span class="muted">${esc(v.size)}</span>
                <input type="number" class="mo-qty" data-vid="${v.id}" value="0" min="0" max="99" style="width:58px; padding:6px 8px; text-align:center;" />
              </label>`
              )
              .join("")}
          </div>
        </div>`
      )
      .join("");
    $("#mo-name").value = "";
    $("#mo-phone").value = "";
    $("#mo-address").value = "";
    $("#mo-fee").value = "0";
    $("#mo-date").value = new Date().toISOString().slice(0, 10);
    $("#mo-paid").checked = true;
    $("#mo-deduct").checked = true;
    moModal.classList.remove("hidden");
  }

  $("#manual-order-btn").addEventListener("click", () => openManualModal().catch((e) => toast(e.message, true)));
  $("#mo-close").addEventListener("click", () => moModal.classList.add("hidden"));
  $("#mo-paid").addEventListener("change", () => {
    // unpaid manual orders always reserve stock, like normal orders
    $("#mo-deduct-row").style.display = $("#mo-paid").checked ? "" : "none";
  });

  $("#mo-save").addEventListener("click", async () => {
    const items = $$(".mo-qty")
      .map((el) => ({ variant_id: Number(el.dataset.vid), qty: Number(el.value) }))
      .filter((it) => it.qty > 0);
    if (!$("#mo-name").value.trim()) return toast("Customer name is required.", true);
    if (items.length === 0) return toast("Set a quantity for at least one size.", true);
    const btn = $("#mo-save");
    btn.disabled = true;
    try {
      const r = await api("/api/admin/manual-order", {
        method: "POST",
        body: {
          customer: {
            name: $("#mo-name").value,
            phone: $("#mo-phone").value,
            address: $("#mo-address").value
          },
          items,
          shipping_fee: Number($("#mo-fee").value),
          date: $("#mo-date").value,
          paid: $("#mo-paid").checked,
          deduct_stock: $("#mo-deduct").checked
        }
      });
      moModal.classList.add("hidden");
      toast(`Order ${r.code} added${$("#mo-paid").checked ? " and marked paid — income logged." : "."}`);
      loadPage();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- report ----------
  async function runReport() {
    const from = $("#rep-from").value;
    const to = $("#rep-to").value;
    const d = await api(`/api/admin/report?from=${from}&to=${to}`);
    const soldRows = d.sold
      .map(
        (s) =>
          `<tr><td>${esc(s.product_name)}</td><td>${esc(s.size)}</td><td style="text-align:right">${s.qty}</td><td style="text-align:right">${money(s.amount)}</td></tr>`
      )
      .join("");
    const catRows = d.by_category
      .map(
        (c) =>
          `<tr><td><span class="badge ${c.type === "income" ? "badge-paid" : "badge-cancelled"}">${esc(c.category)}</span></td><td class="muted small">${c.n} entr${c.n > 1 ? "ies" : "y"}</td><td style="text-align:right" class="${c.type === "income" ? "money-pos" : "money-neg"}">${c.type === "income" ? "+" : "−"}${money(c.total)}</td></tr>`
      )
      .join("");
    $("#rep-out").innerHTML = `
      <div class="stat-grid">
        <div class="stat green"><div class="lbl">Gross sales</div><div class="num">${money(d.gross_sales)}</div></div>
        <div class="stat red"><div class="lbl">Expenses</div><div class="num">${money(d.expenses)}</div></div>
        <div class="stat ${d.profit >= 0 ? "green" : "red"}"><div class="lbl">Profit</div><div class="num">${money(d.profit)}</div></div>
        <div class="stat blue"><div class="lbl">Orders paid</div><div class="num">${d.orders_paid}</div></div>
        <div class="stat blue"><div class="lbl">Items sold</div><div class="num">${d.items_sold}</div></div>
      </div>
      ${soldRows ? `<h4 class="mt-2 small" style="text-transform:uppercase; letter-spacing:0.1em; color:var(--muted);">Items sold</h4>
      <table class="w3"><thead><tr><th>Product</th><th>Size</th><th style="text-align:right">Qty</th><th style="text-align:right">Amount</th></tr></thead><tbody>${soldRows}</tbody></table>` : '<p class="muted small mt-2">No paid orders in this range.</p>'}
      ${catRows ? `<h4 class="mt-2 small" style="text-transform:uppercase; letter-spacing:0.1em; color:var(--muted);">By category</h4>
      <table class="w3"><tbody>${catRows}</tbody></table>` : ""}`;
  }

  $("#rep-run").addEventListener("click", () => runReport().catch((e) => toast(e.message, true)));

  // ---------- money ----------
  async function loadMoney() {
    if (!$("#rep-from").value) {
      const today = new Date().toISOString().slice(0, 10);
      $("#rep-from").value = today.slice(0, 8) + "01";
      $("#rep-to").value = today;
    }
    runReport().catch(() => {});
    const d = await api("/api/admin/transactions");
    $("#money-stats").innerHTML = `
      <div class="stat green"><div class="lbl">Merch Sales</div><div class="num">${money(d.merch_sales)}</div></div>
      <div class="stat blue"><div class="lbl">Shipping Fee Collected</div><div class="num">${money(d.shipping_collected)}</div></div>
      <div class="stat red"><div class="lbl">Total Expenses</div><div class="num">${money(d.expense)}</div></div>
      <div class="stat ${d.profit >= 0 ? "green" : "red"}"><div class="lbl">Net Profit</div><div class="num">${money(d.profit)}</div></div>`;
    $("#tx-table tbody").innerHTML =
      d.transactions
        .map(
          (t) => `
        <tr>
          <td class="muted small" style="white-space:nowrap">${esc(t.tx_date)}</td>
          <td><span class="badge ${t.type === "income" ? "badge-paid" : "badge-cancelled"}">${esc(t.category)}</span></td>
          <td>${esc(t.description)}</td>
          <td style="text-align:right" class="${t.type === "income" ? "money-pos" : "money-neg"}">${t.type === "income" ? "+" : "−"}${money(t.amount)}</td>
          <td style="text-align:right"><button class="btn btn-danger btn-sm tx-del" data-id="${t.id}" aria-label="Delete transaction">✕</button></td>
        </tr>`
        )
        .join("") || '<tr><td colspan="5" class="muted">No transactions yet.</td></tr>';
    $$(".tx-del").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Delete this transaction?")) return;
        await api(`/api/admin/transactions/${b.dataset.id}`, { method: "DELETE" });
        loadMoney();
      })
    );
  }

  $("#tx-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/admin/transactions", {
        method: "POST",
        body: {
          type: $("#tx-type").value,
          category: $("#tx-cat").value,
          description: $("#tx-desc").value,
          amount: Number($("#tx-amount").value)
        }
      });
      $("#tx-desc").value = "";
      $("#tx-amount").value = "";
      toast("Transaction added.");
      loadMoney();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- settings ----------
  let channelsDraft = [];

  function renderChannels() {
    $("#channels-edit").innerHTML = channelsDraft
      .map(
        (c, i) => `
      <div class="channel-edit" data-i="${i}">
        <div class="spread mb-2">
          <input type="text" class="ch-label" value="${esc(c.label)}" placeholder="Channel name (e.g. GCash)" style="max-width: 320px; font-weight: 700;" />
          <button class="btn btn-danger btn-sm ch-del">Remove</button>
        </div>
        <textarea class="ch-lines" placeholder="One detail per line, e.g.&#10;Number: 09XX XXX XXXX&#10;Account Name: JUAN D. CRUZ">${esc((c.lines || []).join("\n"))}</textarea>
        <div class="flex mt-1" style="flex-wrap:wrap;">
          ${
            c.qr_data
              ? `<img src="${c.qr_data}" alt="QR preview" style="width:72px; height:72px; object-fit:contain; background:#fff; border-radius:8px; padding:4px;" />
                 <span class="badge badge-proof">NOT SAVED YET — click "Save all settings" below</span>
                 <button type="button" class="btn btn-danger btn-sm ch-qr-remove">Remove QR</button>`
              : c.qr
                ? `<img src="/qr/${encodeURIComponent(c.qr)}" alt="QR preview" style="width:72px; height:72px; object-fit:contain; background:#fff; border-radius:8px; padding:4px;" />
                   <span class="badge badge-paid">QR live on payment page</span>
                   <button type="button" class="btn btn-danger btn-sm ch-qr-remove">Remove QR</button>`
                : `<label class="btn btn-ghost btn-sm" style="cursor:pointer;">+ Upload QR code<input type="file" class="ch-qr-file hidden" accept="image/png,image/jpeg,image/webp" /></label>`
          }
        </div>
      </div>`
      )
      .join("");
    $$("#channels-edit .ch-del").forEach((b) =>
      b.addEventListener("click", () => {
        collectChannels();
        channelsDraft.splice(Number(b.closest(".channel-edit").dataset.i), 1);
        renderChannels();
      })
    );
    $$("#channels-edit .ch-qr-remove").forEach((b) =>
      b.addEventListener("click", () => {
        collectChannels();
        const i = Number(b.closest(".channel-edit").dataset.i);
        channelsDraft[i].qr = null;
        channelsDraft[i].qr_data = undefined;
        renderChannels();
      })
    );
    $$("#channels-edit .ch-qr-file").forEach((inp) =>
      inp.addEventListener("change", () => {
        const file = inp.files[0];
        if (!file) return;
        if (file.size > 5 * 1024 * 1024) return toast("QR image too large (max 5 MB).", true);
        const i = Number(inp.closest(".channel-edit").dataset.i);
        const reader = new FileReader();
        reader.onload = () => {
          collectChannels();
          channelsDraft[i].qr_data = reader.result;
          channelsDraft[i].qr = null;
          renderChannels();
          toast("QR attached — click \"Save all settings\" to publish it.");
        };
        reader.readAsDataURL(file);
      })
    );
  }

  // ---------- contact channels ----------
  let contactsDraft = [];

  function renderContacts() {
    $("#contacts-edit").innerHTML = contactsDraft
      .map(
        (c, i) => `
      <div class="channel-edit" data-i="${i}">
        <div class="flex" style="flex-wrap:wrap;">
          <input type="text" class="co-label" value="${esc(c.label)}" placeholder="Name (e.g. Messenger)" style="max-width: 200px; font-weight: 700;" />
          <input type="text" class="co-url" value="${esc(c.url)}" placeholder="Link (e.g. m.me/wave3collective)" style="flex:1; min-width: 220px;" />
          <button class="btn btn-danger btn-sm co-del">Remove</button>
        </div>
      </div>`
      )
      .join("") || '<p class="muted small">No contacts yet — add Messenger, Telegram, Instagram, or any link customers can reach you on.</p>';
    $$("#contacts-edit .co-del").forEach((b) =>
      b.addEventListener("click", () => {
        collectContacts();
        contactsDraft.splice(Number(b.closest(".channel-edit").dataset.i), 1);
        renderContacts();
      })
    );
  }

  function collectContacts() {
    $$("#contacts-edit .channel-edit").forEach((el) => {
      const i = Number(el.dataset.i);
      if (contactsDraft[i]) {
        contactsDraft[i].label = el.querySelector(".co-label").value;
        contactsDraft[i].url = el.querySelector(".co-url").value;
      }
    });
  }

  $("#add-contact-btn").addEventListener("click", () => {
    collectContacts();
    contactsDraft.push({ label: "", url: "" });
    renderContacts();
  });

  function collectChannels() {
    $$("#channels-edit .channel-edit").forEach((el) => {
      const i = Number(el.dataset.i);
      if (channelsDraft[i]) {
        channelsDraft[i].label = el.querySelector(".ch-label").value;
        channelsDraft[i].lines = el.querySelector(".ch-lines").value.split("\n").map((l) => l.trim()).filter(Boolean);
      }
    });
  }

  $("#add-channel-btn").addEventListener("click", () => {
    collectChannels();
    channelsDraft.push({ label: "", kind: "other", lines: [] });
    renderChannels();
  });

  // ---------- rich text editor (story + photo stories) ----------
  function makeRichEditor(mountId) {
    const mount = document.getElementById(mountId);
    mount.innerHTML = `
      <div class="rt-toolbar">
        <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
        <select class="rt-size" title="Text size">
          <option value="">Size</option>
          <option value="2">Small</option>
          <option value="3">Normal</option>
          <option value="5">Large</option>
          <option value="6">Heading</option>
        </select>
        <input type="color" class="rt-color" value="#000F93" title="Text color" />
        <button type="button" data-cmd="insertUnorderedList" title="Bullet list">• List</button>
        <button type="button" class="rt-link" title="Insert link">Link</button>
        <label class="rt-img" title="Insert picture">Picture<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" class="hidden rt-img-file" /></label>
        <button type="button" data-cmd="removeFormat" title="Clear formatting">Clear</button>
      </div>
      <div class="rt-editor" contenteditable="true" data-placeholder="Write here…"></div>`;
    const ed = mount.querySelector(".rt-editor");
    ed.style.minHeight = (Number(mount.dataset.min) || 140) + "px";
    const exec = (cmd, val) => { ed.focus(); document.execCommand(cmd, false, val); };
    // keep the text selection alive when clicking toolbar buttons
    mount.querySelector(".rt-toolbar").addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) e.preventDefault();
    });
    mount.querySelectorAll("[data-cmd]").forEach((b) => b.addEventListener("click", () => exec(b.dataset.cmd)));
    mount.querySelector(".rt-size").addEventListener("change", (e) => {
      if (e.target.value) exec("fontSize", e.target.value);
      e.target.value = "";
    });
    mount.querySelector(".rt-color").addEventListener("input", (e) => exec("foreColor", e.target.value));
    mount.querySelector(".rt-link").addEventListener("click", () => {
      const url = prompt("Link URL (https://...):");
      if (url) exec("createLink", /^https?:/i.test(url) ? url : "https://" + url);
    });
    const file = mount.querySelector(".rt-img-file");
    file.addEventListener("change", () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) return toast("Image too large (max 8 MB).", true);
      const r = new FileReader();
      r.onload = async () => {
        try {
          const res = await api("/api/admin/media", { method: "POST", body: { image: r.result } });
          exec("insertImage", "/media/" + res.id);
        } catch (err) {
          toast(err.message, true);
        }
        file.value = "";
      };
      r.readAsDataURL(f);
    });
    return {
      get: () => {
        const html = ed.innerHTML.trim();
        return html === "<br>" || html === "<div><br></div>" ? "" : html;
      },
      set: (html) => { ed.innerHTML = html || ""; }
    };
  }
  const editors = {
    story: makeRichEditor("s-story"),
    mv1: makeRichEditor("s-mv1"),
    mv2: makeRichEditor("s-mv2"),
    mv3: makeRichEditor("s-mv3"),
    mv4: makeRichEditor("s-mv4")
  };
  // legacy plain-text content -> simple HTML
  function plainToHtml(text) {
    if (!text || /</.test(text)) return text || "";
    return text.split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  }

  // homepage drafts
  let heroDraft; // undefined = untouched, "" = reset to default, dataURL = new upload
  let featuredDraft = [];
  let soonDraft = [];

  function renderFeatured() {
    $("#featured-edit").innerHTML = featuredDraft
      .map(
        (p, i) => `
      <div class="flex mb-2" data-i="${i}" style="flex-wrap:wrap;">
        <label class="flex small" style="cursor:pointer; min-width:220px; flex:1;">
          <input type="checkbox" class="ft-show" ${p.featured ? "checked" : ""} style="width:auto;" />
          <strong>${esc(p.name)}</strong>
        </label>
        <input type="text" class="ft-badge" value="${esc(p.badge || "")}" placeholder="Badge (e.g. Limited Drop)" maxlength="40" style="width:220px;" />
      </div>`
      )
      .join("") || '<p class="muted small">No products yet — add one in Inventory.</p>';
  }
  function collectFeatured() {
    $$("#featured-edit [data-i]").forEach((el) => {
      const p = featuredDraft[Number(el.dataset.i)];
      p.featured = el.querySelector(".ft-show").checked;
      p.badge = el.querySelector(".ft-badge").value;
    });
  }

  function renderSoon() {
    $("#soon-edit").innerHTML = soonDraft
      .map(
        (name, i) => `
      <div class="flex mb-2" data-i="${i}">
        <input type="text" class="soon-name" value="${esc(name)}" placeholder="e.g. Wave 3 Hoodie" maxlength="60" style="flex:1;" />
        <button class="btn btn-danger btn-sm soon-del">✕</button>
      </div>`
      )
      .join("") || '<p class="muted small">No coming-soon cards — the homepage shows only real products.</p>';
    $$("#soon-edit .soon-del").forEach((b) =>
      b.addEventListener("click", () => {
        collectSoon();
        soonDraft.splice(Number(b.closest("[data-i]").dataset.i), 1);
        renderSoon();
      })
    );
  }
  function collectSoon() {
    soonDraft = $$("#soon-edit .soon-name").map((el) => el.value.trim()).filter(Boolean);
  }
  $("#add-soon-btn").addEventListener("click", () => {
    collectSoon();
    soonDraft.push("");
    renderSoon();
  });

  $("#hero-file").addEventListener("change", () => {
    const file = $("#hero-file").files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) return toast("Image too large (max 8 MB).", true);
    const reader = new FileReader();
    reader.onload = () => {
      heroDraft = reader.result;
      $("#hero-preview").src = heroDraft;
      $("#hero-pending").classList.remove("hidden");
    };
    reader.readAsDataURL(file);
  });
  $("#hero-reset").addEventListener("click", () => {
    heroDraft = "";
    $("#hero-preview").src = "/hero.png";
    $("#hero-pending").classList.remove("hidden");
  });

  async function loadSettings() {
    const d = await api("/api/admin/settings");
    $("#s-currency").value = d.settings.currency || "₱";
    $("#s-name").value = d.settings.business_name;
    $("#s-tagline").value = d.settings.tagline;
    $("#s-shipping").value = d.settings.shipping_fee;
    $("#s-window").value = d.settings.payment_window_hours;
    $("#s-note").value = d.settings.payment_note;
    $("#s-discord").value = d.settings.discord || "";
    editors.story.set(d.settings.story_html || plainToHtml(d.settings.story));
    const mv = d.settings.movement || [];
    for (const i of [1, 2, 3, 4]) editors["mv" + i].set(plainToHtml(mv[i - 1] || ""));
    channelsDraft = d.payment_channels;
    renderChannels();
    contactsDraft = d.contact_channels || [];
    renderContacts();
    heroDraft = undefined;
    $("#hero-pending").classList.add("hidden");
    $("#hero-preview").src = d.settings.hero ? "/media/" + encodeURIComponent(d.settings.hero) : "/hero.png";
    $("#hero-reset").classList.toggle("hidden", !d.settings.hero);
    featuredDraft = d.products || [];
    renderFeatured();
    soonDraft = d.settings.coming_soon || [];
    renderSoon();
  }

  // per-section saves — each button posts ONLY its own section's fields
  async function saveSection(btn, body, after) {
    try {
      btn.disabled = true;
      await api("/api/admin/settings", { method: "POST", body });
      toast("Saved.");
      if (after) after();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  $("#save-store-btn").addEventListener("click", (e) =>
    saveSection(e.target, {
      business_name: $("#s-name").value,
      currency: $("#s-currency").value,
      tagline: $("#s-tagline").value,
      shipping_fee: Number($("#s-shipping").value),
      payment_window_hours: Number($("#s-window").value)
    })
  );

  $("#save-home-btn").addEventListener("click", (e) => {
    collectFeatured();
    collectSoon();
    saveSection(e.target, {
      ...(heroDraft !== undefined ? { hero_data: heroDraft } : {}),
      featured: featuredDraft.map((p) => ({ id: p.id, featured: p.featured, badge: p.badge })),
      coming_soon: soonDraft,
      movement_story_1: editors.mv1.get(),
      movement_story_2: editors.mv2.get(),
      movement_story_3: editors.mv3.get(),
      movement_story_4: editors.mv4.get()
    }, () => {
      heroDraft = undefined;
      $("#hero-pending").classList.add("hidden");
    });
  });

  $("#save-pages-btn").addEventListener("click", (e) =>
    saveSection(e.target, {
      story_html: editors.story.get(),
      discord_url: $("#s-discord").value
    })
  );

  $("#save-pay-btn").addEventListener("click", (e) => {
    collectChannels();
    saveSection(e.target, {
      payment_channels: channelsDraft,
      payment_note: $("#s-note").value
    }, () => loadSettings()); // refresh so new QR files show their saved state
  });

  $("#save-contacts-btn").addEventListener("click", (e) => {
    collectContacts();
    saveSection(e.target, { contact_channels: contactsDraft });
  });

  $("#change-pw-btn").addEventListener("click", async () => {
    try {
      await api("/api/admin/password", {
        method: "POST",
        body: { current: $("#pw-current").value, next: $("#pw-next").value }
      });
      $("#pw-current").value = "";
      $("#pw-next").value = "";
      toast("Password changed.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- boot & polling ----------
  async function boot() {
    // pick up the configured currency for all money displays
    api("/api/admin/settings")
      .then((d) => { currency = d.settings.currency || "₱"; })
      .catch(() => {});
    loadPage();
  }

  setInterval(async () => {
    if ($("#login-screen").classList.contains("hidden")) {
      try {
        const d = await api("/api/admin/overview");
        updateBadge(d);
        if (currentPage === "dashboard") loadDashboard();
      } catch {}
    }
  }, 30000);

  (async () => {
    try {
      const me = await fetch("/api/admin/me").then((r) => r.json());
      if (me.admin) {
        showLogin(false);
        boot();
      } else {
        showLogin(true);
      }
    } catch {
      showLogin(true);
    }
  })();
})();
