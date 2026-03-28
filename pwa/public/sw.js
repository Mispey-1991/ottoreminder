/* Service Worker — handles push notifications and caching */

const CACHE_NAME = "dog-med-v1";

// Cache shell on install
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(["/", "/manifest.json"])
    )
  );
});

// Clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first fetch strategy
self.addEventListener("fetch", (event) => {
  // Skip API calls and non-GET
  if (event.request.url.includes("/api/") || event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const clone = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push Notification Handler ────────────────────────
self.addEventListener("push", (event) => {
  let data = { title: "Dog Medication", body: "Check the app" };

  try {
    data = event.data.json();
  } catch {
    data.body = event.data?.text() || data.body;
  }

  const options = {
    body: data.body,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "dog-medication",
    renotify: true,
    requireInteraction: data.data?.type === "reminder" || data.data?.type === "escalation",
    vibrate: [200, 100, 200],
    data: data.data || {},
    actions: [],
  };

  // Add action buttons based on notification type
  if (data.data?.type === "reminder" || data.data?.type === "escalation") {
    options.actions = [
      { action: "confirm", title: "✅ Done — I gave it" },
      { action: "snooze", title: "⏰ Snooze" },
    ];
  }

  event.waitUntil(self.registration.showNotification(data.title, options));
});

// ── Notification Click Handler ───────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "confirm") {
    // Call the confirm API directly from service worker
    event.waitUntil(
      fetch("/api/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Push Notification" }),
      }).then(() => {
        // Open or focus the app
        return self.clients.matchAll({ type: "window" }).then((clients) => {
          if (clients.length > 0) {
            return clients[0].focus();
          }
          return self.clients.openWindow("/");
        });
      })
    );
  } else if (event.action === "snooze") {
    // Snooze: the server will re-send at the next scheduled time
    // Just close the notification
  } else {
    // Default click: open app
    event.waitUntil(
      self.clients.matchAll({ type: "window" }).then((clients) => {
        if (clients.length > 0) return clients[0].focus();
        return self.clients.openWindow("/");
      })
    );
  }
});
