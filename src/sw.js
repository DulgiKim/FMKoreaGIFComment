// Service worker: the only part that talks to Tenor. It hands the content
// script a short list of { id, title, preview, url, width, height }, where
// preview is a small file for the picker and url is the file whose link goes
// into the comment.
//
// Lists come from Tenor's API, using the key that every tenor.com page carries
// for the site's own scripts. If the API does not answer, they come from the
// result data Tenor embeds in its pages.

const TENOR = 'https://tenor.com';
const TENOR_API = 'https://tenor.googleapis.com/v2';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RESULTS = 50;
const MEDIA_URL = /^https:\/\/media\d*\.tenor\.com\//;

// url -> { time, value }
const cache = new Map();

// Chrome does not run content scripts in tabs that were already open when the
// extension is installed, so they are injected here once. content.js ignores a
// second copy of itself.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  const tabs = await chrome.tabs.query({ url: ['https://*.fmkorea.com/*', 'https://fmkorea.com/*'], discarded: false });
  await Promise.all(tabs.map(async ({ id: tabId }) => {
    const target = { tabId };
    try {
      await chrome.scripting.insertCSS({ target, files: ['src/content.css'] });
      await chrome.scripting.executeScript({ target, files: ['src/content.js'] });
    } catch (e) { /* the tab closed or navigated away; it gets the scripts on its next load */ }
  }));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(
    (gifs) => sendResponse({ ok: true, gifs }),
    (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }),
  );
  return true;
});

async function handle(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('잘못된 요청입니다.');
  if (msg.type === 'featured') return featured();
  if (msg.type === 'search' && typeof msg.query === 'string') return search(msg.query);
  if (msg.type === 'resolve' && typeof msg.input === 'string') return resolve(msg.input);
  throw new Error('잘못된 요청입니다.');
}

async function cached(url, load) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.time < CACHE_TTL_MS) return hit.value;
  const value = await load();
  cache.set(url, { time: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return value;
}

// A tenor.com page as { store, keys }: the results it shows, and the two
// values its own scripts send to Tenor's API (null if they cannot be read).
function fetchPage(url) {
  return cached(url, async () => {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Tenor에서 GIF를 찾을 수 없습니다.' : `Tenor가 HTTP ${res.status}를 반환했습니다.`);
    if (new URL(res.url).origin !== TENOR) throw new Error('Tenor가 예상치 못한 곳으로 이동시켰습니다.');
    const html = await res.text();
    const m = html.match(/<script id="store-cache" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) throw new Error('Tenor 페이지 형식이 바뀌어 검색할 수 없습니다.');
    return { store: JSON.parse(m[1]), keys: readKeys(html) };
  });
}

// The site's settings are base64 JSON in a second script element.
function readKeys(html) {
  const m = html.match(/<script id="data" type="text\/x-cache"[^>]*>([\s\S]*?)<\/script>/);
  try {
    const data = JSON.parse(atob(m[1].trim()));
    if (typeof data.API_V2_KEY === 'string' && typeof data.API_V2_CLIENT_KEY === 'string') {
      return { key: data.API_V2_KEY, client_key: data.API_V2_CLIENT_KEY };
    }
  } catch (e) { /* no keys: the callers fall back to the page's own results */ }
  return null;
}

// One call to Tenor's API, returning its results array.
async function fetchApi(path, params) {
  const { keys } = await fetchPage(`${TENOR}/`);
  if (!keys) throw new Error('Tenor 페이지 형식이 바뀌었습니다.');
  const query = new URLSearchParams({
    ...keys, contentfilter: 'medium', locale: 'ko_KR', country: 'KR',
    media_filter: 'tinygif,mediumgif,gif', ...params,
  });
  const url = `${TENOR_API}${path}?${query}`;
  return cached(url, async () => {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Tenor가 HTTP ${res.status}를 반환했습니다.`);
    const { results } = await res.json();
    if (!Array.isArray(results)) throw new Error('Tenor의 응답을 읽을 수 없습니다.');
    return results;
  });
}

const mediaUrl = (f) => (f && typeof f.url === 'string' && MEDIA_URL.test(f.url) ? f.url : null);

function toGif(r) {
  if (!r || !/^\d{1,20}$/.test(String(r.id)) || !r.media_formats) return null;
  const flags = r.flags || [];
  if (flags.includes('sticker') || flags.includes('static')) return null;
  const m = r.media_formats;
  const preview = m.tinygif || m.mediumgif || m.gif;
  // The comment gets a mid-sized file: the full gif is often several MB.
  const url = mediaUrl(m.mediumgif) || mediaUrl(m.tinygif) || mediaUrl(m.gif);
  if (!mediaUrl(preview) || !url) return null;
  const dims = Array.isArray(preview.dims) ? preview.dims : [];
  return {
    id: String(r.id),
    title: String(r.content_description || r.h1_title || 'GIF').slice(0, 200),
    preview: preview.url,
    url,
    width: dims[0] || 220,
    height: dims[1] || 124,
  };
}

const toGifs = (results) => (results || []).map(toGif).filter(Boolean).slice(0, MAX_RESULTS);

async function featured() {
  try {
    return toGifs(await fetchApi('/featured', { limit: MAX_RESULTS }));
  } catch (e) { /* fall back to the page's own list */ }
  const { store } = await fetchPage(`${TENOR}/`);
  return toGifs(store.gifs && store.gifs.featured && store.gifs.featured.results);
}

async function search(query) {
  const slug = query.trim().toLowerCase().split(/\s+/).filter(Boolean).map(encodeURIComponent).join('-');
  if (!slug) return featured();
  try {
    return toGifs(await fetchApi('/search', { q: query.trim(), limit: MAX_RESULTS }));
  } catch (e) { /* fall back to the search page's own list */ }
  const { store } = await fetchPage(`${TENOR}/search/${slug}-gifs`);
  const searches = Object.values((store.universal && store.universal.search) || {});
  return toGifs(searches[0] && searches[0].results);
}

// Accepts a tenor.com page link, a tenor.com short link, a media.tenor.com
// file link or a bare numeric ID, and returns the one GIF it points at.
async function resolve(input) {
  const text = input.trim();
  let pageUrl;
  if (/^\d{1,20}$/.test(text)) {
    pageUrl = `${TENOR}/view/x-gif-${text}`;
  } else {
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch (e) { throw new Error('Tenor 링크가 아닙니다.'); }
    if (/^media\d*\.tenor\.com$/.test(url.hostname)) {
      // media IDs are the base64 of the 64-bit GIF ID followed by a format code
      const mediaId = url.pathname.split('/').filter(Boolean).find((p) => /^[A-Za-z0-9_-]{16}$/.test(p));
      if (!mediaId) throw new Error('Tenor GIF 링크가 아닙니다.');
      pageUrl = `${TENOR}/view/x-gif-${decodeMediaId(mediaId)}`;
    } else if (url.hostname === 'tenor.com' || url.hostname === 'www.tenor.com') {
      pageUrl = `${TENOR}${url.pathname}`;
    } else {
      throw new Error('Tenor 링크가 아닙니다.');
    }
  }
  const { store } = await fetchPage(pageUrl);
  const entries = Object.values((store.gifs && store.gifs.byId) || {});
  const gifs = toGifs(entries.flatMap((e) => (e && e.results) || []).slice(0, 1));
  if (!gifs.length) throw new Error('이 링크는 GIF를 가리키지 않습니다.');
  return gifs;
}

function decodeMediaId(mediaId) {
  const bin = atob(mediaId.slice(0, 11).replace(/-/g, '+').replace(/_/g, '/') + '=');
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bin.charCodeAt(i));
  return n.toString();
}
