// Push handlers, importScripts'd into the generated service worker (see
// vite.config.js). Kept as its own file because workbox's generateSW
// writes sw.js itself — this is the one piece of hand-written worker
// code the app has.

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* an unreadable payload still buzzes */ }
  event.waitUntil((async () => {
    // With the app on screen, a banner over it (and a dot on its icon that
    // nothing then clears) is noise: the page is told instead and moves
    // its own badge. Out of sight, it buzzes as before.
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // Only the app itself counts as "on screen". The Worker serves the
    // client approval page, the policy pages and the drive callback on this
    // same origin, and a visible one of those used to swallow the buzz.
    const isApp = c => { try { const p = new URL(c.url).pathname; return p === "/" || p === "/index.html"; } catch (_) { return false; } };
    const visible = wins.filter(c => c.visibilityState === "visible" && isApp(c));
    if (visible.length) {
      visible.forEach(c => { try { c.postMessage({ type: "chat-push" }); } catch (_) { /* older page */ } });
      return;
    }
    // A dot on the app's icon until the room is read — the app itself
    // replaces it with the real count (or clears it) when opened.
    if ("setAppBadge" in self.navigator) await self.navigator.setAppBadge().catch(() => {});
    await showChatNotification(data);
  })());
});

function showChatNotification(data) {
  return self.registration.showNotification(data.title || "Team chat", {
    body: data.body || "New message",
    icon: "/icons/icon-192.png",
    // The status-bar icon. Android renders only its alpha silhouette —
    // this is the wordmark's V, white on transparent (badge-96.png,
    // extracted from icon-192) — and without one, Chrome shows a
    // generic bell up there instead of the app.
    badge: "/icons/badge-96.png",
    // One tag: a burst of messages collapses into the latest notification
    // instead of stacking a dozen on the lock screen.
    tag: "team-chat",
    // …but renotify so each new message in that burst still buzzes. Without
    // it, replacing a same-tag notification updates the banner silently, and
    // the crew — who depend on push — feel only the first message's buzz and
    // miss the rest.
    renotify: true,
    data: { url: data.url || "/" }
  });
}

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      // An open app is navigated to the destination, not just focused —
      // a focus alone leaves it on whatever screen it was showing. This
      // began life as a postMessage the page listened for, which broke
      // whenever the running page was a build behind the worker (an
      // app-switcher resume never reloads); a navigation always lands
      // on the newest build, and ?goto=chat does the rest. Both paths,
      // open and closed, now funnel through the same URL.
      for (const c of list) {
        if ("navigate" in c) {
          return c.navigate(url).then(w => (w || c).focus()).catch(() => c.focus());
        }
        if ("focus" in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
