/* The studio's mobile navigation, for every screen that has the app shell.
 *
 * WHY THIS IS ONE FILE AND NOT TWO BLOCKS OF MARKUP. The studio is two pages — the dashboard and
 * the generator — and each carries its own copy of the sidebar. Under 900px that sidebar was simply
 * `display:none`, so on a phone every screen except the one you happened to be on was unreachable:
 * no drawer, no tabs, no way back. Writing the fix into either page would have fixed one of them.
 *
 * NOTHING HERE DEFINES A DESTINATION. The drawer *is* the existing sidebar, moved off-canvas, so
 * every link, every badge and every `data-operator` role gate keeps working with no second copy to
 * keep in step. The bottom bar's four production tabs borrow their icon and their href from that
 * same sidebar wherever it has them. Add a page to the sidebar and it is in the drawer already.
 */
(function () {
  const app = document.querySelector('.app');
  const sidebar = document.querySelector('.sidebar');
  const main = document.querySelector('.main');
  if (!app || !sidebar || !main) return;

  const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

  /** The four screens a production day is actually spent in, plus Více for everything else.
   *  `href` and the icon come from the sidebar when it has that entry; the fallbacks are for the
   *  generator page, whose sidebar deliberately omits a link to itself. */
  const TABS = [
    { view: 'home', label: 'Přehled', href: '/#home', icon: '<path d="M3 9.5 12 3l9 6.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/>' },
    { view: 'orders', label: 'Objednávky', href: '/#orders', icon: '<path d="M6 2 4 6v13a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V6l-2-4z"/><path d="M4 6h16"/><path d="M16 10a4 4 0 0 1-8 0"/>' },
    { view: 'generator', label: 'Generátor', href: '/review', icon: '<path d="m3 21 6-6"/><path d="m14 4 6 6"/><path d="M14.5 4.5 19 9l-9 9-4.5-4.5z"/><path d="M18 2v3M21 4h-3"/>' },
    { view: 'queue', label: 'Tisk', href: '/#queue', icon: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="7" rx="2"/><path d="M7 16h10v5H7z"/>' },
  ];

  // ---- the drawer -----------------------------------------------------------

  const scrim = document.createElement('div');
  scrim.className = 'nav-scrim';
  scrim.hidden = true;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'nav-close';
  close.setAttribute('aria-label', 'Zavřít nabídku');
  close.innerHTML = svg('<path d="M6 6l12 12M18 6L6 18"/>');
  sidebar.prepend(close);

  let open = false;
  function setOpen(next) {
    open = next;
    app.classList.toggle('nav-open', open);
    scrim.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    // The real focus trap, in one attribute the browser enforces: while the drawer is over the
    // page, nothing behind it can be tabbed to or read out. Cheaper and more correct than a
    // hand-rolled keydown cycle, and it releases the moment the drawer closes.
    main.inert = open;
    document.body.classList.toggle('nav-locked', open);
    if (open) close.focus();
    else burger.focus({ preventScroll: true });
  }

  scrim.addEventListener('click', () => setOpen(false));
  close.addEventListener('click', () => setOpen(false));
  // Navigating closes it. Same-page hash links change nothing about the document, so nothing else
  // would — and a drawer still covering the screen after a tap reads as a tap that did nothing.
  sidebar.addEventListener('click', (e) => {
    if (e.target.closest('a,button') && e.target.closest('a,button') !== close) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
    }
  });

  // ---- the top bar ----------------------------------------------------------

  const top = document.createElement('header');
  top.className = 'mtop';
  top.innerHTML =
    `<button type="button" class="nav-burger" aria-label="Otevřít nabídku" aria-expanded="false">${svg('<path d="M4 7h16M4 12h16M4 17h16"/>')}</button>` +
    '<span class="mtop-title"></span>';
  const burger = top.querySelector('.nav-burger');
  const title = top.querySelector('.mtop-title');
  burger.addEventListener('click', () => setOpen(!open));

  /** The page title, wherever the page keeps it. The dashboard rewrites its h1 on every view
   *  change, so this follows the node rather than reading it once. */
  const h1 = document.querySelector('.topbar h1');
  const syncTitle = () => {
    title.textContent = (h1?.textContent ?? 'Studio').trim();
  };
  if (h1) new MutationObserver(syncTitle).observe(h1, { childList: true, characterData: true, subtree: true });
  syncTitle();

  // ---- the bottom bar -------------------------------------------------------

  const bottom = document.createElement('nav');
  bottom.className = 'mbot';
  bottom.setAttribute('aria-label', 'Hlavní navigace');

  for (const tab of TABS) {
    const source = sidebar.querySelector(`.nav a[data-view="${tab.view}"]`);
    const a = document.createElement('a');
    a.dataset.tab = tab.view;
    a.href = source?.getAttribute('href') ?? tab.href;
    a.innerHTML = (source?.querySelector('svg')?.outerHTML ?? svg(tab.icon)) + `<span>${tab.label}</span>`;
    // Role gating is the sidebar's, mirrored: the page's own `[data-operator]` sweep runs over the
    // whole document, so a tab marked here is hidden and revealed by the same code, at the same
    // moment, as the sidebar entry it came from.
    if (source?.hasAttribute('data-operator')) {
      a.setAttribute('data-operator', '');
      a.hidden = true;
    }
    bottom.append(a);
  }

  const more = document.createElement('button');
  more.type = 'button';
  more.dataset.tab = 'more';
  more.innerHTML = svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>') + '<span>Více</span>';
  more.addEventListener('click', () => setOpen(!open));
  bottom.append(more);

  /** Which tab is the screen currently on? Derived from the address, not from a click, so a reload
   *  or a link from elsewhere lands with the right tab lit. Anything the bar does not carry —
   *  Kreativy, Blog, Pošta, Nastavení, Profil — lights Více, which is where it lives. */
  function syncTab() {
    const view = location.pathname === '/review' ? 'generator' : location.hash.replace(/^#/, '').split(/[?/]/)[0] || 'home';
    const known = TABS.some((t) => t.view === view);
    for (const el of bottom.children) el.classList.toggle('on', el.dataset.tab === (known ? view : 'more'));
  }
  addEventListener('hashchange', syncTab);
  addEventListener('popstate', syncTab);
  syncTab();

  document.body.append(top, scrim, bottom);

  // A wide window has the sidebar back and the drawer must not be left latched open behind it.
  const wide = matchMedia('(min-width:901px)');
  wide.addEventListener('change', (e) => {
    if (e.matches && open) setOpen(false);
  });
})();
