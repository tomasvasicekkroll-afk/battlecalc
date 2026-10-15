/* Battlecalc service worker: makes the app shell available offline.
 *
 * - The HTML and the hashed JS/CSS bundle are cached on install, so the app
 *   opens without a connection after the first visit.
 * - Navigations go network-first (a new deploy is picked up as soon as you are
 *   online) and fall back to the cached shell.
 * - User data is NOT handled here: it lives in Supabase and is cached/queued by
 *   src/lib/storage.js. Requests to other origins (Supabase) are left alone.
 *
 * Bump VERSION to drop all old caches.
 */
const VERSION = "v1";
const SHELL_CACHE = `battlecalc-shell-${VERSION}`;
const ASSET_CACHE = `battlecalc-assets-${VERSION}`;
const FONT_CACHE = `battlecalc-fonts-${VERSION}`;
const KEEP = [SHELL_CACHE, ASSET_CACHE, FONT_CACHE];
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];

const assetUrlsIn = (html) => Array.from(new Set(html.match(/\/assets\/[^"')\s]+/g) || []));

async function cacheShell() {
  const shell = await caches.open(SHELL_CACHE);
  const res = await fetch("/", { cache: "reload" });
  if (!res.ok) throw new Error("shell fetch failed");
  const html = await res.clone().text();
  await shell.put("/", res);
  const assets = await caches.open(ASSET_CACHE);
  await Promise.all(assetUrlsIn(html).map((u) => assets.add(u).catch(() => {})));
  await Promise.all(SHELL.slice(1).map((u) => shell.add(u).catch(() => {})));
}

self.addEventListener("install", (event) => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("battlecalc-") && !KEEP.includes(n)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Drops hashed assets of older builds once a newer HTML names the current ones.
async function pruneAssets(html) {
  const keep = new Set(assetUrlsIn(html));
  const assets = await caches.open(ASSET_CACHE);
  const keys = await assets.keys();
  await Promise.all(
    keys.filter((req) => new URL(req.url).pathname.startsWith("/assets/") && !keep.has(new URL(req.url).pathname)).map((req) => assets.delete(req))
  );
}

async function networkFirstNavigation(request) {
  const shell = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (res.ok && res.headers.get("content-type") && res.headers.get("content-type").includes("text/html")) {
      const html = await res.clone().text();
      await shell.put("/", res.clone());
      const assets = await caches.open(ASSET_CACHE);
      await Promise.all(assetUrlsIn(html).map((u) => assets.match(u).then((hit) => hit || assets.add(u).catch(() => {}))));
      await pruneAssets(html);
    }
    return res;
  } catch (e) {
    const cached = await shell.match("/");
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const refresh = fetch(request)
    .then((res) => {
      if (res.ok || res.type === "opaque") cache.put(request, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || refresh;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (request.mode === "navigate") {
      event.respondWith(networkFirstNavigation(request));
    } else if (url.pathname.startsWith("/assets/")) {
      event.respondWith(cacheFirst(request, ASSET_CACHE));
    } else if (url.pathname === "/sw.js") {
      return; // always fetched fresh by the browser
    } else {
      event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
    }
    return;
  }

  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(request, FONT_CACHE));
  }
  // anything else (Supabase API, auth): not intercepted
});
