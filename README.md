# TUMingle — Firebase-direct rewrite

This is the rewrite built the same way as your 3M app: plain static files
(no Node.js, no build step, no server to run) that talk to Firebase
directly from the browser. Firestore Security Rules do the job your old
`server.js` used to do — they're what actually stops one student from
reading another's private data, not anything in this JavaScript.

## Files

- `index.html` — the whole app UI (auth, discover/swipe, matches, chat, profile)
- `app.js` — all the logic
- `firebase-init.js` — **the only file you need to edit to go live**
- `sw.js` — service worker, only used for push notifications
- `firestore.rules` — your security rules (already published — keep this copy as the source of truth)

## Before this will work: edit `firebase-init.js`

Open `firebase-init.js` and replace the three placeholder blocks:

1. **`firebaseConfig`** — from Firebase console → gear icon → Project
   settings → "Your apps" → your web app's config object.
2. **`cloudinaryConfig.cloudName`** — from your Cloudinary dashboard,
   shown at the top as "Cloud name". `uploadPreset` is already set to
   `tumingle_unsigned`, which you created.
3. **`vapidPublicKey`** — only needed if you want push notifications
   working. See "Push notifications" below for how to generate this —
   it's free and doesn't need a card, same as everything else here.

None of these three values are secret. It's normal for them to be
visible in your page's source code — that's not a leak. Your actual
protection is `firestore.rules`.

## Testing it locally before you deploy

Since there's no server, you can't just double-click `index.html` —
browsers block some of what Firebase needs when a page is opened via
`file://`. Easiest free option: in VS Code, install the "Live Server"
extension, right-click `index.html`, "Open with Live Server". That
serves the folder at `http://localhost:...` which works fine.

## Deploying to Cloudflare Pages

1. Push this folder to a GitHub repo (or drag-and-drop the whole folder
   into Cloudflare Pages' dashboard — it supports direct upload, no git
   needed).
2. In Cloudflare Pages: Create a project → connect the repo (or direct
   upload) → **no build command, no build output directory** (leave
   blank / "None") — this is a plain static site, nothing to build.
3. Once deployed, go back to Firebase console → Authentication →
   Settings → Authorized domains, and add your new `*.pages.dev` URL
   (and your custom domain later, if you get one). Firebase Auth refuses
   to work from domains it doesn't know about — this is a real step, not
   optional.

## What's genuinely working vs. what has real limits

Being straight with you about what you're getting, so nothing surprises
you later:

**Fully working:** signup/login with TUM email verification, Discover
with swipe gestures, liking, mutual matching, messaging (after a
match), unmatching (deletes the match and all messages both ways),
block, report, multi-photo upload via Cloudinary (up to 6, reorderable,
deletable), structured interest tags.

**Chat is not live-updating.** Messages send and save correctly, but
the chat screen doesn't automatically show a new message the other
person sends while you're looking at it — you'd need to leave the chat
and reopen it to see it. This is a direct consequence of talking to
Firestore over plain REST calls instead of the full Firestore SDK
(which is what gives real-time updates, via a persistent connection).
Fixing this later means pulling in the Firestore SDK just for the chat
screen — doable, but it's more code and worth doing as its own step
once the rest is solid.

**Discover downloads more than it should.** Right now, Discover fetches
up to 100 student profiles and filters out already-liked/blocked people
*in the browser*, not on a server. That means a blocked person's basic
profile data briefly reaches the blocker's browser before being filtered
out client-side — not displayed, but technically downloaded. A real
backend would exclude it before sending anything. This is an inherent
limit of a no-backend architecture; it's not a rules misconfiguration.
If this matters to you before launch, the fix is adding one small
Cloud Function (Firebase's serverless functions, free tier available)
that does this filtering server-side — it's a focused addition, not a
rebuild.

**Push notifications don't actually send yet** — only the "enable"
side is wired up (asking permission, subscribing the browser). Actually
*sending* a push when someone likes or messages you needs a tiny
server-side piece, because the key required to send pushes can never
live in browser code (anyone could read it and spam your users). See
below for the smallest free way to add this.

**Deleted photos stay in Cloudinary's storage.** Removing a photo from
your profile removes it from what others see, but doesn't delete the
underlying file from Cloudinary — deleting from their storage needs a
signed request using your API secret, which (same reasoning as above)
can't safely run in browser code. At your usage level this won't cost
anything or hit Cloudinary's free-tier limits meaningfully, so it's
safe to leave as-is for now.

## Push notifications: the minimal way to finish this later

When you're ready: generate a VAPID keypair once (ask me and I'll walk
you through it, or generate it with the `web-push` npm package's
`web-push generate-vapid-keys` command if you ever do have Node.js
available). The public key goes in `firebase-init.js`. The private key
goes into one small Cloudflare Worker (free tier, no card) that your
app calls instead of sending push directly — that Worker is the only
place the private key ever lives.

## Known risk if you skip the README

Every file here was reviewed line-by-line against your published
`firestore.rules` before being handed to you, specifically checking
that every write the app makes (profile saves, likes, messages, blocks,
reports) sends exactly the fields your rules expect — a mismatch there
is the kind of bug that fails silently as a permission error with no
helpful message. If you ever hand-edit `app.js` yourself and a save
stops working with no visible error, check your browser's console first
(F12 → Console tab) — a Firestore permission rejection shows up there
even when the UI doesn't display anything.
