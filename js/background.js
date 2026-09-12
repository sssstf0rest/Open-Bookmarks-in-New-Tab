/**
 * Background entry point. Keep cancellation registration synchronous and local.
 * Worker scripts share this classic service worker's global scope; their load
 * order is explicit below. No bundler, remote scripts, or download APIs.
 */
const CANCEL_URL = chrome.runtime.getURL("cancel.html");

// Register synchronously at worker evaluation, before settings/init awaits.
// Never fetch remotely or open a tab here: onBeforeNavigate owns the handoff.
// The explicit HTML MIME type is essential; an untyped extension response can
// enter Chrome's download pipeline even with status 204.
self.addEventListener("fetch", (event) => {
  if (event.request.url !== CANCEL_URL || event.request.method !== "GET") return;
  event.respondWith(new Response(null, {
    status: 204,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  }));
});

importScripts(
  "worker/config.js",
  "worker/settings.js",
  "worker/urls.js",
  "worker/bookmarks.js",
  "worker/navigation.js",
  "worker/lifecycle.js"
);
