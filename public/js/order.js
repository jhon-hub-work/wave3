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

  const code = decodeURIComponent(location.pathname.split("/").pop() || "").toUpperCase();
  let order = null;
  let currency = "₱";
  let pendingImage = null;

  const money = (n) =>
    currency + Number(n).toLocaleString("en-PH", { maximumFractionDigits: 2 });

  const STEPS = [
    { key: "placed", label: "Order placed" },
    { key: "proof", label: "Proof sent" },
    { key: "paid", label: "Paid" },
    { key: "shipped", label: "Shipped" }
  ];

  function stepIndex(status) {
    if (status === "pending") return 0;
    if (status === "proof") return 1;
    if (status === "paid") return 2;
    if (status === "shipped") return 3;
    return -1; // cancelled / expired
  }

  let deadlineTimer = null;
  function renderDeadline() {
    const el = $("#pay-deadline");
    // awaiting a shipping quote — no countdown has started yet
    if (order && order.status === "pending" && order.awaiting_quote) {
      el.classList.remove("hidden");
      el.style.borderColor = "#333f9e";
      el.style.background = "rgba(77,92,255,0.08)";
      el.innerHTML =
        "🧾 <strong>Waiting for your shipping fee.</strong> The seller will confirm your total shortly based on your delivery address. Your payment timer hasn't started yet — this page updates on its own once your total is ready.";
      return;
    }
    if (!order || order.status !== "pending" || !order.expires_at) {
      el.classList.add("hidden");
      if (order && order.status === "proof") {
        el.classList.remove("hidden");
        el.style.borderColor = "#1f7a41";
        el.style.background = "rgba(46,204,113,0.08)";
        el.innerHTML = "✅ <strong>Proof received — your order is safe.</strong> The payment timer no longer applies while we verify your payment.";
      }
      return;
    }
    const ms = new Date(order.expires_at.replace(" ", "T") + "Z").getTime() - Date.now();
    if (ms <= 0) {
      load(); // server will mark it expired
      return;
    }
    const h = Math.floor(ms / 36e5);
    const m = Math.floor((ms % 36e5) / 6e4);
    el.classList.remove("hidden");
    el.innerHTML = `⏳ <strong>Reserved for you — pay within ${h}h ${m}m.</strong> Upload your proof of payment below to keep this order. Unpaid orders are cancelled automatically and the stock is released.`;
  }

  function renderStepper() {
    const idx = stepIndex(order.status);
    const el = $("#stepper");
    if (idx < 0) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.innerHTML = STEPS.map((s, i) => {
      const cls = i < idx ? "done" : i === idx ? (i === 0 || order.status !== "pending" ? "done current" : "current") : "";
      const mark = i <= idx ? "✓" : i + 1;
      return `<div class="step ${cls}"><div class="step-dot">${mark}</div><div class="step-label">${s.label}</div></div>`;
    }).join("");
  }

  function renderContacts() {
    const contacts = order.contacts || [];
    const html = contacts
      .map(
        (c) =>
          `<a class="btn btn-ghost btn-sm" href="${String(c.url).replace(/"/g, "&quot;")}" target="_blank" rel="noopener">${c.label.replace(/[<>&]/g, "")}</a>`
      )
      .join("");
    document.querySelectorAll(".contact-row").forEach((el) => (el.innerHTML = html));
    $("#help-box").classList.toggle("hidden", contacts.length === 0);
  }

  function render() {
    currency = order.settings.currency || "₱";
    $("#loading").classList.add("hidden");
    $("#content").classList.remove("hidden");
    $("#o-code").textContent = order.code.replace(/^W3-/, "W3-");
    renderContacts();

    renderStepper();

    const isAwaiting = order.status === "pending" || order.status === "proof";
    $("#cancelled-box").classList.toggle("hidden", order.status !== "cancelled");
    $("#expired-box").classList.toggle("hidden", order.status !== "expired");
    $("#pay-section").classList.toggle("hidden", !isAwaiting);
    $("#receipt-section").classList.toggle("hidden", !(order.status === "paid" || order.status === "shipped"));

    if (isAwaiting) {
      renderDeadline();
      clearInterval(deadlineTimer);
      deadlineTimer = setInterval(renderDeadline, 30000);
    } else {
      clearInterval(deadlineTimer);
    }

    if (isAwaiting) {
      const awaitingQuote = order.status === "pending" && order.awaiting_quote;
      // hide payment + upload entirely until the total is confirmed
      $("#channels-section").classList.toggle("hidden", awaitingQuote);
      $("#proof-section").classList.toggle("hidden", awaitingQuote);

      if (awaitingQuote) {
        $("#o-total").innerHTML =
          money(order.items_total) + ' <span style="font-size:16px; color:var(--muted);">+ shipping (pending)</span>';
        $("#shipping-note").textContent =
          "Your shipping fee isn't set yet. Once the seller confirms it, your full total and payment details will appear here.";
      } else {
        $("#o-total").textContent = money(order.total);
        $("#shipping-note").textContent =
          order.shipping_fee > 0
            ? `Includes ${money(order.shipping_fee)} shipping fee.`
            : "Free shipping on this order.";
      }
      $("#order-lines").innerHTML = order.items
        .map(
          (it) =>
            `<div class="summary-line"><span class="muted">${it.product_name} — ${it.size} × ${it.qty}</span><span>${money(it.unit_price * it.qty)}</span></div>`
        )
        .join("");
      $("#payment-note").textContent = order.settings.payment_note || "";

      $("#channels").innerHTML = (order.payment_channels || [])
        .map(
          (c, i) => `
          <div class="channel">
            <div class="channel-head"><span class="channel-name">${c.label}</span></div>
            ${
              c.qr
                ? `<div style="text-align:center; padding: 8px 0 12px;">
                     <a href="/qr/${encodeURIComponent(c.qr)}" target="_blank" rel="noopener" title="Tap to open full size">
                       <img src="/qr/${encodeURIComponent(c.qr)}" alt="${c.label} payment QR code" style="width: 180px; max-width: 70%; background: #fff; padding: 8px; border-radius: 10px;" loading="lazy" />
                     </a>
                     <p class="muted small" style="margin-top:6px;">Scan to pay · tap the QR to enlarge</p>
                   </div>`
                : ""
            }
            ${c.lines
              .map((line) => {
                const idx = line.indexOf(":");
                const key = idx > -1 ? line.slice(0, idx + 1) : "";
                const val = idx > -1 ? line.slice(idx + 1).trim() : line;
                const copyable = /\d{6,}|^0x/i.test(val.replace(/[\s-]/g, ""));
                return `<div class="channel-line"><span>${key}</span><span class="val">${val}</span>${
                  copyable ? `<button class="copy-btn" data-copy="${val.replace(/"/g, "&quot;")}">COPY</button>` : ""
                }</div>`;
              })
              .join("")}
          </div>`
        )
        .join("");
      document.querySelectorAll(".copy-btn").forEach((b) =>
        b.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(b.dataset.copy);
            b.textContent = "COPIED!";
            setTimeout(() => (b.textContent = "COPY"), 1500);
          } catch {
            toast("Could not copy — please copy manually.", true);
          }
        })
      );

      $("#proof-done").classList.toggle("hidden", !order.has_proof);
      $("#uploader").classList.toggle("hidden", order.has_proof);
    }

    if (order.status === "paid" || order.status === "shipped") {
      $("#r-code").textContent = order.code;
      $("#r-name").textContent = order.customer_name;
      $("#r-phone").textContent = order.phone;
      $("#r-paid-date").textContent = order.paid_at
        ? new Date(order.paid_at.replace(" ", "T") + "Z").toLocaleString("en-PH", {
            dateStyle: "long",
            timeStyle: "short"
          })
        : "—";
      $("#r-items").innerHTML = order.items
        .map(
          (it) =>
            `<tr><td>${it.product_name} — Size ${it.size}</td><td style="text-align:center">${it.qty}</td><td style="text-align:right">${money(it.unit_price * it.qty)}</td></tr>`
        )
        .join("");
      $("#r-shipping").textContent = order.shipping_fee > 0 ? money(order.shipping_fee) : "FREE";
      $("#r-total").textContent = money(order.total);
      $("#shipped-note").textContent =
        order.status === "shipped"
          ? "Your order has been shipped! 📦"
          : "Payment verified. We're preparing your order for shipment.";

      // courier tracking
      const tbox = $("#tracking-box");
      if (order.tracking) {
        tbox.classList.remove("hidden");
        const isUrl = /^https?:\/\//i.test(order.tracking);
        $("#tracking-value").textContent = isUrl ? "" : order.tracking;
        $("#tracking-actions").innerHTML = isUrl
          ? `<a class="btn btn-primary btn-sm" href="${order.tracking.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">Open tracking page</a>`
          : `<button class="btn btn-ghost btn-sm" id="copy-tracking">Copy tracking number</button>`;
        const copyBtn = $("#copy-tracking");
        if (copyBtn)
          copyBtn.addEventListener("click", async () => {
            try {
              await navigator.clipboard.writeText(order.tracking);
              copyBtn.textContent = "Copied!";
              setTimeout(() => (copyBtn.textContent = "Copy tracking number"), 1500);
            } catch {
              toast("Could not copy — please copy manually.", true);
            }
          });
      } else {
        tbox.classList.add("hidden");
      }
    }
  }

  // ---- proof upload ----
  const dropzone = $("#dropzone");
  const fileInput = $("#file-input");

  function handleFile(file) {
    if (!file) return;
    if (!/image\/(png|jpeg|webp)/.test(file.type))
      return toast("Please choose a PNG, JPG, or WEBP image.", true);
    if (file.size > 12 * 1024 * 1024) return toast("Image too large (max 12 MB).", true);
    const reader = new FileReader();
    reader.onload = () => {
      pendingImage = reader.result;
      $("#preview-img").src = pendingImage;
      $("#preview-box").classList.remove("hidden");
      dropzone.classList.add("hidden");
    };
    reader.readAsDataURL(file);
  }

  if (dropzone) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") fileInput.click();
    });
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
      handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));

    $("#clear-proof-btn").addEventListener("click", () => {
      pendingImage = null;
      fileInput.value = "";
      $("#preview-box").classList.add("hidden");
      dropzone.classList.remove("hidden");
    });

    $("#send-proof-btn").addEventListener("click", async () => {
      if (!pendingImage) return;
      const btn = $("#send-proof-btn");
      btn.disabled = true;
      btn.textContent = "Sending…";
      try {
        const res = await fetch(`/api/orders/${order.code}/proof`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: pendingImage })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        toast("Proof of payment sent! We'll verify it shortly. 💙");
        await load();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Send proof of payment";
      }
    });

    $("#reupload-btn").addEventListener("click", () => {
      $("#proof-done").classList.add("hidden");
      $("#uploader").classList.remove("hidden");
      $("#preview-box").classList.add("hidden");
      dropzone.classList.remove("hidden");
      pendingImage = null;
      fileInput.value = "";
    });
  }

  async function load() {
    const res = await fetch(`/api/orders/${encodeURIComponent(code)}`);
    if (!res.ok) {
      $("#loading").classList.add("hidden");
      $("#notfound").classList.remove("hidden");
      return;
    }
    order = await res.json();
    render();
  }

  $("#print-btn")?.addEventListener("click", () => window.print());

  load();
  // gentle auto-refresh while awaiting verification
  setInterval(async () => {
    if (order && (order.status === "pending" || order.status === "proof")) {
      const res = await fetch(`/api/orders/${encodeURIComponent(code)}`);
      if (res.ok) {
        const fresh = await res.json();
        if (fresh.status !== order.status || fresh.total !== order.total) {
          order = fresh;
          render();
          if (fresh.status === "paid") toast("Payment verified — here's your receipt! 💙");
        }
      }
    }
  }, 20000);
})();
