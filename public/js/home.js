/* Home page: featured drops (owner-curated) + movement photo strip. */
(() => {
  const TITLES = ["Built for the grind", "Wherever the wave takes you", "Fuel the movement", "Carry the culture"];

  W3.data.then((shop) => {
    // admin-uploaded hero image (falls back to the bundled hero.png)
    if (shop.settings.hero)
      document.getElementById("hero-img").src = "/media/" + encodeURIComponent(shop.settings.hero);

    const grid = document.getElementById("drop-grid");
    const esc = W3.esc;
    const cards = [];

    for (const p of shop.products) {
      if (!p.featured) continue;
      const img = p.image ? "/media/" + encodeURIComponent(p.image) : "/tshirt.svg";
      const inStock = p.variants.some((v) => v.stock > 0);
      const badge = inStock ? (p.badge || "Limited Drop") : "Sold Out";
      cards.push(`
        <a class="drop-card" href="/shop">
          <div class="ph"><span class="tag">${esc(badge)}</span><img src="${img}" alt="${esc(p.name)}" loading="lazy" /></div>
          <div class="info"><div class="nm">${esc(p.name)}</div><div class="pr">${W3.money(p.price)}</div></div>
        </a>`);
    }
    for (const name of shop.settings.coming_soon || []) {
      cards.push(`
        <div class="drop-card soon">
          <div class="ph"><span class="tag soon">Coming Soon</span><img class="soon-mark" src="/logo-mark.png" alt="Wave 3" loading="lazy" /></div>
          <div class="info"><div class="nm">${esc(name)}</div><div class="pr" style="color:#8a8aa0;">Coming soon</div></div>
        </div>`);
    }
    grid.innerHTML = cards.join("");

    // movement strip stories (admin-editable, rich text; sanitized server-side)
    const stories = shop.settings.movement || [];
    document.querySelectorAll("#mv-strip .mv-item").forEach((item) => {
      const i = Number(item.dataset.i);
      const raw = (stories[i] || "").trim();
      const body = !raw ? "" : /</.test(raw) ? `<div class="mv-rich">${raw}</div>` : `<p>${esc(raw)}</p>`;
      item.querySelector(".mv-story").innerHTML =
        `<h3>${esc(TITLES[i])}</h3>` + body +
        `<span class="hint">Click anywhere to go back</span>`;
    });
  });

  // ---------- movement strip expand / collapse ----------
  const strip = document.getElementById("mv-strip");
  let openItem = null;

  strip.querySelectorAll(".mv-item").forEach((item) => {
    item.addEventListener("click", (e) => {
      if (openItem) return; // expanded: the document handler collapses
      e.stopPropagation();
      openItem = item;
      item.classList.add("open");
      strip.classList.add("expanded");
    });
  });

  document.addEventListener("click", () => {
    if (!openItem) return;
    openItem.classList.remove("open");
    strip.classList.remove("expanded");
    openItem = null;
  });
})();
