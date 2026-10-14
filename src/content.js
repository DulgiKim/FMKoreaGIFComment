// Content script for FMKorea. Two jobs:
//
// 1. Shows Tenor links in comments as GIFs. FMKorea itself only stores and
//    shows the link as text, so the GIF is visible only to people who have
//    this extension; everyone else sees the plain link.
// 2. Adds a GIF button to the comment forms. Picking a GIF types its
//    media.tenor.com link into the comment box; the user posts the comment
//    with FMKorea's own button as usual.
(() => {
  // sw.js also injects this file into tabs that were open before the install;
  // a tab must not end up with two copies.
  if (globalThis.gfkLoaded) return;
  globalThis.gfkLoaded = true;

  const FORM_SCOPE = '.cmt_editor form, #re_cmt form, .fdb_lst_ul form';
  const COMMENT_BODY = '.fdb_lst_ul .xe_content, .comment-content .xe_content';
  const PICKER_W = 340;
  const PICKER_H = 420;
  const SEARCH_DEBOUNCE_MS = 350;
  const NO_FAVORITES = '즐겨찾기가 없습니다. GIF에 마우스를 올리고 별을 누르세요.';

  // A file on Tenor's media host, or a GIF's page on tenor.com.
  const MEDIA_SRC = 'https://media\\d*\\.tenor\\.com/(?:m/)?[A-Za-z0-9_-]{16}/[A-Za-z0-9._%-]+\\.(?:gif|webp)';
  const PAGE_SRC = 'https://(?:www\\.)?tenor\\.com/(?:[a-z]{2}(?:-[A-Za-z]{2})?/)?view/[A-Za-z0-9%_-]+-\\d{1,20}';
  const IS_MEDIA = new RegExp(`^${MEDIA_SRC}$`);
  const IS_PAGE = new RegExp(`^${PAGE_SRC}$`);
  const ANY_LINK = new RegExp(`${MEDIA_SRC}|${PAGE_SRC}`, 'g');
  const HAS_LINK = new RegExp(`${MEDIA_SRC}|${PAGE_SRC}`);

  const PICKER_CSS = `
    :host { all: initial; position: fixed; z-index: 2147483647; }
    .panel {
      --bg: #fff; --fg: #222; --muted: #777; --line: rgba(0,0,0,.12); --field: rgba(0,0,0,.05); --accent: #3c5ba9; --err: #c00;
      --thumb: rgba(0,0,0,.25); --thumb-hover: rgba(0,0,0,.45);
      box-sizing: border-box; display: flex; flex-direction: column;
      width: ${PICKER_W}px; background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
      box-shadow: 0 8px 28px rgba(0,0,0,.3);
      font: 13px/1.4 "Malgun Gothic", "Apple SD Gothic Neo", Arial, sans-serif;
    }
    .search { flex: none; display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); }
    input {
      box-sizing: border-box; flex: 1; min-width: 0; height: 34px; padding: 0 12px;
      border: 1px solid transparent; border-radius: 17px; outline: none;
      background: var(--field); color: var(--fg); font: inherit;
    }
    input:focus { border-color: var(--accent); }
    input::placeholder { color: var(--muted); }
    .fav-tab {
      flex: none; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%;
      background: var(--field); color: var(--muted); font: 16px/1 Arial, sans-serif; cursor: pointer;
    }
    .fav-tab[aria-pressed="true"] { background: var(--accent); color: var(--bg); }
    .fav-tab:focus-visible, .star:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .status { flex: none; padding: 6px 12px 0; color: var(--muted); }
    .status:empty { display: none; }
    .status[data-kind="error"] { color: var(--err); }
    .grid {
      flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; padding: 8px 2px 8px 8px;
      display: flex; align-items: flex-start; gap: 6px;
      scrollbar-gutter: stable;
    }
    .grid::-webkit-scrollbar { width: 12px; }
    .grid::-webkit-scrollbar-track { background: transparent; }
    .grid::-webkit-scrollbar-thumb {
      border: 3px solid transparent; border-radius: 6px;
      background: var(--thumb); background-clip: content-box;
    }
    .grid::-webkit-scrollbar-thumb:hover { background: var(--thumb-hover); background-clip: content-box; }
    .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .tile {
      display: block; width: 100%; margin: 0; padding: 0; border: 0; border-radius: 8px;
      overflow: hidden; background: var(--field); cursor: pointer;
    }
    .tile:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .tile:hover img { opacity: .82; }
    .tile img { display: block; width: 100%; height: auto; }
    /* The star is the tile's sibling, not its child: a button cannot hold another button. */
    .cell { position: relative; }
    .star {
      position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%;
      background: rgba(0,0,0,.6); color: #fff; font: 16px/1 Arial, sans-serif; cursor: pointer; opacity: 0;
    }
    .cell:hover .star, .star:focus-visible, .star[aria-pressed="true"] { opacity: 1; }
    .star[aria-pressed="true"] { color: #ffd45c; }
  `;

  // ---------------------------------------------------------- comment GIFs

  // href -> Promise<gif | null>, so a link that appears many times on a page
  // is looked up once.
  const resolved = new Map();

  function resolveLink(href) {
    if (!resolved.has(href)) {
      resolved.set(href, chrome.runtime.sendMessage({ type: 'resolve', input: href })
        .then((reply) => (reply && reply.ok && reply.gifs[0]) || null, () => null));
    }
    return resolved.get(href);
  }

  // The GIF links to its file, so a click still opens what the comment says.
  function gifNode(src, text) {
    const a = document.createElement('a');
    a.className = 'gfk-gif';
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    const img = document.createElement('img');
    img.src = src;
    img.alt = 'GIF';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => a.replaceWith(document.createTextNode(text)), { once: true });
    a.append(img);
    return a;
  }

  // A tenor.com page link stays as text until its GIF file is known.
  function pageNode(href) {
    const span = document.createElement('span');
    span.className = 'gfk-pending';
    span.textContent = href;
    resolveLink(href).then((gif) => {
      if (gif && span.isConnected) span.replaceWith(gifNode(gif.url, href));
    });
    return span;
  }

  const linkNode = (href) => (IS_MEDIA.test(href) ? gifNode(href, href) : pageNode(href));

  function renderComment(el) {
    // Links the site has already turned into anchors.
    for (const a of el.querySelectorAll('a[href]')) {
      if (a.classList.contains('gfk-gif')) continue;
      const href = a.getAttribute('href');
      if (IS_MEDIA.test(href) || IS_PAGE.test(href)) a.replaceWith(linkNode(href));
    }
    // Links written as plain text.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('a, .gfk-pending') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (HAS_LINK.test(n.data)) nodes.push(n);
    }
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of node.data.matchAll(ANY_LINK)) {
        if (m.index > last) frag.append(node.data.slice(last, m.index));
        frag.append(linkNode(m[0]));
        last = m.index + m[0].length;
      }
      if (last < node.data.length) frag.append(node.data.slice(last));
      node.replaceWith(frag);
    }
  }

  // ------------------------------------------------------------- GIF buttons

  function textareaOf(form) {
    return form.querySelector('textarea[id^="editor_"]')
      || form.querySelector('.simple_wrt textarea')
      || form.querySelector('textarea:not([name="title"])');
  }

  function addButton(form) {
    if (form.querySelector('.gfk-bar')) return;
    const textarea = textareaOf(form);
    if (!textarea) return;
    const bar = document.createElement('div');
    bar.className = 'gfk-bar';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'gfk-btn';
    btn.textContent = 'GIF';
    btn.title = 'GIF 넣기 (이 확장을 쓰는 사람에게만 GIF로 보이고, 다른 사람에게는 링크로 보입니다)';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (picker.open && picker.anchor === btn) closePicker();
      else openPicker(btn, form);
    });
    bar.append(btn);
    (textarea.closest('.simple_wrt') || textarea).after(bar);
  }

  let scanQueued = false;
  function scan() {
    scanQueued = false;
    for (const form of document.querySelectorAll(FORM_SCOPE)) addButton(form);
    for (const el of document.querySelectorAll(COMMENT_BODY)) {
      if (el.dataset.gfkDone) continue;
      el.dataset.gfkDone = '1';
      renderComment(el);
    }
  }
  // Comment pages, reply forms and edit forms are all loaded in place.
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }).observe(document.documentElement, { childList: true, subtree: true });
  scan();

  // ------------------------------------------------------------------ picker

  const picker = { open: false, host: null, anchor: null, form: null, els: null, seq: 0, timer: 0, gifs: [], favorites: [], showingFavorites: false };

  function buildPicker() {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PICKER_CSS;

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'GIF 고르기');

    const search = document.createElement('div');
    search.className = 'search';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Tenor 검색 또는 Tenor 링크 붙여넣기';
    input.setAttribute('aria-label', input.placeholder);
    input.autocomplete = 'off';
    input.spellcheck = false;
    const favTab = document.createElement('button');
    favTab.type = 'button';
    favTab.className = 'fav-tab';
    favTab.textContent = '★';
    favTab.title = '즐겨찾기';
    favTab.setAttribute('aria-label', '즐겨찾기');
    favTab.setAttribute('aria-pressed', 'false');
    search.append(input, favTab);

    const status = document.createElement('div');
    status.className = 'status';
    status.setAttribute('role', 'status');

    const grid = document.createElement('div');
    grid.className = 'grid';

    panel.append(search, status, grid);
    root.append(style, panel);

    input.addEventListener('input', () => {
      clearTimeout(picker.timer);
      picker.timer = setTimeout(() => load(input.value), SEARCH_DEBOUNCE_MS);
    });
    favTab.addEventListener('click', () => {
      if (picker.showingFavorites) { load(input.value); return; }
      // A search that is waiting or under way must not replace the favorites.
      clearTimeout(picker.timer);
      picker.seq++;
      setFavoritesView(true);
      renderFavorites(false);
    });
    grid.addEventListener('click', (e) => {
      const star = e.target.closest('.star');
      const tile = e.target.closest('.tile');
      if (star) toggleFavorite(picker.gifs[Number(star.dataset.index)]);
      else if (tile) insert(picker.gifs[Number(tile.dataset.index)]);
    });

    picker.host = host;
    picker.els = { panel, input, status, grid, favTab };
  }

  function setStatus(text, kind) {
    picker.els.status.textContent = text || '';
    if (kind) picker.els.status.dataset.kind = kind;
    else delete picker.els.status.dataset.kind;
  }

  function place() {
    if (!picker.open) return;
    if (!picker.anchor.isConnected) { closePicker(); return; }
    const r = picker.anchor.getBoundingClientRect();
    const h = Math.min(PICKER_H, innerHeight - 16);
    picker.els.panel.style.height = `${h}px`;
    let top = r.top - h - 8;
    if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
    const left = Math.min(Math.max(8, r.left), innerWidth - PICKER_W - 8);
    picker.host.style.top = `${Math.max(8, top)}px`;
    picker.host.style.left = `${Math.max(8, left)}px`;
  }

  function openPicker(anchor, form) {
    if (!picker.host) buildPicker();
    if (picker.open) closePicker();
    picker.open = true;
    picker.anchor = anchor;
    picker.form = form;
    anchor.setAttribute('aria-expanded', 'true');
    document.documentElement.append(picker.host);
    place();
    picker.els.input.focus();
    load(picker.els.input.value);
  }

  function closePicker() {
    if (!picker.open) return;
    picker.open = false;
    clearTimeout(picker.timer);
    picker.seq++;
    picker.anchor.setAttribute('aria-expanded', 'false');
    picker.host.remove();
    if (picker.anchor.isConnected) picker.anchor.focus();
  }

  const looksLikeLink = (text) => /^\d{6,20}$/.test(text) || /^(https?:\/\/)?([\w-]+\.)*tenor\.com\//i.test(text);

  async function load(raw) {
    const text = raw.trim();
    const seq = ++picker.seq;
    setFavoritesView(false);
    setStatus(text ? '검색 중…' : '불러오는 중…');
    let reply;
    try {
      reply = await chrome.runtime.sendMessage(
        !text ? { type: 'featured' } : looksLikeLink(text) ? { type: 'resolve', input: text } : { type: 'search', query: text },
      );
    } catch (e) {
      reply = { ok: false, error: '확장 프로그램이 다시 로드되었습니다. 페이지를 새로고침하세요.' };
    }
    if (seq !== picker.seq || !picker.open) return;
    if (!reply || !reply.ok) {
      render([]);
      setStatus((reply && reply.error) || 'Tenor에 연결할 수 없습니다.', 'error');
      return;
    }
    render(reply.gifs);
    setStatus(reply.gifs.length ? '' : 'GIF가 없습니다.');
  }

  function render(gifs) {
    picker.gifs = gifs;
    // Two columns that grow downwards; each GIF goes into the shorter one.
    const cols = [0, 1].map(() => {
      const col = document.createElement('div');
      col.className = 'col';
      return { el: col, height: 0 };
    });
    gifs.forEach((gif, i) => {
      const cell = document.createElement('div');
      cell.className = 'cell';
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.index = String(i);
      tile.title = gif.title;
      const img = document.createElement('img');
      img.src = gif.preview;
      img.alt = gif.title;
      img.width = gif.width;
      img.height = gif.height;
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      tile.append(img);
      const star = document.createElement('button');
      star.type = 'button';
      star.className = 'star';
      star.dataset.index = String(i);
      setStar(star, gif);
      cell.append(tile, star);
      const col = cols[0].height <= cols[1].height ? cols[0] : cols[1];
      col.el.append(cell);
      col.height += gif.height / gif.width;
    });
    picker.els.grid.replaceChildren(...cols.map((c) => c.el));
    picker.els.grid.scrollTop = 0;
  }

  // --------------------------------------------------------------- favorites

  function setFavoritesView(on) {
    picker.showingFavorites = on;
    picker.els.favTab.setAttribute('aria-pressed', String(on));
  }

  function setStar(star, gif) {
    const on = picker.favorites.some((f) => f.id === gif.id);
    star.textContent = on ? '★' : '☆';
    star.title = on ? '즐겨찾기에서 빼기' : '즐겨찾기에 추가';
    star.setAttribute('aria-label', star.title);
    star.setAttribute('aria-pressed', String(on));
  }

  function renderFavorites(keepScroll) {
    const top = keepScroll ? picker.els.grid.scrollTop : 0;
    render(picker.favorites);
    picker.els.grid.scrollTop = top;
    setStatus(picker.favorites.length ? '' : NO_FAVORITES);
  }

  // Takes the stored list, on load and whenever any tab changes it, so every
  // tab works on the same list and none writes back an old copy.
  function useFavorites(stored) {
    picker.favorites = (Array.isArray(stored) ? stored : []).filter((g) => g
      && typeof g.id === 'string' && typeof g.title === 'string' && typeof g.preview === 'string'
      && typeof g.url === 'string' && IS_MEDIA.test(g.url) && g.width > 0 && g.height > 0);
    if (!picker.open) return;
    if (picker.showingFavorites) renderFavorites(true);
    else for (const star of picker.els.grid.querySelectorAll('.star')) setStar(star, picker.gifs[Number(star.dataset.index)]);
  }

  chrome.storage.local.get('favorites').then((items) => useFavorites(items.favorites));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.favorites) useFavorites(changes.favorites.newValue);
  });

  // Only writes the list; the change listener above then shows it, here and
  // in every other tab.
  async function toggleFavorite(gif) {
    const rest = picker.favorites.filter((f) => f.id !== gif.id);
    try {
      await chrome.storage.local.set({ favorites: rest.length < picker.favorites.length ? rest : [gif, ...rest] });
    } catch (e) {
      setStatus('즐겨찾기를 저장하지 못했습니다. 페이지를 새로고침하세요.', 'error');
    }
  }

  // ---------------------------------------------------------------- inserting

  // Types the GIF's link on a line of its own.
  function insert(gif) {
    const form = picker.form;
    const textarea = form && form.isConnected && textareaOf(form);
    if (!textarea) {
      setStatus('댓글창이 닫혔습니다. 다시 열고 시도하세요.', 'error');
      return;
    }
    if (!textarea.offsetParent) {
      setStatus('댓글 입력칸이 숨겨져 있습니다. 이미지콘 창을 닫고 다시 시도하세요.', 'error');
      return;
    }
    // The button took the focus, so the cursor position is not the user's:
    // the link goes after their text.
    const end = textarea.value.length;
    const before = textarea.value;
    const text = `${before && !/\s$/.test(before) ? '\n' : ''}${gif.url}\n`;
    closePicker();
    textarea.focus();
    textarea.setRangeText(text, end, end, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ------------------------------------------------------- page interactions

  const inPicker = (e) => picker.open && e.composedPath().includes(picker.host);

  for (const type of ['keydown', 'keyup', 'keypress']) {
    window.addEventListener(type, (e) => {
      if (!inPicker(e)) return;
      e.stopImmediatePropagation();
      if (type !== 'keydown') return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closePicker();
      } else if (e.key === 'Enter' && e.composedPath()[0] === picker.els.input) {
        e.preventDefault();
        if (picker.gifs.length === 1) insert(picker.gifs[0]);
      }
    }, true);
  }

  window.addEventListener('pointerdown', (e) => {
    if (!picker.open) return;
    const path = e.composedPath();
    if (!path.includes(picker.host) && !path.includes(picker.anchor)) closePicker();
  }, true);

  let placeQueued = false;
  const queuePlace = () => {
    if (!picker.open || placeQueued) return;
    placeQueued = true;
    requestAnimationFrame(() => { placeQueued = false; place(); });
  };
  window.addEventListener('scroll', queuePlace, { capture: true, passive: true });
  window.addEventListener('resize', queuePlace, { passive: true });
})();
