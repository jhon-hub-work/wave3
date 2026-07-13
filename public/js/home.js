/* Home page: featured drops — real products from the API + coming-soon cards. */
(() => {
  const SOON = [
    { name: "Wave 3 Hoodie" },
    { name: "Wave 3 Pro Jersey" },
    { name: "Wave 3 Tumbler" }
  ];

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
          <div class="ph"><span class="tag soon">Coming Soon</span><span class="soon-mark">W3</span></div>
          <div class="info"><div class="nm">${esc(s.name)}</div><div class="pr" style="color:#8a8aa0;">Coming soon</div></div>
        </div>`);
    }
    grid.innerHTML = cards.join("");
  });
})();
