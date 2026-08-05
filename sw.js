// Service worker for the AR Tours Inbox PWA.
// Handles: install-to-home-screen support, a light offline app-shell cache,
// and push notifications for new customer messages.

const CACHE = 'ar-inbox-shell-v1';
const SHELL_ASSETS = ['/inbox', '/inbox/manifest.json'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first for API calls (always want fresh data), cache-first for the
// app shell itself so it still opens if you're offline or on a flaky signal.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/inbox/api/')) return; // never cache API responses
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

// Push notifications: server sends { title, body, phone, name } as JSON.
self.addEventListener('push', (event) => {
  let data = { title: 'AR Tours Inbox', body: 'New message' };
  try { data = event.data.json(); } catch (e) {}
  const options = {
    body: data.body || 'New message',
    icon: '/inbox/icon-192.png',
    badge: '/inbox/icon-192.png',
    tag: data.phone || 'ar-inbox',
    renotify: true,
    data: { phone: data.phone || '' }
  };
  event.waitUntil(self.registration.showNotification(data.title || 'AR Tours Inbox', options));
});

// Tapping a notification opens/focuses the inbox (and the right chat if we
// know the phone number — the page itself reads ?open= on load).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const phone = event.notification.data && event.notification.data.phone;
  const url = phone ? `/inbox?open=${encodeURIComponent(phone)}` : '/inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes('/inbox') && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
