const CACHE_NAME = "taskflow-cache-v3";
const APP_SHELL = [
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./db.js",
  "./manifest.json",
  "./icons/taskflow.svg",
];
const APP_SHELL_URLS = APP_SHELL.map((resource) => new URL(resource, self.registration.scope));
const APP_SHELL_PATHS = new Set(APP_SHELL_URLS.map((resource) => resource.pathname));
const INDEX_URL = new URL("./index.html", self.registration.scope);
const SCOPE_URL = new URL(self.registration.scope);

self.addEventListener("install", (event) => {
  // Install atomically so an incomplete app shell never replaces the working cache.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((cacheName) =>
            (cacheName.startsWith("taskflow-cache-") || cacheName.startsWith("taskflow-shell-"))
            && cacheName !== CACHE_NAME,
          )
          .map((cacheName) => caches.delete(cacheName)),
      ),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);

  // Ignore writes, external origins, and requests outside this app's deployment scope.
  if (
    request.method !== "GET"
    || requestUrl.origin !== SCOPE_URL.origin
    || !requestUrl.pathname.startsWith(SCOPE_URL.pathname)
  ) {
    return;
  }

  const apiPath = new URL("./api/", SCOPE_URL).pathname;
  if (requestUrl.pathname === apiPath.slice(0, -1) || requestUrl.pathname.startsWith(apiPath)) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedPage = await cache.match(INDEX_URL);

      if (cachedPage) {
        return cachedPage;
      }

      // When the shell is unavailable, try the network before showing an offline explanation.
      try {
        return await fetch(request);
      } catch {
        return new Response(
          "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><title>TaskFlow sin conexión</title><body><h1>TaskFlow no está disponible sin conexión</h1><p>Conéctate una vez para guardar los archivos de la aplicación y volver a intentarlo.</p></body></html>",
          {
            status: 503,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          },
        );
      }
    })());
    return;
  }

  // Cache First is limited to the known app shell; unrelated same-origin requests are untouched.
  if (!APP_SHELL_PATHS.has(requestUrl.pathname)) {
    return;
  }

  event.respondWith((async () => {
    let cache;
    try {
      cache = await caches.open(CACHE_NAME);
    } catch (error) {
      console.error("TaskFlow: no se pudo abrir la caché; se intentará usar la red.", error);
      return fetch(request);
    }

    const cacheUrl = APP_SHELL_URLS.find((resource) => resource.pathname === requestUrl.pathname);
    const cachedResponse = await cache.match(cacheUrl);

    if (cachedResponse) {
      return cachedResponse;
    }

    const response = await fetch(request);
    if (response.ok) {
      try {
        await cache.put(cacheUrl, response.clone());
      } catch (error) {
        console.error("TaskFlow: no se pudo guardar el recurso en caché.", error);
      }
    }
    return response;
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const notificationUrl = new URL(
    event.notification.data?.url ?? "./#pending",
    self.registration.scope,
  );
  if (notificationUrl.origin !== SCOPE_URL.origin) {
    return;
  }

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const appClient = clients.find((client) => "focus" in client);
      if (appClient) {
        return appClient.navigate(notificationUrl.href).then((client) => client?.focus());
      }
      return self.clients.openWindow(notificationUrl.href);
    }),
  );
});
