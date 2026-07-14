/* Home page: featured drops + movement photo strip (click to expand). */
(() => {
  const SOON = [
    { name: "Wave 3 Hoodie" },
    { name: "Wave 3 Pro Jersey" },
    { name: "Wave 3 Tumbler" }
  ];

  const TITLES = ["Built for the grind", "Wherever the wave takes you", "Fuel the movement", "Carry the culture"];

  W3.data.then((shop) => {
    const grid = document.getElementById("drop-grid");
    const esc = W3.esc;
    const cards = [];

    for (const p of shop.products) {
      const img = p.image ? "/media/" + encodeURIComponent(p.image) : "/tshirt.svg";
      const inStock = p.variants.some((v) => v.stock > 0);
      cards.push(`
        <a class="drop-card" href="/shop">
          <div class="ph"><span class="tag">${inStock ? "Limited Drop" : "Sold Out"}</span><img src="${img}" alt="${esc(p.name)}" loading="lazy" /></div>
          <div class="info"><div class="nm">${esc(p.name)}</div><div class="pr">${W3.money(p.price)}</div></div>
        </a>`);
    }
    for (const s of SOON) {
      cards.push(`
        <div class="drop-card soon">
          <div class="ph"><span class="tag soon">Coming Soon</span><img class="soon-mark" src="/logo-mark.png" alt="Wave 3" loading="lazy" /></div>
          <div class="info"><div class="nm">${esc(s.name)}</div><div class="pr" style="color:#8a8aa0;">Coming soon</div></div>
        </div>`);
    }
    grid.innerHTML = cards.join("");

    // movement strip stories (admin-editable)
    const stories = shop.settings.movement || [];
    document.querySelectorAll("#mv-strip .mv-item").forEach((item) => {
      const i = Number(item.dataset.i);
      const text = (stories[i] || "").trim();
      item.querySelector(".mv-story").innerHTML =
        `<h3>${esc(TITLES[i])}</h3>` +
        (text ? `<p>${esc(text)}</p>` : "") +
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
