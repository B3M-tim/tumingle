// TUMingle service worker — handles incoming push events and notification
// clicks. Registered from app.js only when the user taps "Enable
// notifications", not automatically on page load.
//
// No icon/badge is set below: there is no icon asset file anywhere in
// this project, and referencing one that doesn't exist silently breaks
// the notification in some browsers rather than just showing no icon.
// Add a real icon file later and reference it here if wanted.

self.addEventListener("push", (event) => {
  let data = { title: "TUMingle", body: "You have a new notification." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    // Payload wasn't JSON — fall back to the default text above.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag || "tumingle",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
