"use strict";

// ============================================================================
// DEPARTMENTS — copied verbatim from the original server.js data model so
// signup/profile validation matches exactly what TUM actually offers.
// ============================================================================
const DEPARTMENT_GROUPS = {
  "School of Engineering and Technology": [
    "Architecture and Built Environment",
    "Building and Civil Engineering",
    "Electrical and Electronic Engineering",
    "Mechanical and Automotive Engineering",
    "Marine",
    "Medical Engineering"
  ],
  "School of Business": [
    "Accounting and Finance",
    "Business Administration",
    "Management Science"
  ],
  "School of Humanities and Social Sciences": [
    "Communication Studies",
    "Social Sciences",
    "Hospitality and Tourism Management"
  ],
  "School of Pure and Applied Sciences": [
    "Pure and Applied Science",
    "Environmental and Health Sciences",
    "Medicine",
    "Mathematics and Physics",
    "Medical Sciences"
  ],
  "Institute of Computing and Informatics": [
    "Computer Science and Information Technology",
    "Open distance and e-Learning"
  ]
};
const DEPARTMENTS = Object.values(DEPARTMENT_GROUPS).flat();

// Generic interest tags — same caveat as before: not verified TUM student
// survey data, just a reasonable starting set students can pick from.
const INTEREST_TAGS = [
  "Football","Basketball","Rugby","Swimming","Athletics","Gym & Fitness",
  "Music","Dance","Singing","DJing","Photography","Film & TV","Gaming",
  "Reading","Writing","Poetry","Art & Drawing","Fashion","Cooking","Baking",
  "Travel","Hiking","Volunteering","Entrepreneurship","Coding","Debate",
  "Chess","Church / Faith","Fellowship","Politics & Current Affairs"
];

// Signup is now open to any email, not just @students.tum.ac.ke (by
// explicit instruction, 2026-10-14 — matches the open-signup approach
// used in the 3M app). This just checks for a plausible email shape
// (something@something.something), the same level of validation
// Firebase Auth itself does server-side — it's not trying to verify the
// address is real or reachable, just catch obvious typos before they
// become a confusing Firebase error.
function studentEmailValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}
function isAdultAge(age) {
  const n = Number(age);
  return Number.isInteger(n) && n >= 18 && n <= 100;
}
function clean(x, n) {
  return String(x == null ? "" : x).trim().slice(0, n || 500);
}
// Escapes text for BOTH element content and quoted attribute values. The old
// version round-tripped through a detached <div> (textContent -> innerHTML),
// which escapes & < > but NOT quotes. That is fine in element content, but
// unsafe once the result lands inside an attribute such as style="..." or
// data-x="...": a stray " lets stored profile text break out of the attribute
// and inject its own markup.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}
// Photo URLs end up inside CSS url(...). A profile document is writable by its
// owner with arbitrary strings, so only accept the exact shape Cloudinary's
// upload API returns (https://res.cloudinary.com/<cloud>/...) — a pattern that
// cannot contain quotes, parentheses, spaces or backslashes — and drop
// anything else instead of trusting it.
function safePhotoUrl(url) {
  return typeof url === "string" && /^https:\/\/res\.cloudinary\.com\/[\w\-\/\.%]+$/.test(url) ? url : "";
}

// ============================================================================
// FIRESTORE REST HELPERS
// Pattern carried over from the 3M app: talk to Firestore's REST API
// directly with fetch() + the Firebase Auth ID token as the bearer token,
// rather than pulling in the full Firestore SDK. Keeps this a single file
// with no build step, which is the whole point of this architecture.
// ============================================================================
let firebaseApp, auth, currentUser = null, idToken = null;
let firestoreDb; // real Firestore SDK instance — used for fsQuery() and live chat below

// THE database address. Firestore's REST path for the standard database is
//   .../databases/(default)/documents
// WITH the brackets. This file used to say databases/default (no brackets),
// which addresses a *named* database called "default" — one that doesn't
// exist — so every REST call came back 404 "The database default does not
// exist for project ...". That one missing pair of brackets was the real
// cause of the long-running "database does not exist" errors (confirmed
// against Google's own REST reference, which writes it as
// databases/(default)/documents/...). The SDK-based queries always worked
// because the SDK fills in the right database name itself.
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
// Set true while the signup handler is between creating the Auth account
// and finishing the Firestore profile write. onAuthStateChanged fires as
// soon as the Auth account exists, which can race ahead of that write —
// without this flag, the listener would see no profile yet and wrongly
// boot a brand-new user back to the auth screen with an error.
let signupInFlight = false;

// ----------------------------------------------------------------------------
// SESSION HEALTH: a fresh token for every request, and a clear end when the account is gone
// ----------------------------------------------------------------------------
let authNotice = null;       // { text, kind }: shown on the login screen after the app signs me out by itself
let deletingAccount = false; // true while "Delete my account" runs, so nothing writes my profile back
// Errors that mean "this login is finished for good": the account was deleted or disabled, or its sign-in expired.
const DEAD_SESSION_CODES = new Set(["auth/user-not-found", "auth/user-token-expired", "auth/user-disabled", "auth/invalid-user-token"]);
const DEAD_SESSION_TEXT = "You were signed out because this account was removed or your session expired. Log in again.";
function isDeadSession(e) { return !!(e && DEAD_SESSION_CODES.has(e.code)); }

function endSession(text, kind) {
  authNotice = { text, kind: kind || "err" };
  if (!currentUser) { flushAuthNotice(); return Promise.resolve(); }   // already signed out: just say why
  return window.__fbAuthMod.signOut(auth).catch(() => {});             // the auth listener shows the notice
}
function flushAuthNotice() {
  if (!authNotice) return;
  showMsg("authMsg", authNotice.text, authNotice.kind);
  authNotice = null;
}

// The current ID token. The SDK hands back its cached copy and only goes to the network when it is close to
// expiring, so asking before every request is cheap and, unlike a timer, still right after a phone slept for hours.
async function authToken(force) {
  const user = currentUser || (auth && auth.currentUser);
  if (!user) throw Object.assign(new Error("not signed in"), { code: "app/not-signed-in" });
  try {
    idToken = await user.getIdToken(!!force);
    return idToken;
  } catch (e) {
    if (isDeadSession(e)) endSession(DEAD_SESSION_TEXT);
    throw e;
  }
}

// fetch() with the bearer token; if the server refuses the token, get a brand-new one and try once more.
async function authedFetch(url, init = {}) {
  const send = async (force) => fetch(url, { ...init, headers: { ...(init.headers || {}), "Authorization": `Bearer ${await authToken(force)}` } });
  const res = await send(false);
  return res.status === 401 ? send(true) : res;
}

let sessionCheckAt = 0, sessionChecking = false;
// Is this login still valid? Asks the sign-in service (not the database, so it costs no reads). Runs when the app
// comes back to the foreground, so an account deleted in the Firebase console is noticed at once, not an hour later.
async function checkSessionAlive() {
  const user = currentUser;
  if (!user || sessionChecking || Date.now() - sessionCheckAt < 60000) return;
  sessionChecking = true; sessionCheckAt = Date.now();
  try { await user.reload(); }
  catch (e) { if (isDeadSession(e)) endSession(DEAD_SESSION_TEXT); }   // any other error (offline) means "ask again later"
  finally { sessionChecking = false; }
}
function wireSessionChecks() {
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkSessionAlive(); });
  window.addEventListener("online", checkSessionAlive);
}

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    // In Firestore's REST format an integer is sent as a JSON string
    // ({ integerValue: "18" }), because it is a 64-bit value.
    else if (typeof v === "number") fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (Array.isArray(v)) fields[k] = { arrayValue: { values: v.map(x => ({ stringValue: String(x) })) } };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}
function fromFirestoreFields(fields) {
  const out = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if ("stringValue" in v) out[k] = v.stringValue;
    else if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = Number(v.doubleValue);
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("nullValue" in v) out[k] = null;
    else if ("arrayValue" in v) out[k] = (v.arrayValue.values || []).map(x => x.stringValue ?? x.integerValue ?? x);
    else out[k] = null;
  }
  return out;
}

async function fsGet(collection, docId) {
  const res = await authedFetch(`${FS_BASE}/${collection}/${encodeURIComponent(docId)}`);
  if (res.status === 404) {
    // A 404 means two very different things: "no such document" (normal —
    // return null) or "no such DATABASE" (an addressing/setup problem that
    // must be loud, not silently treated as "empty"). The status code is
    // the same for both, so read the message.
    const body = await res.text();
    if (/database/i.test(body) && /does not exist/i.test(body)) {
      throw new Error("firestore-database-missing: " + body.slice(0, 300));
    }
    return null;
  }
  if (!res.ok) {
    const err = new Error(`fsGet ${collection}/${docId}: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const doc = await res.json();
  return { id: docId, ...fromFirestoreFields(doc.fields) };
}

// IMPORTANT: Firestore's REST PATCH replaces the ENTIRE document unless an
// updateMask query parameter lists exactly which fields to touch — any
// existing field left out of the request body is silently deleted. This
// is a well-documented but easy-to-miss gotcha (confirmed against the
// Firestore v1 API's own parameter reference: updateMask.fieldPaths is a
// repeated query parameter, not a body field). Every fsSet() call below
// therefore builds that mask automatically from the keys being written,
// so "update just this one field" genuinely only touches that field.
async function fsSet(collection, docId, data) {
  // If this person's profile document was never created (the server could not be
  // reached when they signed in), a plain PATCH would create a half-empty document
  // with no `verified` field. The security rules compare `verified` on every later
  // update, so they would then refuse every edit to that profile for good. So the
  // first write of such a profile creates the complete document instead.
  if (collection === "users" && currentUser && docId === currentUser.uid && myProfile && myProfile._unsaved) {
    const { id: _id, _unsaved, ...local } = myProfile;
    try {
      await fsCreate("users", docId, { ...defaultProfileFor(currentUser.email), ...local, ...data });
      delete myProfile._unsaved;
      const notice = document.getElementById("homeNotice");
      if (notice) notice.hidden = true;
      return {};
    } catch (e) {
      if (e.status !== 409) throw e;       // still can't reach the server: let the caller report it
      // 409: the document exists now (created from another tab). Adopt it, then update it normally.
      delete myProfile._unsaved;
      try { Object.assign(myProfile, normalizeProfile(await fsGet("users", docId))); } catch (_) { /* keep the local copy */ }
    }
  }
  const params = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`);
  // An edit must never create a profile by accident: a half-empty one has no `verified` field, and the rules
  // refuse every later update to it. So an edit only applies to a profile that exists.
  if (collection === "users") params.push("currentDocument.exists=true");
  const url = `${FS_BASE}/${collection}/${encodeURIComponent(docId)}${params.length ? "?" + params.join("&") : ""}`;
  const res = await authedFetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (res.status === 404 && collection === "users" && currentUser && docId === currentUser.uid) {
    // My profile document is gone while I'm signed in (someone deleted it in the console, say).
    // If my login is gone too, end the session; if only the document is gone, write the whole profile again.
    if (deletingAccount) throw new Error("account is being deleted");
    try { await currentUser.reload(); }
    catch (e) { if (isDeadSession(e)) endSession(DEAD_SESSION_TEXT); throw e; }
    const { id: _id, _unsaved, ...local } = myProfile || {};
    await fsCreate("users", docId, { ...defaultProfileFor(currentUser.email), ...local, ...data });
    return {};
  }
  if (!res.ok) {
    const err = new Error(`fsSet ${collection}/${docId}: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

// fsCreate: a true "create only" write (POST to the collection with
// ?documentId=...). If the document already exists Firestore answers 409,
// which callers treat as "already done". Used for new profiles, likes,
// messages and reports. fsSet() below is the update-or-create PATCH and is
// used for edits to a document that already exists.
async function fsCreate(collection, docId, data) {
  const url = `${FS_BASE}/${collection}?documentId=${encodeURIComponent(docId)}`;
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) {
    // err.status lets callers treat 409 (document already exists) as the
    // harmless "someone already created it" case instead of a failure.
    const err = new Error(`fsCreate ${collection}/${docId}: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function fsDelete(collection, docId) {
  const res = await authedFetch(`${FS_BASE}/${collection}/${encodeURIComponent(docId)}`, { method: "DELETE" });
  return res.ok || res.status === 404;
}

// fsQuery: list/filter queries, via the real Firestore SDK (window.__fbFirestoreMod,
// instance in firestoreDb — see the comment in initFirebase() for why this
// one piece moved off raw REST while fsGet/fsSet/fsCreate stay on it).
// where/limit are optional; pass {} for an unfiltered query against a
// collection. `where` is built with fieldFilter()/andFilter() below — this
// function is the only place that translates those into real SDK calls, so
// every existing call site (loadDiscover, chat loading, etc.) needed no
// changes at all.
async function fsQuery(collectionId, { where, limit: limitCount } = {}) {
  const fsMod = window.__fbFirestoreMod;
  const constraints = [];
  if (where) constraints.push(...whereToConstraints(where, fsMod));
  constraints.push(fsMod.limit(limitCount || 300));
  const q = fsMod.query(fsMod.collection(firestoreDb, collectionId), ...constraints);
  const snapshot = await fsMod.getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

// Translates this file's plain filter descriptors (built by fieldFilter()/
// andFilter() below) into the SDK's where() constraint objects.
function whereToConstraints(filter, fsMod) {
  if (filter.and) return filter.and.map(f => fieldFilterToConstraint(f, fsMod));
  return [fieldFilterToConstraint(filter, fsMod)];
}
function fieldFilterToConstraint({ fieldPath, op, value }, fsMod) {
  // REST-style op names (this file only ever uses "EQUAL") translated to
  // the SDK's symbolic operators.
  const opMap = { EQUAL: "==", NOT_EQUAL: "!=", LESS_THAN: "<", LESS_THAN_OR_EQUAL: "<=",
    GREATER_THAN: ">", GREATER_THAN_OR_EQUAL: ">=", ARRAY_CONTAINS: "array-contains" };
  return fsMod.where(fieldPath, opMap[op] || op, value);
}

// Plain filter descriptors — no more hand-built REST wire format (no
// integerValue/stringValue wrapping to get right), since fsQuery() now
// hands these to the real SDK's where(), which takes plain JS values
// directly and encodes them correctly itself.
function fieldFilter(fieldPath, op, value) {
  return { fieldPath, op, value };
}
function andFilter(filters) {
  return { and: filters };
}

// ============================================================================
// AUTH STATE
// ============================================================================
let myProfile = null; // cached users/{uid} document

function setAuthStatus(text, cls) {
  const el = document.getElementById("authStatus");
  el.textContent = text;
  el.className = "status-pill" + (cls ? " " + cls : "");
}
function showScreen(which) {
  document.getElementById("authScreen").style.display = which === "auth" ? "block" : "none";
  document.getElementById("appScreen").style.display = which === "app" ? "block" : "none";
  document.getElementById("logoutBtn").style.display = which === "auth" ? "none" : "inline-flex";
  // CSS hooks: the signed-in theme (paper background, nav strip, Saved pill,
  // floating safety button) only applies while this class is present.
  document.body.classList.toggle("signed-in", which === "app");
  // Auth state is known now, so the login box may show (see body.booting in index.html).
  document.body.classList.remove("booting");
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", which === "app" ? "#0B1020" : "#F6F3EC");
  // Don't leave the previous attempt behind. The password is never kept in the page once
  // someone is in (or has just logged out of) the app, which matters on shared lab computers,
  // and an old "Incorrect email or password" must not reappear after a later logout.
  const pw = document.getElementById("loginPassword");
  if (pw) pw.value = "";
  if (which === "app") hideMsg("authMsg");
  if (which === "auth") { const t = document.getElementById("toasts"); if (t) t.textContent = ""; }
}
function showMsg(elId, text, kind) {
  const el = document.getElementById(elId);
  el.textContent = text;
  el.className = "msg show " + (kind || "err");
}
function hideMsg(elId) {
  document.getElementById(elId).className = "msg";
}

async function initFirebase() {
  // Firebase App + Auth SDKs are the one place we DO use the real SDK
  // rather than raw REST — password handling, email verification and
  // token refresh are exactly the kind of security-sensitive plumbing
  // not worth re-implementing by hand.
  const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js");
  const authMod = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js");
  window.__fbAuthMod = authMod;

  // The Firestore SDK is used for LIST queries (fsQuery) and for the live
  // chat listener. Single-document get/create/update (fsGet/fsSet/fsCreate)
  // stay on plain REST against FS_BASE, which keeps failures fast and visible
  // on flaky mobile networks. (Earlier notes in this spot blamed REST
  // :runQuery itself for "database does not exist" errors. The real cause was
  // the missing brackets in the database name — see FS_BASE.)
  const fsMod = await import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js");
  window.__fbFirestoreMod = fsMod;

  firebaseApp = initializeApp(firebaseConfig);
  auth = authMod.getAuth(firebaseApp);
  firestoreDb = fsMod.getFirestore(firebaseApp);
  wireSessionChecks();

  authMod.onAuthStateChanged(auth, async (user) => {
    if (!user) {
      resetSessionState();
      currentUser = null; idToken = null; myProfile = null;
      setAuthStatus("Logged out");
      showScreen("auth");
      flushAuthNotice();
      return;
    }
    currentUser = user;
    try {
      await authToken();
    } catch (e) {
      // No token right now (offline at start-up, say): say so instead of hanging on the splash screen.
      console.error(e);
      if (!isDeadSession(e)) {
        currentUser = null;
        setAuthStatus("Offline", "err");
        showMsg("authMsg", "Couldn't reach the server. Check your connection and refresh.", "err");
        showScreen("auth");
      }
      return;
    }

    try {
      myProfile = await fsGet("users", user.uid);
      if (!myProfile && signupInFlight) {
        // The signup handler is writing this profile right now — this is
        // just the listener winning a race against it. Wait briefly and
        // look again.
        await new Promise(r => setTimeout(r, 700));
        myProfile = await fsGet("users", user.uid);
      }
      if (!myProfile) {
        // An account with no profile document. Every account created before
        // the database-address fix looks like this (the Auth account was
        // created, then the profile write 404'd), and an interrupted signup
        // can leave the same state. Create the profile now, so such accounts
        // heal themselves on their next login with no manual cleanup.
        myProfile = await createMissingProfile(user);
      }
      if (!myProfile) {
        // Last-resort safety net: if the profile document still can't be
        // created (no connection, rules not published...), let the person
        // into the app on a local-only placeholder rather than stranding a
        // real account at the login box. Nothing in it is saved anywhere;
        // enterApp() shows a visible notice while this is the case, and the
        // browser console has the real error from createMissingProfile().
        myProfile = { id: user.uid, ...defaultProfileFor(user.email), _unsaved: true };
      }
      myProfile = normalizeProfile(myProfile);
      setAuthStatus(myProfile.displayName || user.email, "ok");
      showScreen("app");
      enterApp();
    } catch (e) {
      console.error(e);
      setAuthStatus("Error loading profile", "err");
      const dbMissing = String(e && e.message).includes("firestore-database-missing");
      showMsg("authMsg", dbMissing
        ? "This app can't find its Firestore database. In the Firebase console for this project, create a Firestore database (Native mode) and publish the security rules."
        : "Couldn't load your profile. Check your connection and refresh.", "err");
      showScreen("auth");
    }
  });
}

// What a brand-new profile document contains. Used by the signup box and by
// createMissingProfile(). Deliberately NO email field: profile documents are
// readable by every signed-in user (Discover needs that), so anything stored
// here is visible to other members. `verified` must stay present — the
// security rules compare it on every profile update.
function defaultProfileFor(email) {
  const base = String(email || "").split("@")[0] || "New member";
  return {
    displayName: base.slice(0, 40), age: 18, gender: "", preference: "Everyone",
    course: "", department: "", year: "", bio: "",
    interests: [], photos: [], blocked: [], saved: [],
    verified: true, createdAt: new Date().toISOString()
  };
}

async function createMissingProfile(user) {
  try {
    await fsCreate("users", user.uid, defaultProfileFor(user.email));
  } catch (e) {
    // 409 = it already exists (the signup handler or another tab just
    // created it) — fine, just read it below. Anything else is a real
    // failure: log it and let the caller fall back.
    if (e.status !== 409) {
      console.error("Couldn't create the missing profile document:", e);
      return null;
    }
  }
  try { return await fsGet("users", user.uid); }
  catch (e) { console.error(e); return null; }
}

// Fill in anything an older or partial profile document lacks, so the rest of
// the app can rely on these being arrays.
function normalizeProfile(p) {
  const out = { ...p };
  for (const k of ["interests", "photos", "blocked", "saved"]) {
    if (!Array.isArray(out[k])) out[k] = [];
  }
  out.displayName = out.displayName || "New member";
  return out;
}

// ============================================================================
// SIGNUP / LOGIN / LOGOUT
// ============================================================================
function populateDeptSelect(selectEl) {
  selectEl.innerHTML = '<option value="">Select department</option>';
  for (const [school, depts] of Object.entries(DEPARTMENT_GROUPS)) {
    const og = document.createElement("optgroup");
    og.label = school;
    depts.forEach(d => {
      const o = document.createElement("option");
      o.value = d; o.textContent = d;
      og.appendChild(o);
    });
    selectEl.appendChild(og);
  }
}

// wireAuthScreen: sets up the one auth box (email + password → loginBtn
// below). There used to be a separate signup form/screen here (name,
// course, department, etc. collected up front, behind a "Sign up" link) —
// removed because a dedicated signup step was friction students disliked.
// Account creation now happens transparently the first time someone's
// email/password combination doesn't match an existing account — see the
// loginBtn handler. Anything collected on the old signup form (course,
// department, bio...) is now filled in later from the Profile tab instead.
function wireAuthScreen() {
  // Single box: email + password, no separate "sign up" screen. First time
  // a TUM email is used, there's no account yet, so Firebase Auth rejects
  // the sign-in with "user not found" (older SDKs) or "invalid credential"
  // (current SDKs intentionally use the same vague error for both "no such
  // user" and "wrong password", so a bad password on a real account can
  // also land here — see the comment further down on why that's an
  // acceptable, explained tradeoff for now). Either way, we try creating
  // the account next. If an account genuinely exists and the person just
  // mistyped their password, account creation itself fails with
  // "email-already-in-use", and THAT'S how we tell the two cases apart and
  // show the right message.
  document.getElementById("loginBtn").onclick = async () => {
    const email = clean(document.getElementById("loginEmail").value, 150).toLowerCase();
    const password = document.getElementById("loginPassword").value;
    if (!email || !password) return showMsg("authMsg", "Enter your email and password.", "err");

    const btn = document.getElementById("loginBtn");
    btn.disabled = true;
    try {
      const authMod = window.__fbAuthMod;
      try {
        await authMod.signInWithEmailAndPassword(auth, email, password);
        return; // existing account, logged in — done.
      } catch (signInErr) {
        const code = signInErr.code;
        const looksLikeNoAccount = code === "auth/user-not-found" || code === "auth/invalid-credential";
        if (!looksLikeNoAccount) throw signInErr; // some other real error — handled below.

        // No account yet for this email — this is this person's first
        // time, so create one now instead of making them go through a
        // separate signup screen. Any valid email works now (not just
        // TUM student emails), plus an 8+ character password.
        if (!studentEmailValid(email)) {
          showMsg("authMsg", "Enter a valid email address.", "err");
          return;
        }
        if (String(password).length < 8) {
          showMsg("authMsg", "First time? Choose a password with at least 8 characters.", "err");
          return;
        }

        let cred;
        try {
          cred = await authMod.createUserWithEmailAndPassword(auth, email, password);
        } catch (createErr) {
          if (createErr.code === "auth/email-already-in-use") {
            // An account DOES exist — the original sign-in failure above
            // was really just a wrong password, not "no account".
            showMsg("authMsg", "Incorrect email or password.", "err");
            return;
          }
          throw createErr;
        }

        signupInFlight = true;
        idToken = await cred.user.getIdToken();
        // Minimal profile — just enough to use the app. The rest (name,
        // course, department, bio, photos...) gets filled in from the
        // Profile tab, same data as before, just collected after entry
        // instead of before it.
        try {
          await fsCreate("users", cred.user.uid, defaultProfileFor(email));
          // onAuthStateChanged fires automatically and routes into the app.
        } catch (fsErr) {
          // Deliberately NOT re-thrown — the Firebase Auth account exists
          // either way. If this write failed (dropped connection, security
          // rules not published...), the auth listener's
          // createMissingProfile() tries once more as it fires, and only
          // then falls back to a local-only placeholder profile. The
          // console has the real error.
          console.error("Profile create failed (the sign-in listener will retry):", fsErr);
        } finally {
          // Must reset on BOTH success and failure — if left true after a
          // successful create, every later unrelated login would wrongly
          // behave as if a signup were still in flight (see the listener's
          // signupInFlight check further up for what that flag guards).
          signupInFlight = false;
        }
      }
    } catch (e) {
      console.error(e);
      if (e.code === "auth/weak-password") {
        showMsg("authMsg", "Choose a password with at least 8 characters.", "err");
      } else if (e.code === "auth/invalid-email") {
        showMsg("authMsg", "That doesn't look like a valid email.", "err");
      } else {
        showMsg("authMsg", "Couldn't log you in. Check your connection and try again.", "err");
      }
    } finally {
      btn.disabled = false;
    }
  };

  // doLogout() lives in the app-shell section below.
  document.getElementById("logoutBtn").onclick = () => doLogout();
}

// ============================================================================
// APP SHELL — panels, routing, small UI helpers
// ============================================================================
const $ = (id) => document.getElementById(id);

// Panel name (used in the URL hash: index.html#discover) -> element id.
const PANELS = {
  home: "homePanel", discover: "discoverPanel", matches: "matchesPanel", admirers: "admirersPanel",
  saved: "savedPanel", icebreakers: "icebreakersPanel", dates: "datesPanel", bio: "bioPanel",
  checkin: "checkinPanel", scam: "scamPanel", safety: "safetyPanel", profile: "profilePanel"
};
// Which top-bar link lights up while a tool page is open.
const NAV_GROUP = { saved: "home", icebreakers: "home", dates: "home", bio: "home", checkin: "safety", scam: "safety" };

let appEntered = false;
let currentPanel = "home";

// Per-login state — everything below is wiped by resetSessionState().
const userCache = new Map();          // uid -> profile document
let social = freshSocial();           // who I liked, who liked me (see refreshSocial)
let discoverQueue = [];               // everyone I can see, in a stable order. A swipe never removes anyone from it.
let discoverPos = 0;                  // index in discoverQueue of the card on top
let discoverHistory = [];             // ids of the cards I moved past, newest last (the Back button walks this)
let decisionLock = false;
let dismissedIds = new Set();         // profiles I passed on (kept on this device only, newest 200)
let currentChatPartner = null;
let chatSession = 0;                  // bumps whenever a chat opens/closes, so late async results can be ignored
let chatUnsub = null;
let chatMsgs = new Map();
let chatBannerDismissed = false;
let bioSeed = 0;
// A like or a take-back that is running for one person: uid -> { kind: "like" | "takeback", promise }.
const likeBusy = new Map();

function freshSocial() {
  // rev goes up whenever I change a like myself, so a slower refresh that started earlier can be recognised as stale.
  return { liked: new Set(), likedBy: new Set(), likedAt: {}, likedByAt: {}, admirers: [], matchUsers: [], savedUsers: [], pendingUsers: [], loadedAt: 0, rev: 0 };
}

function resetSessionState() {
  stopChatListener();
  userCache.clear();
  social = freshSocial();
  likeBusy.clear();
  deletingAccount = false;
  discoverQueue = []; discoverPos = 0; discoverHistory = [];
  decisionLock = false;
  dismissedIds = new Set();
  currentChatPartner = null; chatMsgs = new Map(); chatSession++;
  chatBannerDismissed = false;
  document.body.classList.remove("in-chat");
  if (appEntered) { try { closeChatView(); closeOpenDialogs(); } catch (_) {} }
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
}

async function doLogout() {
  await window.__fbAuthMod.signOut(auth);
}

function enterApp() {
  if (!appEntered) {
    appEntered = true;
    wireShell();
    populateDeptSelect($("profileDept"));
    wireDialogs();
    wireDiscover();
    wireMatches();
    wireAdmirers();
    wireSaved();
    wireIcebreakers();
    wireDates();
    wireBio();
    wireCheckin();
    wireScam();
    wireSafety();
    wireProfile();
    wireDeleteAccount();
    wirePush();
    window.addEventListener("hashchange", onHashChange);
  }
  dismissedIds = loadDismissed();
  $("homeNotice").hidden = !myProfile._unsaved;
  fillProfileForm();
  renderPhotoGrid();
  renderInterestGrid();
  renderProfileHeader();
  renderBioInterests();
  renderSavedPill();
  renderPushState();
  renderHome();
  const first = panelFromHash() || "home";
  activatePanel(first, { replace: true, initial: true });
  loadEverything();
}

async function loadEverything() {
  const ok = await refreshSocial(true);
  await loadDiscover(ok);
  await Promise.all([loadMatches(), renderAdmirers(), renderSaved()]);
  renderHome();
}

function panelFromHash() {
  const h = (location.hash || "").replace(/^#/, "");
  return PANELS[h] ? h : "";
}
function onHashChange() {
  if (!currentUser || !appEntered) return;
  activatePanel(panelFromHash() || "home");
}
function goPanel(name) {
  if (!PANELS[name]) name = "home";
  if (panelFromHash() === name) activatePanel(name);
  else location.hash = name;
}

function activatePanel(name, opts = {}) {
  if (!PANELS[name]) name = "home";
  if (currentPanel === "matches" && name !== "matches") closeChatView();
  currentPanel = name;
  document.body.dataset.panel = name;   // lets the stylesheet move things out of the way per screen (toasts on Discover)
  document.querySelectorAll("#appScreen .panel").forEach(p => p.classList.toggle("active", p.id === PANELS[name]));
  const group = NAV_GROUP[name] || name;
  document.querySelectorAll("#mainNav .tab").forEach(t => {
    const on = t.dataset.panel === group;
    t.classList.toggle("active", on);
    if (on) {
      t.setAttribute("aria-current", "page");
      if (t.scrollIntoView) t.scrollIntoView({ inline: "center", block: "nearest" });
    } else {
      t.removeAttribute("aria-current");
    }
  });
  if (opts.replace) history.replaceState(null, "", "#" + name);
  window.scrollTo(0, 0);
  if (!opts.initial) {
    const h = document.querySelector(`#${PANELS[name]} [data-heading]`);
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
    // Coming back to a panel: refresh whatever other people may have changed.
    if (name === "home" || name === "matches" || name === "admirers") refreshSocialAndRender();
  }
  if (name === "icebreakers") renderMatchOpeners();
  if (name === "profile") renderProfileHeader();
  if (name === "discover") {
    refreshDeckLabels();   // my own likes, saves and passes made on other screens
    if (!opts.initial) {
      // Other people may have liked me (or liked me back) since I was last here. The order of the
      // deck stays as it is; only the labels and the Home counts catch up.
      refreshSocial(false).then(ok => { if (ok && currentPanel === "discover") { refreshDeckLabels(); renderHome(); } });
    }
  }
}

async function refreshSocialAndRender() {
  const ok = await refreshSocial(false);
  if (!ok) return;
  await Promise.all([loadMatches(), renderAdmirers()]);
  renderHome();
}

function wireShell() {
  // Anything with data-go="panel" navigates: top-bar links, hub cards, stats,
  // buttons inside empty states.
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-go]");
    if (!t || !currentUser) return;
    if (t.tagName === "A") e.preventDefault();
    closeOpenDialogs();
    goPanel(t.dataset.go);
  });
  $("savedPill").onclick = () => goPanel("saved");
  $("fab").onclick = () => openDialog("quickSheet");
  $("logoutBtn2").onclick = () => doLogout();
  document.addEventListener("keydown", onGlobalKey);
  $("nudgeBtn").onclick = () => goPanel("profile");
  $("inviteBtn").onclick = shareInvite;
  $("homeInviteBtn").onclick = shareInvite;
  $("homeRetry").onclick = () => { $("homeNotice").hidden = true; location.reload(); };
}

function onGlobalKey(e) {
  if (currentPanel !== "discover" || e.altKey || e.ctrlKey || e.metaKey) return;
  const t = e.target;
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if (document.querySelector("dialog[open]")) return;
  if (e.key === "ArrowRight") { e.preventDefault(); triggerDecision("like"); }
  else if (e.key === "ArrowLeft") { e.preventDefault(); triggerDecision("pass"); }
}

// ----------------------------------------------------------------------------
// Small UI helpers: toasts, dialogs, time, avatars, clipboard
// ----------------------------------------------------------------------------
// toast(text, kind, { action: { label, onClick }, ms }): a short message at the bottom of the screen.
// With an action it gets a button (Undo, Try again) and stays a little longer.
function toast(text, kind, opts = {}) {
  const host = $("toasts");
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "") + (opts.action ? " has-action" : "");
  const msg = document.createElement("span");
  msg.className = "toast-text";
  msg.textContent = text;
  el.appendChild(msg);
  let timer = 0;
  const dismiss = () => { clearTimeout(timer); el.classList.add("out"); setTimeout(() => el.remove(), 260); };
  if (opts.action) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "toast-btn"; b.textContent = opts.action.label;
    b.onclick = () => { b.disabled = true; dismiss(); opts.action.onClick(); };
    el.appendChild(b);
  }
  host.appendChild(el);
  while (host.children.length > 3) host.firstChild.remove();
  timer = setTimeout(dismiss, opts.ms || (kind === "err" ? 5200 : 3200));
}

function openDialog(id) {
  const d = $(id);
  if (!d || d.open) return d;
  if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  return d;
}
function closeDialog(id) {
  const d = $(id);
  if (d && d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); }
}
function closeOpenDialogs() {
  document.querySelectorAll("dialog[open]").forEach(d => { if (typeof d.close === "function") d.close(); });
}

// One reusable confirm/prompt dialog (replaces the browser's alert/confirm/
// prompt boxes, which look out of place and block the whole page).
function askDialog({ title, body, okLabel, cancelLabel, danger, input }) {
  const dlg = $("uiDialog");
  return new Promise(resolve => {
    if (typeof dlg.showModal !== "function") {
      if (input) { const v = window.prompt(body || title); return resolve(v && v.trim() ? v.trim() : null); }
      return resolve(window.confirm(body || title));
    }
    $("uiTitle").textContent = title || "";
    $("uiBody").textContent = body || "";
    const ta = $("uiInput");
    ta.hidden = !input;
    ta.value = "";
    ta.placeholder = (input && input.placeholder) || "";
    ta.maxLength = (input && input.maxLength) || 500;
    ta.required = !!input;
    const ok = $("uiOk");
    ok.textContent = okLabel || "OK";
    ok.classList.toggle("danger", !!danger);
    $("uiCancel").textContent = cancelLabel || "Cancel";
    const onClose = () => {
      dlg.removeEventListener("close", onClose);
      const accepted = dlg.returnValue === "ok";
      resolve(accepted ? (input ? ta.value.trim() : true) : (input ? null : false));
    };
    dlg.addEventListener("close", onClose);
    dlg.returnValue = "";
    dlg.showModal();
    if (input) ta.focus();
  });
}
const uiConfirm = (body, opts = {}) => askDialog({ title: opts.title || "Are you sure?", body, okLabel: opts.okLabel, cancelLabel: opts.cancelLabel, danger: opts.danger });
const uiPrompt = (body, opts = {}) => askDialog({ title: opts.title || "Tell us more", body, okLabel: opts.okLabel || "Send", input: { placeholder: opts.placeholder, maxLength: opts.maxLength } });

function wireDialogs() {
  // Click on the dark backdrop closes any dialog (the dialog element itself is
  // the click target there; its content wrapper fills the rest).
  document.querySelectorAll("dialog").forEach(d => {
    d.addEventListener("click", (e) => { if (e.target === d && typeof d.close === "function") d.close(); });
  });
  $("pdClose").onclick = () => closeDialog("profileDialog");
  $("matchKeep").onclick = () => closeDialog("matchDialog");
  document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeOpenDialogs()));
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function clockTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}
function dayLabel(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const today = new Date(); const yday = new Date(); yday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function firstName(u) { return String((u && u.displayName) || "").trim().split(/\s+/)[0] || "them"; }
function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}
function photosOf(u) { return (u.photos || []).map(safePhotoUrl).filter(Boolean); }
function avatarHTML(u, cls) {
  const url = photosOf(u)[0];
  return `<span class="av ${cls || ""}" role="img" aria-label="${esc(u.displayName || "Member")}"${url ? ` style="background-image:url('${url}')"` : ""}>${url ? "" : esc(initialsOf(u.displayName))}</span>`;
}
function paintAvatar(el, u) {
  const url = photosOf(u)[0];
  el.style.backgroundImage = url ? `url('${url}')` : "";
  el.textContent = url ? "" : initialsOf(u.displayName);
  el.setAttribute("aria-label", u.displayName || "Member");
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch (_) { return false; }
}
async function copyWithToast(text, okMsg) {
  const ok = await copyText(text);
  toast(ok ? (okMsg || "Copied") : "Couldn't copy. Select the text and copy it by hand.", ok ? "" : "err");
}

async function shareInvite() {
  const url = location.origin + "/";
  const text = "Join me on TUMingle — meet people on campus, with safety tools built in.";
  if (navigator.share) {
    try { await navigator.share({ title: "TUMingle", text, url }); return; }
    catch (e) { if (e && e.name === "AbortError") return; }
  }
  await copyWithToast(`${text} ${url}`, "Invite copied. Paste it into WhatsApp or anywhere.");
}

// ============================================================================
// WHO LIKED WHOM
// One pair of queries gives everything: people I liked, people who liked me.
// Matches are the overlap, admirers are "liked me, I haven't answered".
// ============================================================================
async function refreshSocial(force) {
  if (!force && Date.now() - social.loadedAt < 15000) return true;
  try {
    const me = currentUser.uid;
    const mine = social, rev = mine.rev;
    const [fromMe, toMe] = await Promise.all([
      fsQuery("likes", { where: fieldFilter("from", "EQUAL", me) }),
      fsQuery("likes", { where: fieldFilter("to", "EQUAL", me) })
    ]);
    // Logged out (or switched account) while this was loading: the answer belongs to nobody now.
    if (mine !== social) return false;
    // I liked or took back a like while this was loading: what I know locally is newer than this answer.
    // (loadedAt stays old, so the next refresh asks again.)
    if (mine.rev !== rev) return true;
    social.liked = new Set(fromMe.map(l => l.to));
    social.likedAt = Object.fromEntries(fromMe.map(l => [l.to, l.createdAt]));
    social.likedBy = new Set(toMe.map(l => l.from));
    social.likedByAt = Object.fromEntries(toMe.map(l => [l.from, l.createdAt]));
    social.loadedAt = Date.now();
    return true;
  } catch (e) {
    console.error("refreshSocial failed:", e);
    return false;
  }
}
function matchIds() { return [...social.liked].filter(id => social.likedBy.has(id)); }
function matchedAt(id) {
  return Math.max(Date.parse(social.likedAt[id]) || 0, Date.parse(social.likedByAt[id]) || 0);
}

async function getUser(id) {
  if (userCache.has(id)) return userCache.get(id);
  const u = await fsGet("users", id);
  if (!u || u.deleted === true) return null;   // gone, or blanked by "Delete my account"
  const n = normalizeProfile(u);
  userCache.set(id, n);
  return n;
}

// ============================================================================
// COMPATIBILITY — plain arithmetic on what's on both profiles, nothing hidden:
// up to 15 points for each shared interest (4 count), 25 for the same
// department, 15 for the same year of study. Shown as "NN% match" with the
// reasons spelled out under it.
// ============================================================================
function compat(u) {
  const mine = new Set(myProfile.interests || []);
  const shared = (u.interests || []).filter(t => mine.has(t));
  const sameDept = !!(myProfile.department && u.department && myProfile.department === u.department);
  const norm = v => String(v || "").trim().toLowerCase();
  const sameYear = !!(norm(myProfile.year) && norm(myProfile.year) === norm(u.year));
  const pct = Math.min(99, Math.min(shared.length, 4) * 15 + (sameDept ? 25 : 0) + (sameYear ? 15 : 0));
  return { pct, shared, sameDept, sameYear };
}
function whyLine(c) {
  const bits = [];
  if (c.shared.length) bits.push(`${c.shared.length} shared interest${c.shared.length > 1 ? "s" : ""}`);
  if (c.sameDept) bits.push("same department");
  if (c.sameYear) bits.push("same year");
  if (!bits.length) return (myProfile.interests || []).length ? "No shared interests yet" : "Add interests to your profile to see what you have in common";
  const s = bits.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Gender / "interested in" matching. The Profile form now uses fixed choices,
// but older or hand-typed values are normalised so a typo can't hide people.
function normGender(g) {
  const s = String(g || "").trim().toLowerCase();
  if (["woman", "women", "female", "girl", "f", "lady"].includes(s)) return "woman";
  if (["man", "men", "male", "boy", "m", "guy"].includes(s)) return "man";
  if (!s || /prefer/.test(s)) return "";
  return "other";
}
function normPref(p) {
  const s = String(p || "").trim().toLowerCase();
  if (["women", "woman", "female", "females", "girls", "girl", "ladies"].includes(s)) return "woman";
  if (["men", "man", "male", "males", "boys", "boy", "guys"].includes(s)) return "man";
  return "everyone"; // "everyone", blank, or anything unrecognised: never hide people over a typo
}
function wantsGender(pref, gender) { const p = normPref(pref); return p === "everyone" || p === normGender(gender); }
function prefersEachOther(a, b) { return wantsGender(a.preference, b.gender) && wantsGender(b.preference, a.gender); }

// ============================================================================
// DISCOVER / SWIPE
// ============================================================================
async function fetchUsersBatch() {
  // There's no practical way to say "not me, not already liked, not blocked"
  // as one Firestore query, so fetch a batch and filter here.
  return fsQuery("users", { limit: 100 });
}

// Where a person stands with me. Drives the label on their card in Discover.
function relationOf(id) {
  const liked = social.liked.has(id), likedBy = social.likedBy.has(id);
  if (liked && likedBy) return "matched";
  if (liked) return "liked";
  if ((myProfile.saved || []).includes(id)) return "saved";
  if (dismissedIds.has(id)) return "passed";
  return likedBy ? "admirer" : "new";
}
const RELATION_TEXT = { matched: "You are matched", liked: "You liked them", saved: "You saved them", passed: "You passed on them", admirer: "They like you" };

function currentCard() { return discoverQueue.length ? (discoverQueue[discoverPos] || null) : null; }
function canGoBack() { return discoverHistory.some(id => discoverQueue.some(u => u.id === id)); }

// Move the deck. Nobody is ever removed: after the last person it starts again from the first.
function stepDeck(dir) {
  const n = discoverQueue.length;
  if (n === 0) return;
  if (dir > 0) {
    if (n > 1) {
      discoverHistory.push(discoverQueue[discoverPos].id);
      if (discoverHistory.length > 60) discoverHistory.shift();
      if (discoverPos === n - 1) toast("That's everyone. Starting again from the first person.");
    }
    discoverPos = (discoverPos + 1) % n;
    return;
  }
  while (discoverHistory.length) {
    const id = discoverHistory.pop();            // (not inside the callback: findIndex would pop once per person)
    const i = discoverQueue.findIndex(u => u.id === id);
    if (i >= 0) { discoverPos = i; return; }
  }
}
// A like or save that failed: bring that person back to the top so it isn't silently lost.
function returnToCard(user) {
  const i = discoverQueue.findIndex(u => u.id === user.id);
  if (i < 0) return;
  // Rewind: the trail forgets everything after this person, so Back goes to whoever came before them.
  const k = discoverHistory.lastIndexOf(user.id);
  if (k >= 0) discoverHistory.length = k;
  discoverPos = i;
  renderStack();
  renderHome();
}
// Only blocking takes someone out of the deck.
function removeFromDeck(id) {
  const i = discoverQueue.findIndex(u => u.id === id);
  if (i < 0) return;
  discoverQueue.splice(i, 1);
  if (i < discoverPos) discoverPos--;
  if (discoverPos >= discoverQueue.length) discoverPos = 0;
  discoverHistory = discoverHistory.filter(x => x !== id);
}

async function loadDiscover(socialOk) {
  hideMsg("discoverMsg");
  const keep = currentCard() ? currentCard().id : null;   // stay on the same person across a reload
  try {
    const all = (await fetchUsersBatch()).filter(u => u.deleted !== true).map(normalizeProfile);
    all.forEach(u => userCache.set(u.id, u));
    const blocked = new Set(myProfile.blocked || []);
    // Everyone I'm allowed to see stays in the deck, whatever I did with them: liked,
    // passed and saved people keep their place and just carry a label.
    discoverQueue = all.filter(u => {
      if (u.id === currentUser.uid || blocked.has(u.id)) return false;
      if ((u.blocked || []).includes(currentUser.uid)) return false; // they blocked me
      return prefersEachOther(myProfile, u);
    });
    // Order: people who already like me, then people I haven't decided on (best interest
    // match first), then everyone else.
    const rank = u => {
      const r = relationOf(u.id);
      return (r === "admirer" ? 1000 : r === "new" ? 500 : 0) + compat(u).pct;
    };
    discoverQueue.sort((a, b) => rank(b) - rank(a));
    const at = keep ? discoverQueue.findIndex(u => u.id === keep) : -1;
    discoverPos = at >= 0 ? at : 0;
    discoverHistory = discoverHistory.filter(id => discoverQueue.some(u => u.id === id));
    if (socialOk === false) showMsg("discoverMsg", "Couldn't check who you've already liked, so some labels may be missing. Refresh to try again.", "info");
  } catch (e) {
    console.error(e);
    discoverQueue = []; discoverPos = 0; discoverHistory = [];
    showMsg("discoverMsg", "Couldn't load profiles. Check your connection and try again.", "err");
  }
  renderStack();
  renderHome();
}

// The small labels on a Discover card: where they stand with me. Kept in a slot of their own
// so refreshDeckLabels() can update them in place without rebuilding the card mid-swipe.
function badgesHTML(u) {
  const rel = relationOf(u.id);
  const likesYou = social.likedBy.has(u.id) && !social.liked.has(u.id);
  const left = rel === "matched" ? `<span class="badge likes">It's a match</span>`
    : likesYou ? `<span class="badge likes">💘 Likes you</span>` : "";
  const word = { liked: "Liked", saved: "Saved", passed: "Passed" }[rel];
  const right = word ? `<span class="badge status ${rel}">${word}</span>` : "";
  return left + right;
}

// One profile card — used by the swipe stack and the full-profile dialog.
function profileCardHTML(u, c, opts = {}) {
  const photos = photosOf(u);
  const first = photos[0];
  const multi = photos.length > 1;
  const dots = multi ? `<div class="photo-dots" aria-hidden="true">${photos.map((_, i) => `<i class="${i === 0 ? "on" : ""}"></i>`).join("")}</div>` : "";
  const zones = multi ? `<button type="button" class="photo-zone prev" aria-label="Previous photo"></button><button type="button" class="photo-zone next" aria-label="Next photo"></button>` : "";
  const badge = c.pct > 0 ? `<span class="badge compat" title="Based on shared interests, department and year">${c.pct}% match</span>` : "";
  const likes = opts.deck ? `<span class="badge-slot">${badgesHTML(u)}</span>`
    : opts.likesYou ? `<span class="badge likes">💘 Likes you</span>` : "";
  const stamps = opts.stamps ? `<span class="stamp like" aria-hidden="true">Like</span><span class="stamp nope" aria-hidden="true">Pass</span>` : "";
  const mineSet = new Set(myProfile.interests || []);
  const tags = (u.interests || []).map(i => `<span class="tag${mineSet.has(i) ? " shared" : ""}">${esc(i)}</span>`).join("");
  const study = [u.course, u.year].map(x => String(x || "").trim()).filter(Boolean).join(", ");
  return `
    <div class="card-photo${first ? "" : " no-photo"}"${first ? ` style="background-image:url('${first}')"` : ""} role="img" aria-label="${esc(first ? "Photo of " + u.displayName : "No photo yet for " + u.displayName)}">
      ${first ? "" : `<div class="initial" aria-hidden="true">${esc(initialsOf(u.displayName))}</div><div class="no-photo-note">No photo yet</div>`}
      ${dots}${zones}${likes}${badge}${stamps}
      <div class="photo-grad">
        <h3>${esc(u.displayName)}${u.age ? `, ${esc(u.age)}` : ""}</h3>
        <p>${esc(u.department || "Department not set")}</p>
      </div>
    </div>
    <div class="card-body">
      ${opts.hideWhy ? "" : `<p class="why">${esc(whyLine(c))}</p>`}
      ${study ? `<p class="study">${esc(study)}</p>` : ""}
      <p class="bio">${esc(u.bio || "No bio yet.")}</p>
      ${tags ? `<div class="tag-row">${tags}</div>` : ""}
    </div>`;
}

function wirePhotoPager(root, photos) {
  if (!photos || photos.length < 2) return;
  const photoEl = root.querySelector(".card-photo");
  const dots = [...root.querySelectorAll(".photo-dots i")];
  let i = 0;
  const show = (n) => {
    i = (n + photos.length) % photos.length;
    photoEl.style.backgroundImage = `url('${photos[i]}')`;
    dots.forEach((d, k) => d.classList.toggle("on", k === i));
  };
  root.querySelector(".photo-zone.prev").onclick = (e) => { e.stopPropagation(); show(i - 1); };
  root.querySelector(".photo-zone.next").onclick = (e) => { e.stopPropagation(); show(i + 1); };
}

function renderStack(opts = {}) {
  const stack = $("stack");
  const actions = document.querySelector("#discoverPanel .swipe-actions");
  const links = document.querySelector("#discoverPanel .discover-links");
  const bar = $("deckBar");
  stack.innerHTML = "";
  const n = discoverQueue.length;
  if (n === 0) {
    // Only when there is genuinely nobody to show (swiping never empties the deck).
    stack.className = "stack empty";
    actions.hidden = true; links.hidden = true; bar.hidden = true;
    stack.innerHTML = `
      <div class="empty-state big">
        <div class="empty-emoji" aria-hidden="true">🌴</div>
        <h3>No one to show yet</h3>
        <p>New people show up as more students join. Invite a friend to get things moving, or check back later.</p>
        <div class="empty-actions">
          <button class="btn btn-gold" id="emptyInvite">Invite a friend</button>
          <button class="btn ghost" id="emptyRefresh">Refresh</button>
        </div>
        <p class="empty-links"><button class="link-btn" data-go="admirers">See who likes you</button><button class="link-btn" data-go="profile">Edit your profile</button></p>
      </div>`;
    $("emptyInvite").onclick = shareInvite;
    $("emptyRefresh").onclick = async () => { await refreshSocial(true); await loadDiscover(); };
    return;
  }
  stack.className = "stack";
  actions.hidden = false; links.hidden = false; bar.hidden = false;
  discoverPos = Math.min(Math.max(discoverPos, 0), n - 1);
  const top = discoverQueue[discoverPos];
  const behind = n > 1 ? discoverQueue[(discoverPos + 1) % n] : null;
  [behind, top].forEach(u => {
    if (!u) return;
    const isTop = u === top;
    const rel = relationOf(u.id);
    const card = document.createElement("article");
    card.className = "swipe-card " + (isTop ? "top" : "behind") + (isTop && opts.enter === "back" ? " enter-back" : "");
    card.dataset.uid = u.id;
    card.innerHTML = profileCardHTML(u, compat(u), { deck: true, stamps: isTop });
    wirePhotoPager(card, photosOf(u));
    if (isTop) {
      card.setAttribute("aria-label", `${u.displayName}. ${RELATION_TEXT[rel] ? RELATION_TEXT[rel] + ". " : ""}Use the buttons below, or the left and right arrow keys, to pass or like.`);
      attachDrag(card, u);
    }
    stack.appendChild(card);
  });
  updateDeckControls();
}

// Buttons show where the person on top stands with me: Liked, Saved, Passed.
function updateDeckControls() {
  const u = currentCard();
  const rel = u ? relationOf(u.id) : "";
  const decided = rel === "liked" || rel === "matched";
  // pressed: true / false for a toggle, null when the button isn't a toggle right now.
  const set = (id, capId, pressed, caption, disabled) => {
    const b = $(id), cap = $(capId);
    b.classList.toggle("on", pressed === true);
    cap.classList.toggle("on", pressed === true);
    if (pressed === null) b.removeAttribute("aria-pressed");
    else b.setAttribute("aria-pressed", pressed ? "true" : "false");
    b.disabled = !!disabled;
    if (cap.textContent !== caption) cap.textContent = caption;
  };
  // Passing someone I already liked changes nothing, so that button honestly says "Next".
  set("passBtn", "passCap", decided ? null : rel === "passed", decided ? "Next" : rel === "passed" ? "Passed" : "Pass", false);
  $("passBtn").setAttribute("aria-label", decided ? "Next person" : "Pass");
  set("saveBtn", "saveCap", rel === "saved", rel === "saved" ? "Saved" : "Save", decided);
  set("likeBtn", "likeCap", decided, rel === "matched" ? "Matched" : decided ? "Liked" : "Like", false);
  if (rel === "liked") $("likeBtn").title = "Tap again to take back your like"; else $("likeBtn").removeAttribute("title");
  $("backBtn").disabled = !canGoBack();
  setDeckCount();
}

function setDeckCount() {
  const el = $("deckCount");
  const text = discoverQueue.length ? `${discoverPos + 1} of ${discoverQueue.length}` : "";
  if (el.textContent !== text) el.textContent = text;   // same text: don't make a screen reader repeat it
}

// Re-label the cards on screen after something changed, without rebuilding them
// (a rebuild would cut off a swipe that is in progress).
function refreshDeckLabels() {
  document.querySelectorAll("#stack .swipe-card").forEach(card => {
    const u = userCache.get(card.dataset.uid);
    const slot = card.querySelector(".badge-slot");
    if (u && slot) slot.innerHTML = badgesHTML(u);
  });
  if (discoverQueue.length) updateDeckControls();
}

function attachDrag(card, user) {
  const likeStamp = card.querySelector(".stamp.like");
  const nopeStamp = card.querySelector(".stamp.nope");
  const threshold = 90;
  let startX = 0, dx = 0, dragging = false, moved = false, pid = null, ignoreClickUntil = 0;

  card.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true; moved = false; startX = e.clientX; dx = 0; pid = e.pointerId;
    card.style.transition = "none";
  });
  card.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dx = e.clientX - startX;
    if (!moved && Math.abs(dx) > 6) {
      moved = true;
      try { card.setPointerCapture(pid); } catch (_) {}
    }
    if (!moved) return;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 22}deg)`;
    const p = Math.min(1, Math.abs(dx) / threshold);
    if (likeStamp) likeStamp.style.opacity = dx > 0 ? p : 0;
    if (nopeStamp) nopeStamp.style.opacity = dx < 0 ? p : 0;
  });
  const end = (e) => {
    if (!dragging || (e && e.pointerId !== pid)) return;
    dragging = false;
    if (!moved) return;
    ignoreClickUntil = Date.now() + 120; // swallow the click that follows a drag
    if (dx > threshold || dx < -threshold) {
      const action = dx > 0 ? "like" : "pass";
      card.style.transition = prefersReducedMotion() ? "none" : "transform .2s ease, opacity .2s ease";
      card.style.transform = `translateX(${dx > 0 ? 130 : -130}%) rotate(${dx > 0 ? 14 : -14}deg)`;
      card.style.opacity = "0";
      if (!decisionLock) { decisionLock = true; setTimeout(() => decide(user, action), prefersReducedMotion() ? 0 : 180); }
    } else {
      card.style.transition = "transform .22s ease";
      card.style.transform = "";
      if (likeStamp) likeStamp.style.opacity = 0;
      if (nopeStamp) nopeStamp.style.opacity = 0;
    }
  };
  card.addEventListener("pointerup", end);
  card.addEventListener("pointercancel", end);
  card.addEventListener("click", (e) => {
    if (Date.now() < ignoreClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Button/keyboard version of a swipe: animate the top card away, then decide.
function triggerDecision(action) {
  const u = currentCard();
  if (!u || decisionLock) return;
  decisionLock = true;
  // Save on someone who is already saved means "remove them from Saved"; the card stays put.
  if (action === "save" && relationOf(u.id) === "saved") { decide(u, "unsave"); return; }
  const card = document.querySelector("#stack .swipe-card.top");
  if (card && !prefersReducedMotion()) {
    const t = action === "like" ? "translateX(130%) rotate(14deg)" : action === "pass" ? "translateX(-130%) rotate(-14deg)" : "translateY(-120%) scale(.96)";
    card.style.transition = "transform .22s ease, opacity .22s ease";
    card.style.transform = t;
    card.style.opacity = "0";
    setTimeout(() => decide(u, action), 190);
  } else {
    decide(u, action);
  }
}

// Back: return to the person I just moved past.
function goBack() {
  if (decisionLock) return;
  const before = currentCard();
  stepDeck(-1);
  if (currentCard() === before) return;
  renderStack({ enter: "back" });
  renderHome();
}

// Nobody is removed from the deck by a decision. The deck moves on to the next person; the
// one I just dealt with keeps their place and comes around again, labelled Liked, Saved or Passed.
async function decide(user, action) {
  decisionLock = false;
  const rel = relationOf(user.id);
  const first = firstName(user);

  if (action === "unsave") {
    await unsaveProfile(user.id);     // stays on this person
    refreshDeckLabels();
    return;
  }

  // Move on first so a swipe always feels instant. (Only if they are still the card on top:
  // if the deck was rebuilt in the meantime, leave it where it is.)
  if (currentCard() && currentCard().id === user.id) stepDeck(1);

  if (action === "pass") {
    let p = null;
    // Passing someone I already liked changes nothing (a like can't be taken back this way): it just moves on.
    if (rel !== "liked" && rel !== "matched") {
      dismissUser(user.id);
      if (rel === "saved") p = unsaveProfile(user.id, { quiet: true });   // a decision settles it: off the shortlist
    }
    renderStack(); renderHome();
    if (p) await p;
  } else if (action === "like") {
    renderStack(); renderHome();
    if (rel === "liked" || rel === "matched") {
      toast(rel === "matched" ? `You and ${first} are already matched.` : `You already liked ${first}.`);
    } else {
      await likeUser(user, { fromDeck: true });
    }
  } else if (action === "save") {
    undismissUser(user.id);
    renderStack(); renderHome();
    await saveProfile(user, { fromDeck: true });
  }
  refreshDeckLabels();
}

// Create my like. Returns true when it completes a match.
async function createLike(otherId) {
  const me = currentUser.uid;
  try {
    await fsCreate("likes", `${me}_${otherId}`, { from: me, to: otherId, createdAt: new Date().toISOString() });
  } catch (e) {
    if (e.status !== 409) throw e; // 409: already liked — treat as success
  }
  social.liked.add(otherId);
  social.likedAt[otherId] = new Date().toISOString();
  social.rev++;
  // Fresh check rather than trusting the cached list: they may have liked me a second ago.
  // (If this one look-up fails the like is already sent, so fall back on what I knew.)
  let back = null;
  try { back = await fsGet("likes", `${otherId}_${me}`); }
  catch (e) { console.error(e); if (social.likedBy.has(otherId)) back = { createdAt: social.likedByAt[otherId] }; }
  if (back) {
    social.likedBy.add(otherId);
    social.likedByAt[otherId] = back.createdAt;
    return true;
  }
  return false;
}

// Sending or taking back a like for one person never overlaps another for the same person:
// a second tap while the first is running is ignored, and Undo waits for the like it undoes.
async function likeUser(user, { fromDeck } = {}) {
  if (likeBusy.has(user.id)) return false;
  const promise = doLike(user, !!fromDeck);
  likeBusy.set(user.id, { kind: "like", promise });
  try { return await promise; } finally { likeBusy.delete(user.id); }
}

// Returns true when the like went through.
async function doLike(user, fromDeck) {
  // Where they were before this like, so Undo can put them back there (Saved shortlist, Passed).
  const undo = { restore: { wasSaved: (myProfile.saved || []).includes(user.id), wasPassed: dismissedIds.has(user.id) }, fromDeck };
  let matched;
  try {
    matched = await createLike(user.id);
  } catch (e) {
    console.error(e);
    toast("Couldn't send that like. Check your connection and try again.", "err");
    if (fromDeck) returnToCard(user);   // put them back on top so the like isn't silently lost
    refreshDeckLabels();
    return false;
  }
  // From here the like is saved; anything that goes wrong below is only a screen that didn't refresh.
  undismissUser(user.id);               // a like replaces an earlier pass
  if (matched) {
    try { await onMatch(user, undo); } catch (e) { console.error(e); }
  } else {
    toast(`You liked ${firstName(user)}.`, "", { ms: 7000, action: { label: "Undo", onClick: () => takeBackLike(user, undo) } });
    try { await Promise.all([renderAdmirers(), renderSaved(), renderPending()]); renderHome(); } catch (e) { console.error(e); }
  }
  // A like settles it, so they leave my Saved shortlist (Undo puts them back).
  if (undo.restore.wasSaved) { try { await unsaveProfile(user.id, { quiet: true }); } catch (e) { console.error(e); } }
  refreshDeckLabels();
  return true;
}

// Take my like back. Undo (right after a like) passes `restore`: where they were before I liked them,
// so someone I had saved or passed on goes back there. A later take-back just makes them someone I
// haven't decided on. Returns true once the like is gone.
async function takeBackLike(user, { restore, fromDeck } = {}) {
  const running = likeBusy.get(user.id);
  if (running) {
    if (running.kind === "takeback") return false;       // already on its way
    await running.promise.catch(() => {});                // let the like finish first, then undo it
    if (likeBusy.has(user.id)) return false;
  }
  const promise = doTakeBack(user, { restore, fromDeck });
  likeBusy.set(user.id, { kind: "takeback", promise });
  try { return await promise; } finally { likeBusy.delete(user.id); }
}

async function doTakeBack(user, { restore, fromDeck }) {
  const id = user.id;
  if (!social.liked.has(id)) return true;                 // nothing left to take back
  const wasMatch = social.likedBy.has(id);
  try {
    if (!(await fsDelete("likes", `${currentUser.uid}_${id}`))) throw new Error("the like was not removed");
  } catch (e) {
    console.error(e);
    toast("Couldn't take back that like. Check your connection and try again.", "err",
      { ms: 7000, action: { label: "Try again", onClick: () => takeBackLike(user, { restore, fromDeck }) } });
    return false;
  }
  social.liked.delete(id);
  delete social.likedAt[id];
  social.rev++;
  toast(restore ? "Like undone." : `You took back your like for ${firstName(user)}.`);
  try {
    if (wasMatch) {
      // The chat only existed because of the match.
      if (currentChatPartner && currentChatPartner.id === id) closeChatView();
      await deleteChatWith(id);
    }
  } catch (e) { console.error(e); }
  if (restore && restore.wasPassed) dismissUser(id);
  try {
    if (restore && restore.wasSaved) await saveProfile(user, { quiet: true });
    await Promise.all([wasMatch ? loadMatches() : renderPending(), renderAdmirers(), renderSaved()]);
    renderHome();
  } catch (e) { console.error(e); }
  if (fromDeck && currentPanel === "discover") returnToCard(user); else refreshDeckLabels();
  return true;
}

async function onMatch(user, undo) {
  showMatchDialog(user, undo);
  await Promise.all([loadMatches(), renderAdmirers(), renderSaved()]);
  renderHome();
  sendPushToUser(user.id, { title: "New match!", body: `You and ${myProfile.displayName} matched on TUMingle.` });
}

// Profiles I pass on are remembered on THIS device (newest 200). In Discover they stay in
// the deck with a "Passed" label; in Admirers, "Not now" hides them from that list.
// Deliberately not stored in Firestore: profile documents are readable by every
// signed-in member, and "who I passed on" shouldn't be.
function dismissKey() { return "tum_passed_" + (currentUser ? currentUser.uid : ""); }
function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(dismissKey()) || "[]")); }
  catch (_) { return new Set(); }
}
function saveDismissed() {
  try { localStorage.setItem(dismissKey(), JSON.stringify([...dismissedIds].slice(-200))); }
  catch (_) { /* storage blocked: passes just last for this visit */ }
}
function dismissUser(id) {
  dismissedIds.delete(id);
  dismissedIds.add(id);
  dismissedIds = new Set([...dismissedIds].slice(-200));
  saveDismissed();
}
function undismissUser(id) {
  if (!dismissedIds.has(id)) return;
  dismissedIds.delete(id);
  saveDismissed();
}

function wireDiscover() {
  $("likeBtn").onclick = () => {
    const u = currentCard();
    // A filled heart is a toggle: tap it again to take the like back (this card stays on screen).
    if (u && relationOf(u.id) === "liked") { takeBackLike(u); return; }
    triggerDecision("like");
  };
  $("passBtn").onclick = () => triggerDecision("pass");
  $("saveBtn").onclick = () => triggerDecision("save");
  $("backBtn").onclick = goBack;
  $("blockProfileBtn").onclick = () => { const u = currentCard(); if (u) blockUser(u); };
  $("reportProfileBtn").onclick = () => { const u = currentCard(); if (u) reportUser(u); };
}

// ----------------------------------------------------------------------------
// Saved (a shortlist kept on my own profile document)
// ----------------------------------------------------------------------------
function renderSavedPill() {
  const n = (myProfile.saved || []).length;
  $("savedCount").textContent = n;
  const b = $("badgeSaved");
  b.textContent = n; b.hidden = n === 0;
}

async function saveProfile(user, { fromDeck, quiet } = {}) {
  const saved = Array.from(new Set([...(myProfile.saved || []), user.id])).slice(-60);
  const before = myProfile.saved || [];
  myProfile.saved = saved;
  renderSavedPill();
  try {
    if (!myProfile._unsaved) await fsSet("users", currentUser.uid, { saved });
    if (!quiet) toast(`${firstName(user)} saved to your shortlist.`);
    await renderSaved();
    renderHome();
  } catch (e) {
    console.error(e);
    myProfile.saved = before;
    renderSavedPill();
    toast("Couldn't save that profile. Try again.", "err");
    if (fromDeck) returnToCard(user);
  }
}

async function unsaveProfile(id, { quiet } = {}) {
  const before = myProfile.saved || [];
  myProfile.saved = before.filter(x => x !== id);
  renderSavedPill();
  try {
    if (!myProfile._unsaved) await fsSet("users", currentUser.uid, { saved: myProfile.saved });
    if (!quiet) toast("Removed from Saved.");
  } catch (e) {
    console.error(e);
    myProfile.saved = before;
    renderSavedPill();
    toast("Couldn't update your Saved list. Try again.", "err");
  }
  await renderSaved();
  renderHome();
}

// ----------------------------------------------------------------------------
// Block / report
// ----------------------------------------------------------------------------
async function removeConnection(otherId) {
  const me = currentUser.uid;
  // Remove BOTH like directions — a match only exists while both exist, so
  // leaving either behind would silently resurrect it.
  const likeResults = await Promise.all([
    fsDelete("likes", `${me}_${otherId}`),
    fsDelete("likes", `${otherId}_${me}`)
  ]);
  if (likeResults.some(ok => !ok)) throw new Error("Couldn't remove the like records");
  await deleteChatWith(otherId);
  social.liked.delete(otherId); social.likedBy.delete(otherId);
  delete social.likedAt[otherId]; delete social.likedByAt[otherId];
  social.rev++;
}

// Delete every message between me and them (both directions).
async function deleteChatWith(otherId) {
  const me = currentUser.uid;
  const [mine, theirs] = await Promise.all([
    fetchDirectionWithIds(me, otherId),
    fetchDirectionWithIds(otherId, me)
  ]);
  const results = await Promise.all([...mine, ...theirs].map(m => fsDelete("messages", m.id)));
  if (results.some(ok => !ok)) throw new Error("Couldn't delete every message");
}

async function blockUser(u, { fromChat } = {}) {
  const ok = await uiConfirm(
    `You won't see ${u.displayName} and they won't see you.${fromChat ? " Your match and chat history will be deleted." : ""}`,
    { title: `Block ${u.displayName}?`, okLabel: "Block", danger: true });
  if (!ok) return false;
  try {
    const blocked = Array.from(new Set([...(myProfile.blocked || []), u.id]));
    await fsSet("users", currentUser.uid, { blocked });
    myProfile.blocked = blocked;
    await removeConnection(u.id);
    removeFromDeck(u.id);
    if (fromChat) closeChatView();
    renderStack();
    await Promise.all([loadMatches(), renderAdmirers(), renderSaved(), renderBlockedList()]);
    renderHome();
    toast(`${firstName(u)} is blocked.`);
    return true;
  } catch (e) {
    console.error(e);
    toast("Couldn't block this profile right now. Try again.", "err");
    return false;
  }
}

async function reportUser(u) {
  const reason = await uiPrompt(
    `Tell us what happened with ${u.displayName}. Reports are private.`,
    { title: `Report ${u.displayName}`, placeholder: "What happened?", okLabel: "Send report" });
  if (!reason) return;
  try {
    await fsCreate("reports", `${currentUser.uid}_${u.id}_${Date.now()}`, {
      type: "user", reporterUid: currentUser.uid, reportedUid: u.id,
      reason: clean(reason, 500), status: "open", createdAt: new Date().toISOString()
    });
    toast("Report sent. Thank you.");
  } catch (e) {
    console.error(e);
    toast("Couldn't send the report. Try again.", "err");
  }
}

// ----------------------------------------------------------------------------
// Delete my account: everything of mine in the database, then the login itself
// ----------------------------------------------------------------------------
// Delete every document a query finds, repeating until none are left (one query returns at most 300).
async function deleteAllWhere(collection, filter) {
  for (let round = 0; round < 50; round++) {
    const rows = await fsQuery(collection, { where: filter });
    if (!rows.length) return;
    for (let i = 0; i < rows.length; i += 15) {
      const results = await Promise.all(rows.slice(i, i + 15).map(r => fsDelete(collection, r.id)));
      if (results.some(ok => !ok)) throw new Error(`Couldn't delete every ${collection} document`);
    }
  }
  throw new Error(`Too many ${collection} documents to delete in one go`);
}

async function deleteMyAccount(password) {
  const user = currentUser, me = user.uid, authMod = window.__fbAuthMod;
  deletingAccount = true;
  try {
    // 1. Prove it's me. Doing this first means a wrong password costs nothing, and the login can be removed at the end.
    await authMod.reauthenticateWithCredential(user, authMod.EmailAuthProvider.credential(user.email, password));
    // 2. Likes, matches and chats, in both directions.
    await deleteAllWhere("messages", fieldFilter("from", "EQUAL", me));
    await deleteAllWhere("messages", fieldFilter("to", "EQUAL", me));
    await deleteAllWhere("likes", fieldFilter("from", "EQUAL", me));
    await deleteAllWhere("likes", fieldFilter("to", "EQUAL", me));
    // 3. The profile. If the published rules don't allow deleting it yet, blank it and mark it deleted, so nobody sees it.
    if (!myProfile._unsaved && !(await fsDelete("users", me))) {
      await fsSet("users", me, { deleted: true, displayName: "Deleted user", bio: "", course: "", department: "", year: "", gender: "", interests: [], photos: [], saved: [], blocked: [] });
    }
    // 4. This phone's memory of me, then the login itself.
    try { localStorage.removeItem(dismissKey()); } catch (_) { /* storage blocked */ }
    authNotice = { text: "Your account has been deleted.", kind: "ok" };
    try {
      await authMod.deleteUser(user);
    } catch (e) {
      authNotice = null;
      e.loginStep = true;       // the data is already gone; only the login is left
      throw e;
    }
  } catch (e) {
    deletingAccount = false;
    throw e;
  }
}

function deleteAccountErrorText(e) {
  const code = (e && e.code) || "";
  if (e && e.loginStep) return "Your profile, likes and chats are deleted, but your login couldn't be removed. Tap Delete my account again to finish.";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/invalid-login-credentials") return "That password isn't right.";
  if (code === "auth/too-many-requests") return "Too many attempts. Wait a few minutes and try again.";
  if (code === "auth/network-request-failed") return "Couldn't reach the server. Check your connection and try again.";
  if (code === "auth/requires-recent-login") return "For safety, log out, log in again, then delete your account.";
  return "We couldn't finish deleting everything. Some of your data may already be gone. Try again to finish.";
}

function wireDeleteAccount() {
  const dlg = $("deleteAccountDialog"), pw = $("delPassword"), confirmBtn = $("delConfirm");
  $("deleteAccountBtn").onclick = () => {
    pw.value = ""; hideMsg("delMsg"); confirmBtn.disabled = false;
    openDialog("deleteAccountDialog");
    pw.focus();
  };
  $("delCancel").onclick = () => { if (!confirmBtn.disabled) closeDialog("deleteAccountDialog"); };
  // While it is deleting, Escape must not close the dialog.
  dlg.addEventListener("cancel", (e) => { if (confirmBtn.disabled) e.preventDefault(); });
  $("deleteAccountForm").onsubmit = async (e) => {
    e.preventDefault();
    if (confirmBtn.disabled) return;
    if (!pw.value) return showMsg("delMsg", "Enter your password to confirm.", "err");
    confirmBtn.disabled = true;
    showMsg("delMsg", "Deleting your account…", "info");
    try {
      await deleteMyAccount(pw.value);
      closeDialog("deleteAccountDialog");
    } catch (err) {
      console.error(err);
      showMsg("delMsg", deleteAccountErrorText(err), "err");
      confirmBtn.disabled = false;
    }
  };
}

// ============================================================================
// MATCHES + CHAT
// ============================================================================
let matchesToken = 0;
async function loadMatches() {
  const token = ++matchesToken;
  const list = $("matchesList");
  try {
    const ids = matchIds().sort((a, b) => matchedAt(b) - matchedAt(a));
    const users = (await Promise.all(ids.map(getUser))).filter(Boolean)
      .filter(u => !(u.blocked || []).includes(currentUser.uid) && !(myProfile.blocked || []).includes(u.id));
    if (token !== matchesToken) return;   // a newer refresh is already on its way
    social.matchUsers = users;
    if (users.length === 0) {
      list.innerHTML = `
        <div class="empty-state big">
          <div class="empty-emoji" aria-hidden="true">💘</div>
          <h3>No matches yet</h3>
          <p>A match happens when you and someone else like each other. Keep browsing, or answer the people who already like you.</p>
          <div class="empty-actions">
            <button class="btn btn-gold" data-go="discover">Browse profiles</button>
            <button class="btn ghost" data-go="admirers">See admirers</button>
          </div>
        </div>`;
    } else {
      list.innerHTML = "";
      users.forEach(u => {
        const at = matchedAt(u.id);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "match-row";
        row.innerHTML = `${avatarHTML(u, "lg")}
          <span class="match-main"><span class="nm">${esc(u.displayName)}</span><span class="dp">${esc(u.department || "Department not set")}</span></span>
          ${at ? `<span class="match-when">Matched ${esc(relTime(new Date(at).toISOString()))}</span>` : ""}`;
        row.onclick = () => openChat(u);
        list.appendChild(row);
      });
    }
  } catch (e) {
    console.error(e);
    list.innerHTML = '<div class="empty-state">Couldn\'t load matches. Try again shortly.</div>';
  }
  renderMatchOpeners();
  await renderPending();
}

function wireMatches() {
  $("backToMatches").onclick = closeChatView;
  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const input = $("chatInput");
    const text = clean(input.value, 1000);
    if (!text || !currentChatPartner) return;
    input.value = "";
    $("icebreakerTray").hidden = true;
    $("icebreakerBtn").setAttribute("aria-expanded", "false");
    sendChatMessage(text);
  };
  $("icebreakerBtn").onclick = toggleIcebreakerTray;
  $("icebreakerMore").onclick = () => { $("icebreakerTray").hidden = true; toggleIcebreakerTray(); };
  $("chatMenuBtn").onclick = () => openDialog("chatMenuSheet");
  $("menuViewProfile").onclick = () => { closeDialog("chatMenuSheet"); if (currentChatPartner) openProfileDialog(currentChatPartner, { mode: "match" }); };
  $("unmatchBtn").onclick = async () => {
    closeDialog("chatMenuSheet");
    const u = currentChatPartner;
    if (!u) return;
    const ok = await uiConfirm(`This deletes your chat with ${u.displayName} and removes the match. It can't be undone.`,
      { title: `Unmatch ${u.displayName}?`, okLabel: "Unmatch", danger: true });
    if (ok) await unmatchUser(u.id);
  };
  $("menuBlock").onclick = async () => { closeDialog("chatMenuSheet"); const u = currentChatPartner; if (u) await blockUser(u, { fromChat: true }); };
  $("menuReport").onclick = () => { closeDialog("chatMenuSheet"); const u = currentChatPartner; if (u) reportUser(u); };
  $("chatBannerClose").onclick = () => { chatBannerDismissed = true; $("chatBanner").hidden = true; };
}

function stopChatListener() {
  if (chatUnsub) { try { chatUnsub(); } catch (_) {} chatUnsub = null; }
}

function closeChatView() {
  stopChatListener();
  chatSession++;
  currentChatPartner = null;
  chatMsgs = new Map();
  document.body.classList.remove("in-chat");
  $("chatView").classList.remove("active");
  $("matchesList").style.display = "";
  $("matchesHead").hidden = false;
  $("icebreakerTray").hidden = true;
}

function openChatFromAnywhere(user) {
  goPanel("matches");
  openChat(user);
}

async function openChat(user) {
  stopChatListener();
  const token = ++chatSession;
  currentChatPartner = user;
  chatMsgs = new Map();
  document.body.classList.add("in-chat");
  $("matchesList").style.display = "none";
  $("matchesHead").hidden = true;
  $("chatView").classList.add("active");
  $("chatBanner").hidden = chatBannerDismissed;
  $("icebreakerTray").hidden = true;
  $("icebreakerBtn").setAttribute("aria-expanded", "false");
  $("chatWithName").textContent = user.displayName;
  $("chatWithMeta").textContent = user.department || user.course || "";
  paintAvatar($("chatAvatar"), user);
  $("chatMessages").innerHTML = '<div class="chat-empty"><p>Loading…</p></div>';
  window.scrollTo(0, 0);

  let sent;
  try {
    sent = await fetchDirectionWithIds(currentUser.uid, user.id);
  } catch (e) {
    console.error(e);
    if (token === chatSession) $("chatMessages").innerHTML = '<div class="chat-empty"><p>Couldn\'t load messages. Go back and try again.</p></div>';
    return;
  }
  if (token !== chatSession) return;
  sent.forEach(m => chatMsgs.set(m.id, m));
  renderChat(true); // show what I've sent while the live listener connects

  // Their messages arrive live: the first snapshot is everything so far, and
  // every later one is just what's new, so no polling and no repeat reads.
  try {
    const fsMod = window.__fbFirestoreMod;
    const q = fsMod.query(fsMod.collection(firestoreDb, "messages"),
      fsMod.where("from", "==", user.id), fsMod.where("to", "==", currentUser.uid));
    let first = true;
    chatUnsub = fsMod.onSnapshot(q, (snap) => {
      if (token !== chatSession) return;
      snap.docChanges().forEach(ch => {
        if (ch.type === "added") chatMsgs.set(ch.doc.id, { id: ch.doc.id, ...ch.doc.data() });
      });
      renderChat(first);
      first = false;
    }, (err) => {
      console.error("Live chat unavailable:", err);
      if (token === chatSession) toast("Live updates paused. Reopen the chat to refresh.", "err");
    });
  } catch (e) {
    console.error(e);
  }
}

function renderChat(forceBottom) {
  if (!currentChatPartner) return;
  const box = $("chatMessages");
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const msgs = [...chatMsgs.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  box.innerHTML = "";
  if (msgs.length === 0) {
    box.innerHTML = `<div class="chat-empty"><div class="empty-emoji" aria-hidden="true">👋</div>
      <p>You matched with ${esc(firstName(currentChatPartner))}. Say hello, or tap 💡 for an opener.</p></div>`;
    return;
  }
  let lastDay = "";
  msgs.forEach(m => {
    const day = dayLabel(m.createdAt);
    if (day && day !== lastDay) {
      const d = document.createElement("div");
      d.className = "day-divider"; d.textContent = day;
      box.appendChild(d);
      lastDay = day;
    }
    const mine = m.from === currentUser.uid;
    const wrap = document.createElement("div");
    wrap.className = "msg-wrap " + (mine ? "mine" : "theirs");
    const b = document.createElement("div");
    b.className = "bubble " + (mine ? "mine" : "theirs") + (m._state ? " " + m._state : "");
    b.textContent = m.text;
    const meta = document.createElement("span");
    meta.className = "bubble-meta";
    meta.textContent = m._state === "pending" ? "Sending…" : m._state === "failed" ? "Not sent. Tap to retry" : clockTime(m.createdAt);
    wrap.append(b, meta);
    if (m._state === "failed") {
      wrap.classList.add("failed");
      wrap.setAttribute("role", "button");
      wrap.tabIndex = 0;
      wrap.onclick = () => retrySend(m.id);
      wrap.onkeydown = (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); retrySend(m.id); } };
    }
    if (!mine && scamScan(m.text).level === "high") {
      const warn = document.createElement("button");
      warn.type = "button";
      warn.className = "bubble-warn";
      warn.textContent = "⚠️ This message has scam warning signs. See why";
      warn.onclick = () => { $("scamInput").value = m.text; goPanel("scam"); runScamCheck(); };
      wrap.appendChild(warn);
    }
    box.appendChild(wrap);
  });
  if (nearBottom || forceBottom) box.scrollTop = box.scrollHeight;
}

async function sendChatMessage(text, existingId) {
  const partner = currentChatPartner;
  if (!partner) return;
  const me = currentUser.uid;
  const id = existingId || `${me}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = existingId && chatMsgs.get(id) ? chatMsgs.get(id).createdAt : new Date().toISOString();
  const msg = { id, from: me, to: partner.id, text, createdAt, _state: "pending" };
  chatMsgs.set(id, msg);
  renderChat(true);
  try {
    await fsCreate("messages", id, { from: me, to: partner.id, text, createdAt });
    delete msg._state;
    sendPushToUser(partner.id, { title: myProfile.displayName, body: text });
  } catch (e) {
    if (e.status === 409) delete msg._state; // it had already gone through
    else { console.error(e); msg._state = "failed"; }
  }
  if (currentChatPartner && currentChatPartner.id === partner.id) renderChat(true);
}
function retrySend(id) {
  const m = chatMsgs.get(id);
  if (m && m._state === "failed") sendChatMessage(m.text, id);
}

function toggleIcebreakerTray() {
  const tray = $("icebreakerTray");
  if (!currentChatPartner) return;
  if (tray.hidden) {
    const chips = $("icebreakerChips");
    chips.innerHTML = "";
    openersFor(currentChatPartner, 3).forEach(text => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "chip"; b.textContent = text;
      b.onclick = () => { $("chatInput").value = text; tray.hidden = true; $("icebreakerBtn").setAttribute("aria-expanded", "false"); $("chatInput").focus(); };
      chips.appendChild(b);
    });
    tray.hidden = false;
  } else {
    tray.hidden = true;
  }
  $("icebreakerBtn").setAttribute("aria-expanded", String(!tray.hidden));
}

// Every message I've sent to someone, with the real document id so each can
// be deleted on unmatch (Firestore deletes are by id only).
async function fetchDirectionWithIds(fromId, toId) {
  return fsQuery("messages", { where: andFilter([fieldFilter("from", "EQUAL", fromId), fieldFilter("to", "EQUAL", toId)]) });
}

async function unmatchUser(otherId) {
  try {
    await removeConnection(otherId);
    dismissUser(otherId); // they stay in Discover, labelled Passed
    closeChatView();
    await Promise.all([loadMatches(), loadDiscover()]);
    renderHome();
    toast("Unmatched.");
  } catch (e) {
    console.error(e);
    toast("Unmatch didn't fully complete. Try again, or refresh and check your matches.", "err");
  }
}

// ============================================================================
// ADMIRERS + SAVED lists
// ============================================================================
function personCard(u, kind) {
  const c = compat(u);
  const photo = photosOf(u)[0];
  const when = kind === "waiting" ? relTime(social.likedAt[u.id]) : "";
  const el = document.createElement("article");
  el.className = "person";
  el.innerHTML = `
    <button type="button" class="person-photo" aria-label="View ${esc(u.displayName)}'s profile"${photo ? ` style="background-image:url('${photo}')"` : ""}>${photo ? "" : esc(initialsOf(u.displayName))}</button>
    <div class="person-main">
      <h3>${esc(u.displayName)}${u.age ? `, ${esc(u.age)}` : ""}</h3>
      <p class="dept">${esc(u.department || "Department not set")}</p>
      <p class="why">${c.pct > 0 ? `<b class="pct">${c.pct}% match</b> ` : ""}${esc(whyLine(c))}</p>
      ${when ? `<p class="when">You liked them ${esc(when)}.</p>` : ""}
      <div class="person-actions"></div>
    </div>`;
  const actions = el.querySelector(".person-actions");
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn small " + cls; b.textContent = label; b.onclick = fn;
    actions.appendChild(b);
  };
  el.querySelector(".person-photo").onclick = () => openProfileDialog(u, { mode: kind });
  // A button that sends a like stays disabled while it works and comes back if the like fails.
  const likeAction = (label) => mk(label, "btn-gold", async (e) => {
    const b = e.currentTarget; b.disabled = true;
    if (!(await likeUser(u))) b.disabled = false;
  });
  if (kind === "admirer") {
    likeAction("Like back");
    mk("Not now", "ghost", async () => {
      dismissUser(u.id);
      await renderAdmirers(); renderHome();
      toast("Hidden. They won't show here again.");
    });
  } else if (kind === "waiting") {
    mk("Take back", "ghost", async (e) => {
      const b = e.currentTarget; b.disabled = true;
      if (!(await takeBackLike(u))) b.disabled = false;
    });
  } else {
    likeAction("Like");     // a like takes them off the shortlist once it has gone through
    mk("Remove", "ghost", () => unsaveProfile(u.id));
  }
  return el;
}

let admirersToken = 0;
async function renderAdmirers() {
  const token = ++admirersToken;
  const list = $("admirersList");
  const blocked = new Set(myProfile.blocked || []);
  const ids = [...social.likedBy]
    .filter(id => id !== currentUser.uid && !social.liked.has(id) && !blocked.has(id) && !dismissedIds.has(id))
    .sort((a, b) => (Date.parse(social.likedByAt[b]) || 0) - (Date.parse(social.likedByAt[a]) || 0));
  const users = (await Promise.all(ids.map(getUser))).filter(u => u && !(u.blocked || []).includes(currentUser.uid));
  if (token !== admirersToken) return; // a newer render is already on its way
  social.admirers = users;
  if (!users.length) {
    list.innerHTML = `
      <div class="empty-state big">
        <div class="empty-emoji" aria-hidden="true">💌</div>
        <h3>No admirers waiting</h3>
        <p>When someone likes you, they show up here. A complete profile with a photo is the best way to get noticed.</p>
        <div class="empty-actions">
          <button class="btn btn-gold" data-go="profile">Improve my profile</button>
          <button class="btn ghost" id="admirersInvite">Invite a friend</button>
        </div>
      </div>`;
    $("admirersInvite").onclick = shareInvite;
    return;
  }
  list.innerHTML = "";
  users.forEach(u => list.appendChild(personCard(u, "admirer")));
}

// People I liked who haven't liked me back yet (newest first), each with a Take back button.
let pendingToken = 0;
async function renderPending() {
  const token = ++pendingToken;
  try {
    const blocked = new Set(myProfile.blocked || []);
    const ids = [...social.liked]
      .filter(id => id !== currentUser.uid && !social.likedBy.has(id) && !blocked.has(id))
      .sort((a, b) => (Date.parse(social.likedAt[b]) || 0) - (Date.parse(social.likedAt[a]) || 0));
    const shown = ids.slice(0, 50);
    const users = (await Promise.all(shown.map(getUser))).filter(u => u && !(u.blocked || []).includes(currentUser.uid));
    if (token !== pendingToken) return;
    social.pendingUsers = users;
    const list = $("pendingList");
    list.innerHTML = "";
    users.forEach(u => list.appendChild(personCard(u, "waiting")));
    $("pendingWrap").hidden = users.length === 0;
    $("pendingMore").hidden = ids.length <= shown.length;
  } catch (e) {
    console.error(e);
  }
}

let savedToken = 0;
async function renderSaved() {
  const token = ++savedToken;
  const list = $("savedList");
  const ids = [...(myProfile.saved || [])].reverse();
  const found = await Promise.all(ids.map(getUser));
  const users = found.filter(u => u && !(u.blocked || []).includes(currentUser.uid) && !(myProfile.blocked || []).includes(u.id));
  if (token !== savedToken) return;
  // Someone whose profile no longer exists can't be on my shortlist: drop them, so the count matches the list.
  const gone = ids.filter((id, i) => !found[i]);
  if (gone.length && !myProfile._unsaved) {
    myProfile.saved = (myProfile.saved || []).filter(id => !gone.includes(id));
    renderSavedPill();
    fsSet("users", currentUser.uid, { saved: myProfile.saved }).catch(e => console.error(e));
  }
  social.savedUsers = users;
  if (!users.length) {
    list.innerHTML = `
      <div class="empty-state big">
        <div class="empty-emoji" aria-hidden="true">🔖</div>
        <h3>Nothing saved yet</h3>
        <p>Tap the bookmark under a profile in Discover to set someone aside and decide later.</p>
        <div class="empty-actions"><button class="btn btn-gold" data-go="discover">Browse profiles</button></div>
      </div>`;
    return;
  }
  list.innerHTML = "";
  users.forEach(u => list.appendChild(personCard(u, "saved")));
}

function wireAdmirers() { /* actions are attached per card in personCard() */ }
function wireSaved() { /* same */ }

// ============================================================================
// DIALOGS: match celebration, full profile
// ============================================================================
function showMatchDialog(u, undo = {}) {
  $("matchAvatars").innerHTML = `${avatarHTML(myProfile, "xl")}${avatarHTML(u, "xl")}`;
  $("matchSub").textContent = `You and ${u.displayName} liked each other.`;
  $("matchSayHi").onclick = () => { closeDialog("matchDialog"); openChatFromAnywhere(u); };
  // Liked by mistake? Taking the like back also ends the match.
  const undoBtn = $("matchUndo");
  undoBtn.disabled = false;
  undoBtn.onclick = () => { undoBtn.disabled = true; closeDialog("matchDialog"); takeBackLike(u, undo); };
  openDialog("matchDialog");
}

function openProfileDialog(u, { mode } = {}) {
  const preview = mode === "preview";
  const c = preview ? { pct: 0, shared: [], sameDept: false, sameYear: false } : compat(u);
  const body = $("pdBody");
  body.innerHTML = profileCardHTML(u, c, {
    likesYou: !preview && social.likedBy.has(u.id) && !social.liked.has(u.id),
    hideWhy: preview
  });
  wirePhotoPager(body, photosOf(u));
  const actions = $("pdActions");
  actions.innerHTML = "";
  const mk = (label, cls, fn) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn " + cls; b.textContent = label; b.onclick = fn;
    actions.appendChild(b);
  };
  if (preview) {
    const p = document.createElement("p");
    p.className = "pd-note"; p.textContent = "This is how other students see your profile.";
    actions.appendChild(p);
    mk("Edit profile", "btn-gold", () => { closeDialog("profileDialog"); goPanel("profile"); });
  } else if (mode === "admirer") {
    mk("Like back", "btn-gold", async () => { closeDialog("profileDialog"); await likeUser(u); });
    mk("Not now", "ghost", async () => { closeDialog("profileDialog"); dismissUser(u.id); await renderAdmirers(); renderHome(); });
  } else if (mode === "saved") {
    mk("Like", "btn-gold", async () => { closeDialog("profileDialog"); await likeUser(u); });
    mk("Remove from Saved", "ghost", async () => { closeDialog("profileDialog"); await unsaveProfile(u.id); });
  } else if (mode === "waiting") {
    mk("Take back my like", "ghost", async () => { closeDialog("profileDialog"); await takeBackLike(u); });
  } else if (mode === "match" && currentChatPartner && currentChatPartner.id === u.id) {
    mk("Back to chat", "btn-gold", () => closeDialog("profileDialog"));
  } else if (social.liked.has(u.id) && social.likedBy.has(u.id)) {
    mk("Message", "btn-gold", () => { closeDialog("profileDialog"); openChatFromAnywhere(u); });
  }
  openDialog("profileDialog");
}

// ============================================================================
// HOME — tool grid badges, stats strip, profile nudge
// ============================================================================
function setBadge(id, n) {
  const el = $(id);
  el.textContent = n;
  el.hidden = !(n > 0);
}

// Profile strength: 100 points across things that make a profile worth
// answering. Every item has a field to jump to.
function profileStrength() {
  const p = myProfile;
  const emailBase = String((currentUser && currentUser.email) || "").split("@")[0];
  const items = [
    { label: "Add a photo", pts: 25, done: photosOf(p).length > 0, go: "photoGrid" },
    { label: "Write a short bio", pts: 20, done: String(p.bio || "").trim().length >= 30, go: "pf_bio" },
    { label: "Pick 3 or more interests", pts: 20, done: (p.interests || []).length >= 3, go: "interestGrid" },
    { label: "Set your display name", pts: 10, done: !!p.displayName && p.displayName !== emailBase && p.displayName !== "New member", go: "pf_displayName" },
    { label: "Choose your department", pts: 10, done: !!p.department, go: "profileDept" },
    { label: "Add your course", pts: 5, done: !!String(p.course || "").trim(), go: "pf_course" },
    { label: "Say your gender", pts: 5, done: !!p.gender, go: "pf_gender" },
    { label: "Add your year of study", pts: 5, done: !!String(p.year || "").trim(), go: "pf_year" }
  ];
  const pct = items.reduce((s, i) => s + (i.done ? i.pts : 0), 0);
  return { pct, items };
}

function renderHome() {
  if (!myProfile) return;
  const s = profileStrength();
  // "People to meet" counts only people I haven't decided on; the deck itself keeps everyone.
  $("statDiscover").textContent = discoverQueue.filter(u => { const r = relationOf(u.id); return r === "new" || r === "admirer"; }).length;
  $("statMatches").textContent = social.matchUsers.length;
  $("statAdmirers").textContent = social.admirers.length;
  $("statStrength").textContent = s.pct + "%";
  setBadge("badgeAdmirers", social.admirers.length);
  setBadge("navAdmirersBadge", social.admirers.length);
  const nudge = $("profileNudge");
  if (s.pct >= 100) {
    nudge.hidden = true;
  } else {
    nudge.hidden = false;
    $("nudgeBar").style.width = s.pct + "%";
    $("nudgePct").textContent = s.pct + "%";
    const todo = s.items.filter(i => !i.done).slice(0, 2).map(i => i.label.charAt(0).toLowerCase() + i.label.slice(1));
    $("nudgeText").textContent = "Next: " + todo.join(" and ") + ".";
  }
  renderProfileHeader();
}

function renderProfileHeader() {
  if (!myProfile) return;
  const s = profileStrength();
  paintAvatar($("profAvatar"), myProfile);
  $("profName").textContent = myProfile.displayName;
  $("profMeta").textContent = [myProfile.department, myProfile.year].filter(x => String(x || "").trim()).join(", ") || "Add your department and year below";
  $("profRing").style.setProperty("--p", s.pct);
  $("profPct").textContent = s.pct + "%";
  const ul = $("profChecklist");
  ul.innerHTML = "";
  const todo = s.items.filter(i => !i.done);
  $("profChecklistWrap").hidden = todo.length === 0;
  todo.forEach(i => {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button"; b.className = "check-item";
    b.innerHTML = `<span class="check-box" aria-hidden="true"></span><span class="check-label">${esc(i.label)}</span><span class="check-pts">+${i.pts}%</span>`;
    b.onclick = () => focusProfileField(i.go);
    li.appendChild(b);
    ul.appendChild(li);
  });
  $("accountEmail").textContent = currentUser ? currentUser.email : "";
}

function focusProfileField(id) {
  const el = $(id);
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
  if (typeof el.focus === "function") setTimeout(() => el.focus({ preventScroll: true }), 250);
}

// ============================================================================
// ICEBREAKERS
// Ready-made openers, plus a few picked from interests you share with a
// match. Plain templates — no AI involved.
// ============================================================================
const ICEBREAKER_LABELS = { easy: "Easy", fun: "Fun", deep: "Deep", campus: "Campus", mombasa: "Mombasa" };
const ICEBREAKERS = {
  easy: [
    "Hey! Your profile made me smile. What's the best part of your week so far?",
    "Quick question: chai, coffee or juice? Your answer says a lot.",
    "What's one thing you're looking forward to this month?",
    "If you could be anywhere in Mombasa right now, where would it be?",
    "Hi! What do you do when you're not studying?"
  ],
  fun: [
    "Settle this for me: mahamri or mandazi?",
    "Two truths and a lie. You go first.",
    "What's a skill you have that would surprise people?",
    "Which song are you replaying the most right now?",
    "Beach day or movie night in: pick one and defend it."
  ],
  deep: [
    "What's something you're proud of that nobody ever asks about?",
    "What do you want your life to look like in five years?",
    "What's the best advice you've ever been given?",
    "What does a perfect weekend look like for you?"
  ],
  campus: [
    "What are you studying, and what made you pick it?",
    "Which lecture or lecturer has surprised you the most?",
    "Best place to study on campus? I need new options.",
    "What do you wish someone had told you in first year?",
    "Group assignments: the leader, the silent genius, or the one who appears on deadline day?"
  ],
  mombasa: [
    "Best mishkaki or viazi karai in Mombasa? I'm taking notes.",
    "Nyali, Bamburi or Old Town: where would you take a visitor first?",
    "Fort Jesus: worth a second visit, or once is enough?",
    "Sunset at the waterfront or a beach day: what's your pick?",
    "What's the most underrated spot in Mombasa?"
  ]
};
// One opener per interest tag (keys must match INTEREST_TAGS exactly).
const INTEREST_OPENERS = {
  "Football": "Which club do you actually support, and what's the match you'll never forget?",
  "Basketball": "On the court, are you a shooter, a passer, or the one who just hustles?",
  "Rugby": "Rugby fan or player? What's your best story from a match?",
  "Swimming": "Pool or ocean: where do you swim best?",
  "Athletics": "What's your event: sprints, distance, or something more unusual?",
  "Gym & Fitness": "What does your usual workout look like, and what keeps you going?",
  "Music": "What's the last song you played on loop?",
  "Dance": "Which dance style would you teach me first?",
  "Singing": "If you could sing any song perfectly, which would it be?",
  "DJing": "What's on your must-play list for a good party?",
  "Photography": "What's the best photo you've ever taken, and what's the story behind it?",
  "Film & TV": "What show could you rewatch forever?",
  "Gaming": "What game do you keep coming back to, and are you competitive about it?",
  "Reading": "What's the last book you couldn't put down?",
  "Writing": "What do you like to write: stories, journals, songs?",
  "Poetry": "Who's a poet or lyricist whose words stuck with you?",
  "Art & Drawing": "What do you like to draw or make when nobody's watching?",
  "Fashion": "Describe your style in three words.",
  "Cooking": "What's the one dish you'd cook to impress someone?",
  "Baking": "Mahamri, cake or cookies: what do you bake best?",
  "Travel": "Where was the best trip you've taken, and where's next?",
  "Hiking": "What's the best view you've earned on foot?",
  "Volunteering": "Which cause matters most to you, and how did you get involved?",
  "Entrepreneurship": "What business would you start tomorrow if money wasn't a problem?",
  "Coding": "What's the coolest thing you've built, or want to build?",
  "Debate": "What's a hill you'll happily argue on, in a friendly way?",
  "Chess": "Which opening do you always play? I might challenge you.",
  "Church / Faith": "What part of your faith community do you love most?",
  "Fellowship": "What's your favourite part of fellowship: the singing, the people, or the snacks?",
  "Politics & Current Affairs": "What's one issue you think students should pay more attention to?"
};

let icebreakerCat = "easy";

// Up to n openers for someone: ones about interests we share first, then
// about theirs, then topped up from the general lists.
function openersFor(u, n) {
  const mine = new Set(myProfile.interests || []);
  const theirs = (u.interests || []).filter(t => INTEREST_OPENERS[t]);
  const picks = [];
  theirs.filter(t => mine.has(t)).slice(0, 2).forEach(t => picks.push(INTEREST_OPENERS[t]));
  if (picks.length < 2) theirs.filter(t => !mine.has(t)).slice(0, 2 - picks.length).forEach(t => picks.push(INTEREST_OPENERS[t]));
  const pool = [...ICEBREAKERS.easy, ...ICEBREAKERS.fun, ...ICEBREAKERS.campus];
  let guard = 0;
  while (picks.length < n && guard++ < 50) {
    const x = pool[Math.floor(Math.random() * pool.length)];
    if (!picks.includes(x)) picks.push(x);
  }
  return picks.slice(0, n);
}

function wireIcebreakers() {
  const cats = $("icebreakerCats");
  cats.innerHTML = "";
  Object.keys(ICEBREAKERS).forEach(k => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.cat = k; b.textContent = ICEBREAKER_LABELS[k];
    b.onclick = () => { icebreakerCat = k; renderIcebreakers(); };
    cats.appendChild(b);
  });
  $("spinBtn").onclick = spinIcebreaker;
  $("icebreakerFor").onchange = renderMatchOpeners;
  $("forMatchShuffle").onclick = renderMatchOpeners;
  renderIcebreakers();
}

function renderIcebreakers() {
  document.querySelectorAll("#icebreakerCats .chip").forEach(b => {
    const on = b.dataset.cat === icebreakerCat;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const list = $("icebreakerList");
  list.innerHTML = "";
  ICEBREAKERS[icebreakerCat].forEach(t => list.appendChild(openerRow(t)));
}

function openerRow(text, user) {
  const li = document.createElement("li");
  li.className = "opener";
  const p = document.createElement("p");
  p.textContent = text;
  const actions = document.createElement("div");
  actions.className = "opener-actions";
  const copy = document.createElement("button");
  copy.type = "button"; copy.className = "btn small ghost"; copy.textContent = "Copy";
  copy.onclick = () => copyWithToast(text, "Opener copied");
  actions.appendChild(copy);
  if (user) {
    const use = document.createElement("button");
    use.type = "button"; use.className = "btn small btn-gold"; use.textContent = `Send to ${firstName(user)}`;
    use.onclick = () => useOpenerInChat(user, text);
    actions.appendChild(use);
  }
  li.append(p, actions);
  return li;
}

function spinIcebreaker() {
  const all = Object.values(ICEBREAKERS).flat();
  const text = all[Math.floor(Math.random() * all.length)];
  const box = $("spinResult");
  box.hidden = false;
  box.querySelector("p").textContent = text;
  box.classList.remove("pop");
  void box.offsetWidth;
  box.classList.add("pop");
  $("spinCopy").onclick = () => copyWithToast(text, "Opener copied");
}

function renderMatchOpeners() {
  const sel = $("icebreakerFor");
  if (!sel) return;
  const users = social.matchUsers || [];
  const prev = sel.value;
  sel.innerHTML = users.map(u => `<option value="${esc(u.id)}">${esc(u.displayName)}</option>`).join("");
  const none = users.length === 0;
  $("forMatchEmpty").hidden = !none;
  $("forMatchBody").hidden = none;
  if (none) return;
  if (users.some(u => u.id === prev)) sel.value = prev;
  const u = users.find(x => x.id === sel.value) || users[0];
  const list = $("forMatchList");
  list.innerHTML = "";
  openersFor(u, 3).forEach(t => list.appendChild(openerRow(t, u)));
}

async function useOpenerInChat(user, text) {
  openChatFromAnywhere(user);
  setTimeout(() => { const i = $("chatInput"); i.value = text; i.focus(); }, 60);
}

// ============================================================================
// DATE IDEAS — Mombasa, sorted by vibe. No prices or opening hours on purpose:
// those change, so the card links to Maps instead.
// ============================================================================
const DATE_VIBES = { all: "All", chill: "Chill", outdoors: "Outdoors", culture: "Culture", food: "Food", daytrip: "Day trip" };
const DATE_IDEAS = [
  { title: "Fort Jesus", area: "Old Town", vibes: ["culture"], q: "Fort Jesus Mombasa",
    blurb: "A Portuguese-built fort from 1593 and a UNESCO World Heritage Site. Plenty to look at and talk about." },
  { title: "Old Town walk", area: "Old Town", vibes: ["culture", "chill"], q: "Old Town Mombasa",
    blurb: "Narrow streets, carved doors and old Swahili buildings. Wander with no plan." },
  { title: "Mama Ngina Waterfront", area: "Mombasa Island", vibes: ["chill"], q: "Mama Ngina Waterfront Park Mombasa",
    blurb: "A seafront park over the Likoni Channel. Sit by the sea and watch the ships come and go." },
  { title: "Haller Park", area: "Bamburi", vibes: ["outdoors", "chill"], q: "Haller Park Bamburi Mombasa",
    blurb: "A wildlife sanctuary built on an old quarry. Feeding the giraffes is an easy icebreaker." },
  { title: "Nyali Beach", area: "Nyali", vibes: ["chill", "outdoors"], q: "Nyali Beach Mombasa",
    blurb: "A quieter beach, so it's easier to hear each other talk." },
  { title: "Bamburi Beach", area: "Bamburi", vibes: ["outdoors"], q: "Bamburi Beach Mombasa",
    blurb: "A livelier beach, known for water sports." },
  { title: "Mombasa Marine National Park", area: "North Coast", vibes: ["outdoors", "daytrip"], q: "Mombasa Marine National Park",
    blurb: "Coral reef snorkelling and diving. Go with a licensed operator." },
  { title: "Mamba Village", area: "North Coast", vibes: ["outdoors"], q: "Mamba Village Mombasa",
    blurb: "A crocodile farm. A fun, slightly nervous first date." },
  { title: "Wild Waters", area: "North Coast", vibes: ["outdoors"], q: "Wild Waters Mombasa",
    blurb: "A water park. Better as a group outing with friends." },
  { title: "Street food stroll", area: "Anywhere in town", vibes: ["food", "chill"], q: "street food Mombasa",
    blurb: "Mishkaki, mahamri, samosas, viazi karai. Pick one stall each and compare." },
  { title: "Biashara Street and the Tusks", area: "Moi Avenue", vibes: ["culture", "chill"], q: "Mombasa Elephant Tusks Moi Avenue",
    blurb: "Browse Biashara Street, then take a photo under the Elephant Tusks on Moi Avenue." },
  { title: "Coffee and a walk", area: "Anywhere", vibes: ["chill", "food"], q: "coffee shop Mombasa",
    blurb: "Low pressure, and easy to end after an hour if it isn't clicking." },
  { title: "Diani Beach", area: "South Coast", vibes: ["daytrip", "outdoors"], q: "Diani Beach Kenya",
    blurb: "White sand south of Mombasa. A proper day trip, so plan your transport both ways." },
  { title: "Jumba la Mtwana ruins", area: "Mombasa–Kilifi coast", vibes: ["culture", "daytrip"], q: "Jumba la Mtwana",
    blurb: "Ruins of a Swahili settlement on the coast north of Mombasa." }
];
let dateVibe = "all";

function wireDates() {
  const box = $("dateFilters");
  box.innerHTML = "";
  Object.entries(DATE_VIBES).forEach(([k, label]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip"; b.dataset.vibe = k; b.textContent = label;
    b.onclick = () => { dateVibe = k; renderDates(); };
    box.appendChild(b);
  });
  renderDates();
}

function renderDates() {
  document.querySelectorAll("#dateFilters .chip").forEach(b => {
    const on = b.dataset.vibe === dateVibe;
    b.classList.toggle("sel", on);
    b.setAttribute("aria-pressed", String(on));
  });
  const list = $("dateList");
  list.innerHTML = "";
  DATE_IDEAS.filter(d => dateVibe === "all" || d.vibes.includes(dateVibe)).forEach(d => {
    const el = document.createElement("article");
    el.className = "idea";
    const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(d.q);
    el.innerHTML = `
      <div class="idea-top"><h3>${esc(d.title)}</h3><span class="idea-area">${esc(d.area)}</span></div>
      <p>${esc(d.blurb)}</p>
      <div class="tag-row">${d.vibes.map(v => `<span class="tag">${esc(DATE_VIBES[v])}</span>`).join("")}</div>
      <div class="idea-actions">
        <a class="btn small ghost" href="${maps}" target="_blank" rel="noopener noreferrer">Open in Maps</a>
        <button type="button" class="btn small btn-gold invite">Copy invite</button>
      </div>`;
    el.querySelector(".invite").onclick = () => copyWithToast(`Want to check out ${d.title} together this weekend?`, "Invite copied. Paste it into your chat.");
    list.appendChild(el);
  });
}

// ============================================================================
// BIO BUILDER — fills in templates from your answers. Not AI: it recombines
// short written pieces, so edit the result freely.
// ============================================================================
const BIO_OPENERS = {
  chill: ["Easygoing and happiest with good food and better company.", "Calm energy, big laugh.", "Low drama, high vibes."],
  adventurous: ["Always up for a new place, a new dish, or a bad idea that turns out great.", "Say yes first, plan later.", "Happiest when I'm going somewhere I haven't been."],
  funny: ["Professional overthinker, amateur comedian.", "I'll make you laugh and you'll pretend it wasn't that funny.", "Funny in person, slightly less in text."],
  ambitious: ["Working on something big and still making time for good people.", "Building a life I'm proud of, one day at a time.", "Focused, curious, and still learning how to relax."],
  romantic: ["Old-school at heart. I still believe in real conversations.", "Here for something real, with plenty of laughs along the way.", "A good chat, a long walk and a sunset sound like a perfect evening."]
};
const BIO_LOOKING = {
  friends: ["Here to meet new people and see where it goes.", "Open to good friends first."],
  casual: ["Keeping things light and fun for now.", "Nothing too serious, just good company."],
  relationship: ["Looking for something real.", "Hoping to meet someone I can build something with."],
  open: ["Open to seeing where this goes.", "No script, just good conversation."]
};
const BIO_CLOSERS = ["Your turn: what's your go-to comfort food?", "Tell me something that made you smile today.", "What's the best recommendation you've had lately?"];

function listJoin(a) {
  if (a.length <= 1) return a.join("");
  return a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}
function bioWord(tag) {
  const t = tag.replace(/\s*\/\s*/g, " and ").replace(/\s*&\s*/g, " and ");
  return (t.match(/[A-Z]/g) || []).length >= 2 ? t : t.toLowerCase(); // keep "DJing" as written
}
function buildBios({ vibe, looking, picked, extra, seed }) {
  const op = BIO_OPENERS[vibe] || BIO_OPENERS.chill;
  const lk = BIO_LOOKING[looking] || BIO_LOOKING.open;
  const at = (arr, n) => arr[(seed + n) % arr.length];
  const list = listJoin(picked.map(bioWord));
  const extraS = extra ? (/[.!?]$/.test(extra) ? extra : extra + ".") : "";
  const A = [at(op, 0), list ? `Into ${list}.` : "", extraS].filter(Boolean).join(" ");
  const B = [at(op, 1), list ? `You'll usually find me with ${list} on my mind.` : "", extraS, at(lk, 0)].filter(Boolean).join(" ");
  const C = [at(op, 2), list ? `Ask me about ${list}.` : "", extraS, at(lk, 1), at(BIO_CLOSERS, 0)].filter(Boolean).join(" ");
  return [
    { label: "Short and simple", text: A },
    { label: "Friendly", text: B },
    { label: "Playful", text: C }
  ].map(b => ({ ...b, text: b.text.slice(0, 500) }));
}

function renderBioInterests() {
  const grid = $("bioInterests");
  if (!grid) return;
  grid.innerHTML = "";
  const mine = new Set(myProfile.interests || []);
  let preselected = 0;
  INTEREST_TAGS.forEach(tag => {
    const on = mine.has(tag) && preselected < 4;
    if (on) preselected++;
    const b = document.createElement("button");
    b.type = "button"; b.className = "interest-chip" + (on ? " sel" : ""); b.textContent = tag;
    b.setAttribute("aria-pressed", String(on));
    b.onclick = () => {
      const turnOn = !b.classList.contains("sel");
      if (turnOn && grid.querySelectorAll(".sel").length >= 4) return toast("Pick up to 4 interests for the bio.");
      b.classList.toggle("sel", turnOn);
      b.setAttribute("aria-pressed", String(turnOn));
    };
    grid.appendChild(b);
  });
}

function wireBio() {
  $("bioForm").onsubmit = (e) => { e.preventDefault(); generateBios(); };
  $("bioShuffle").onclick = () => { bioSeed++; generateBios(); };
}

function generateBios() {
  const picked = [...$("bioInterests").querySelectorAll(".interest-chip.sel")].map(c => c.textContent);
  const bios = buildBios({
    vibe: $("bioVibe").value, looking: $("bioLooking").value, picked,
    extra: clean($("bioExtra").value, 140), seed: bioSeed
  });
  const box = $("bioResults");
  box.innerHTML = "";
  $("bioShuffle").hidden = false;
  bios.forEach(b => {
    const el = document.createElement("article");
    el.className = "bio-option";
    el.innerHTML = `<h3>${esc(b.label)}</h3><p></p><div class="bio-actions"></div>`;
    el.querySelector("p").textContent = b.text;
    const a = el.querySelector(".bio-actions");
    const mk = (label, cls, fn) => {
      const btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn small " + cls; btn.textContent = label; btn.onclick = fn;
      a.appendChild(btn);
    };
    mk("Use this bio", "btn-gold", () => useBio(b.text));
    mk("Edit first", "ghost", () => { $("pf_bio").value = b.text; goPanel("profile"); setTimeout(() => focusProfileField("pf_bio"), 350); });
    mk("Copy", "ghost", () => copyWithToast(b.text, "Bio copied"));
    box.appendChild(el);
  });
  box.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
}

async function useBio(text) {
  try {
    await fsSet("users", currentUser.uid, { bio: text });
    myProfile.bio = text;
    fillProfileForm();
    renderHome();
    toast("Bio saved to your profile.");
  } catch (e) {
    console.error(e);
    toast("Couldn't save your bio. Try again.", "err");
  }
}

// ============================================================================
// DATE CHECK-IN — one message telling a friend who, where and when.
// ============================================================================
function checkinText() {
  const name = $("ciName").value.trim() || "someone from TUMingle";
  const place = $("ciPlace").value.trim() || "[place]";
  const friend = $("ciFriend").value.trim();
  const whenRaw = $("ciWhen").value;
  const when = whenRaw ? new Date(whenRaw) : null;
  const valid = when && !isNaN(when);
  const whenText = valid ? when.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
  let byText = "";
  if (valid) {
    const by = new Date(when.getTime() + 3 * 60 * 60 * 1000);
    byText = by.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  const me = (myProfile && myProfile.displayName) || "";
  return [
    `Hi${friend ? " " + friend : ""}, I'm meeting ${name} (we matched on TUMingle) at ${place}${whenText ? ", " + whenText : ""}.`,
    `I'll message you when I'm home safe. If you haven't heard from me${byText ? " by " + byText : ""}, please call me.`,
    me ? `— ${me}` : ""
  ].filter(Boolean).join("\n");
}

function renderCheckin() {
  const t = checkinText();
  $("ciPreview").textContent = t;
  $("ciWhatsApp").href = "https://wa.me/?text=" + encodeURIComponent(t);
}

function wireCheckin() {
  ["ciName", "ciPlace", "ciWhen", "ciFriend"].forEach(id => $(id).addEventListener("input", renderCheckin));
  $("ciCopy").onclick = () => copyWithToast(checkinText(), "Message copied. Paste it to your friend.");
  $("ciShare").onclick = async () => {
    const text = checkinText();
    if (navigator.share) {
      try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    copyWithToast(text, "Message copied. Paste it to your friend.");
  };
  renderCheckin();
}

// ============================================================================
// SCAM CHECK — looks for common warning words and phrases in a message.
// It is a keyword check, not a guarantee: it can miss scams and can flag
// honest messages, and the screen says so every time.
// ============================================================================
const MONEY_WORDS = "(?:money|cash|pesa|airtime|credit|bundles?|fare|nauli|ksh|kes|mpesa|m-pesa|till|paybill)";
const SCAM_RULES = [
  { id: "money", level: "critical", weight: 4,
    title: "Asks for money, airtime or a payment",
    advice: "Never send money, airtime or fare to someone you haven't met in person, however good the reason sounds.",
    res: [
      new RegExp(`\\b(?:send|lend|loan)\\s+(?:me|us)\\b[^.!?\\n]{0,30}\\b${MONEY_WORDS}\\b`),
      new RegExp(`\\b(?:i|we)\\s+(?:need|want)\\b[^.!?\\n]{0,20}\\b${MONEY_WORDS}\\b`),
      new RegExp(`\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:send|lend|loan|give)\\b[^.!?\\n]{0,25}\\b${MONEY_WORDS}\\b`),
      /\btuma\s+(?:pesa|mpesa|m-pesa|airtime|fare)\b/, /\bnitumie\b/,
      /\b(?:m-?pesa|mpesa)\s+(?:me|us)\b/,
      /\b(?:till|paybill)\s*(?:number|no\.?|#)?\s*(?:is|:)?\s*\d{4,}/,
      /\b(?:pay|send)\b[^.!?\n]{0,25}\b(?:till|paybill)\b[^.!?\n]{0,15}\d{4,}/,
      /\b(?:ksh|kes)\.?\s?\d{2,}[^.!?\n]{0,25}\b(?:send|lend|loan|pay)\b/,
      /\bsend\s+(?:me\s+)?(?:ksh|kes)\.?\s?\d/,
      // "send 3000 ksh", "pay 500 bob", "send 5k" (but not "I'll send you 200 bob")
      /\b(?:send|pay|wire|transfer|deposit)\b(?!\s+you\b)[^.!?\n]{0,25}\b\d[\d,.]*\s?(?:ksh|kes|shillings?|bob|k)\b/,
      // "pay 1500 on M-Pesa", "send it via Western Union"
      /\b(?:send|pay|wire|transfer)\b(?!\s+you\b)[^.!?\n]{0,30}\b(?:via|through|using|on|to)\s+(?:m-?pesa|mpesa|airtel\s*money|western\s+union|paypal|gift\s*cards?)\b/
    ] },
  { id: "secrets", level: "critical", weight: 4,
    title: "Asks for a PIN, code or password",
    advice: "Nobody genuine needs your M-Pesa PIN, a one-time code or your password. Never share them.",
    res: [
      /\b(?:otp|cvv|cvc|one[- ]time\s+(?:pin|password|code)|(?:verification|security|confirmation|login)\s+code)\b/,
      /\b(?:m-?pesa|mpesa|bank|atm|card|sim)\s+(?:pin|password)\b/,
      /\b(?:send|share|give|tell)\b[^.!?\n]{0,15}\b(?:me|us)\b[^.!?\n]{0,20}\b(?:password|national id|id number|id card|id copy|bank details|account number|card number)\b/
    ] },
  { id: "blackmail", level: "critical", weight: 4,
    title: "Threatens to share pictures or chats",
    advice: "Don't pay. Stop replying, keep screenshots, block them and report to the police (999 or 112).",
    res: [
      /\b(?:i(?:'ll| will)|i'?m going to|im going to|gonna)\s+(?:leak|expose|post|share|send)\b[^.!?\n]{0,30}\b(?:pics?|photos?|videos?|nudes?|screenshots?|chats?)\b/,
      /\bi\s+have\s+your\s+(?:pics?|photos?|videos?|nudes?)\b/,
      /\b(?:pay|send)\b[^.!?\n]{0,25}\b(?:or else|or i|otherwise|before i)\b/
    ] },
  { id: "nudes", level: "warn", weight: 3,
    title: "Asks for nude or private photos",
    advice: "Don't send private photos to someone you don't know. Scammers use them to blackmail people.",
    res: [/\bsend\s+(?:me\s+)?(?:nudes?|nude\s+(?:pics?|photos?)|naked\s+(?:pics?|photos?))\b/] },
  { id: "invest", level: "warn", weight: 3,
    title: "Mentions investing, crypto or trading",
    advice: "Investment tips from someone you met online are a classic romance scam. Don't move money on their advice.",
    res: [/\b(?:invest(?:ment|ing|ors?)?|crypto|bitcoin|forex|trading\s+(?:platform|account)|guaranteed\s+(?:returns?|profit)|double\s+your|binary\s+options?)\b/] },
  { id: "story", level: "warn", weight: 2,
    title: "Tells a classic scam story",
    advice: "Stories about customs fees, parcels, inheritances or being stuck abroad are common scripts. Be sceptical.",
    res: [/\b(?:inheritance|lottery|winnings?|fund[s]?\s+(?:transfer|release)|oil\s+rig|gift\s+(?:for|to)\s+you|stuck\s+(?:at|in)\s+(?:the\s+)?airport|customs\s+(?:fee|charge|duty))\b/] },
  { id: "link", level: "warn", weight: 2,
    title: "Contains a link",
    advice: "Don't open links from people you haven't met. They can steal your accounts.",
    res: [/(?:https?:\/\/|www\.|bit\.ly|tinyurl|t\.me\/|wa\.me\/|\b[a-z0-9-]+\.(?:xyz|top|click|link|site|online)\b)/] },
  { id: "urgency", level: "warn", weight: 2,
    title: "Pushes you to act fast or keep it secret",
    advice: "Pressure and secrecy are how scammers stop you from thinking or asking a friend.",
    res: [/\b(?:urgent(?:ly)?|emergency|right\s+now|immediately|asap|haraka|hurry|last\s+chance|today\s+only|don'?t\s+(?:tell|say)|keep\s+(?:this|it)\s+(?:a\s+)?secret|between\s+us|usimwambie)\b/] },
  { id: "story-weak", level: "info", weight: 1,
    title: "Mentions being abroad, military or a parcel",
    advice: "Not a problem by itself, but scammers often claim to be overseas or in the military.",
    res: [/\b(?:abroad|overseas|army|soldier|military|deployed|peacekeep\w*|diplomat|parcel|package)\b/] },
  { id: "offapp", level: "info", weight: 1,
    title: "Wants to move the chat elsewhere",
    advice: "Fine once you trust someone, but scammers move chats off-app to avoid being reported.",
    res: [
      /\b(?:whatsapp|telegram|signal|instagram|snapchat|facebook)\b[^.!?\n]{0,15}\b(?:me|number|chat|handle|dm)\b/,
      /\b(?:text|call|add|message|dm)\s+me\s+(?:on|at)\b/,
      /\b(?:move|switch|continue|talk|chat)\b[^.!?\n]{0,20}\b(?:to|on)\s+(?:whatsapp|telegram|signal|instagram|snapchat)\b/,
      /\bmy\s+(?:number|whatsapp)\s+(?:is|:)/, /(?:\+?254|\b0)[17]\d{8}\b/
    ] },
  { id: "intimacy", level: "info", weight: 1,
    title: "Declares strong feelings very early",
    advice: "Being swept off your feet quickly is a common tactic. Real trust takes time.",
    res: [/\b(?:i love you|i'?m\s+(?:so\s+|already\s+|really\s+)?in\s+love|in\s+love\s+with\s+you|soul\s?mate|god\s+sent\s+you|meant\s+to\s+be|marry\s+you|never\s+felt\s+this\s+way)\b/] },
  { id: "private", level: "info", weight: 1,
    title: "Suggests meeting somewhere private",
    advice: "For a first meeting, pick a public place and tell a friend where you'll be.",
    res: [/\b(?:come\s+(?:over\s+)?to\s+my\s+(?:place|house|room|hostel|apartment|flat)|my\s+place|nobody\s+(?:is\s+)?(?:home|there))\b/] }
];

function scamScan(text) {
  const t = String(text || "").toLowerCase();
  const hits = SCAM_RULES.filter(r => r.res.some(re => re.test(t)));
  const critical = hits.some(h => h.level === "critical");
  const score = hits.reduce((s, h) => s + h.weight, 0);
  const level = critical || score >= 4 ? "high" : score >= 2 ? "careful" : score >= 1 ? "low" : "none";
  return { level, hits, score };
}

const SCAM_VERDICTS = {
  high: { cls: "high", head: "High risk", line: "This message has strong scam warning signs. Don't send money, codes or photos." },
  careful: { cls: "careful", head: "Be careful", line: "A few warning signs showed up. Slow down and don't share anything private." },
  low: { cls: "low", head: "One small flag", line: "Only a minor warning sign. Keep your guard up as you get to know them." },
  none: { cls: "none", head: "No common warning signs found", line: "That doesn't prove the message is safe. Keep the usual rules: no money, no codes, meet in public." }
};

function runScamCheck() {
  const text = $("scamInput").value.trim();
  const box = $("scamResult");
  if (text.length < 4) {
    box.hidden = false;
    box.className = "scam-result low";
    box.innerHTML = `<p class="verdict-line">Paste a message first.</p>`;
    return;
  }
  const r = scamScan(text);
  const v = SCAM_VERDICTS[r.level];
  box.hidden = false;
  box.className = "scam-result " + v.cls;
  const reasons = r.hits.map(h => `<li><b>${esc(h.title)}</b><span>${esc(h.advice)}</span></li>`).join("");
  box.innerHTML = `
    <h3 class="verdict-head">${esc(v.head)}</h3>
    <p class="verdict-line">${esc(v.line)}</p>
    ${reasons ? `<ul class="reasons">${reasons}</ul>` : ""}
    <p class="fine-print">This checks for common warning words. It can miss scams and can flag honest messages. If something feels off, trust that feeling and ask a friend.</p>`;
}

function wireScam() {
  $("scamBtn").onclick = runScamCheck;
  $("scamClear").onclick = () => { $("scamInput").value = ""; $("scamResult").hidden = true; $("scamInput").focus(); };
}

// ============================================================================
// SAFETY CENTER — blocked list, feedback
// ============================================================================
function wireSafety() {
  $("fbForm").onsubmit = async (e) => {
    e.preventDefault();
    const text = clean($("fbText").value, 600);
    if (text.length < 5) return toast("Tell us a little more.", "err");
    const btn = $("fbSend");
    btn.disabled = true;
    try {
      await fsCreate("reports", `${currentUser.uid}_feedback_${Date.now()}`, {
        type: "feedback", topic: $("fbTopic").value, reporterUid: currentUser.uid, reportedUid: "",
        reason: text, status: "open", createdAt: new Date().toISOString()
      });
      $("fbText").value = "";
      toast("Sent. Thank you.");
    } catch (err) {
      console.error(err);
      toast("Couldn't send that. Try again.", "err");
    } finally {
      btn.disabled = false;
    }
  };
  renderBlockedList();
}

async function renderBlockedList() {
  const box = $("blockedList");
  if (!box || !myProfile) return;
  const ids = myProfile.blocked || [];
  if (!ids.length) { box.innerHTML = '<p class="muted">You haven\'t blocked anyone.</p>'; return; }
  let users;
  try { users = await Promise.all(ids.map(getUser)); }
  catch (e) { console.error(e); box.innerHTML = '<p class="muted">Couldn\'t load your blocked list.</p>'; return; }
  box.innerHTML = "";
  ids.forEach((id, i) => {
    const u = users[i];
    const row = document.createElement("div");
    row.className = "blocked-row";
    const name = document.createElement("span");
    name.textContent = u ? u.displayName : "Unknown member";
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn small ghost"; b.textContent = "Unblock";
    b.onclick = async () => {
      b.disabled = true;
      try {
        const blocked = (myProfile.blocked || []).filter(x => x !== id);
        await fsSet("users", currentUser.uid, { blocked });
        myProfile.blocked = blocked;
        toast("Unblocked.");
        await renderBlockedList();
        await loadDiscover();
      } catch (err) {
        console.error(err);
        b.disabled = false;
        toast("Couldn't unblock right now. Try again.", "err");
      }
    };
    row.append(name, b);
    box.appendChild(row);
  });
}

// ============================================================================
// PROFILE
// ============================================================================
function fillProfileForm() {
  const form = $("profileForm");
  const set = (name, v) => { const el = form.elements[name]; if (el) el.value = v == null ? "" : v; };
  set("displayName", myProfile.displayName);
  set("age", myProfile.age);
  const g = normGender(myProfile.gender);
  set("gender", /prefer/i.test(String(myProfile.gender || "")) ? "Prefer not to say" : g === "woman" ? "Woman" : g === "man" ? "Man" : g === "other" ? "Non-binary" : "");
  const p = normPref(myProfile.preference);
  set("preference", p === "woman" ? "Women" : p === "man" ? "Men" : "Everyone");
  set("course", myProfile.course);
  set("department", myProfile.department);
  set("year", myProfile.year);
  set("bio", myProfile.bio);
  updateBioCount();
}

function updateBioCount() {
  $("bioCount").textContent = `${$("pf_bio").value.length}/500`;
}

function wireProfile() {
  $("pf_bio").addEventListener("input", updateBioCount);
  $("previewProfileBtn").onclick = () => openProfileDialog(myProfile, { mode: "preview" });

  $("resetPassesBtn").onclick = async () => {
    const ok = await uiConfirm("This removes the Passed label from people you passed on, and brings back admirers you said Not now to.",
      { title: "Clear passed profiles?", okLabel: "Clear" });
    if (!ok) return;
    dismissedIds = new Set();
    saveDismissed();
    toast("Done. Passed profiles cleared.");
    await loadDiscover();
    await renderAdmirers();
    renderHome();
  };

  $("profileForm").onsubmit = async (e) => {
    e.preventDefault();
    hideMsg("profileMsg");
    const form = e.target;
    const department = form.elements.department.value;
    if (department && !DEPARTMENTS.includes(department)) {
      showMsg("profileMsg", "Choose a valid TUM department.", "err");
      return toast("Choose a valid department.", "err");
    }
    // Age lives only on this form — accounts created through the single
    // login box start with a placeholder age of 18, so this is the one place
    // the 18+ rule can still be enforced.
    const ageVal = form.elements.age.value;
    if (ageVal && !isAdultAge(ageVal)) {
      showMsg("profileMsg", "You must be 18 or older to use TUMingle.", "err");
      return toast("You must be 18 or older to use TUMingle.", "err");
    }
    const updates = {
      displayName: clean(form.elements.displayName.value, 40) || myProfile.displayName,
      age: ageVal ? Number(ageVal) : myProfile.age,
      gender: form.elements.gender.value,
      preference: form.elements.preference.value || "Everyone",
      course: clean(form.elements.course.value, 100),
      department: department || myProfile.department,
      year: clean(form.elements.year.value, 40),
      bio: clean(form.elements.bio.value, 500)
    };
    const btn = $("profileSave");
    btn.disabled = true;
    try {
      await fsSet("users", currentUser.uid, updates);
      Object.assign(myProfile, updates);
      setAuthStatus(myProfile.displayName || currentUser.email, "ok");
      renderHome();
      renderBioInterests();
      await loadDiscover(); // preferences may have changed who you can see
      toast("Profile saved.");
    } catch (err) {
      console.error(err);
      if (myProfile._unsaved) {
        showMsg("profileMsg", "Your profile couldn't be created on the server, so this change isn't being saved. Check your connection and reload.", "err");
      } else {
        showMsg("profileMsg", "Couldn't save your profile. Try again.", "err");
      }
      toast("Couldn't save your profile.", "err");
    } finally {
      btn.disabled = false;
    }
  };
}

// ---- Photos (Cloudinary unsigned upload) ----
function renderPhotoGrid() {
  const grid = $("photoGrid");
  grid.innerHTML = "";
  const raw = myProfile.photos || [];
  for (let i = 0; i < 6; i++) {
    const url = safePhotoUrl(raw[i]);
    const slot = document.createElement("div");
    slot.className = "photo-slot" + (url ? " filled" : "");
    slot.setAttribute("role", "button");
    slot.tabIndex = 0;
    if (url) {
      slot.style.backgroundImage = `url('${url}')`;
      slot.setAttribute("aria-label", i === 0 ? "Primary photo" : `Photo ${i + 1}. Press to make it your primary photo`);
      if (i === 0) {
        const badge = document.createElement("span");
        badge.className = "primary-badge";
        badge.textContent = "Primary";
        slot.appendChild(badge);
      }
      const del = document.createElement("button");
      del.type = "button";
      del.className = "del-btn";
      del.textContent = "✕";
      del.setAttribute("aria-label", `Delete photo ${i + 1}`);
      del.onclick = (ev) => { ev.stopPropagation(); deletePhoto(i); };
      slot.appendChild(del);
      slot.onclick = () => { if (i !== 0) makePrimaryPhoto(i); };
    } else {
      slot.innerHTML = '<span class="plus" aria-hidden="true">+</span>';
      slot.setAttribute("aria-label", "Add a photo");
      slot.onclick = triggerPhotoUpload;
    }
    slot.onkeydown = (ev) => {
      if ((ev.key === "Enter" || ev.key === " ") && ev.target === slot) { ev.preventDefault(); slot.click(); }
    };
    grid.appendChild(slot);
  }
}

function triggerPhotoUpload() {
  const photos = myProfile.photos || [];
  if (photos.length >= 6) return toast("Maximum 6 photos. Delete one to add another.", "err");
  $("photoFileInput").click();
}

async function uploadToCloudinary(file) {
  if (!cloudinaryConfig.cloudName || cloudinaryConfig.cloudName.startsWith("PASTE_")) {
    throw new Error("Cloudinary isn't configured yet — edit firebase-init.js with your cloud name.");
  }
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", cloudinaryConfig.uploadPreset);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/image/upload`, {
    method: "POST", body: form
  });
  if (!res.ok) throw new Error(`Cloudinary upload failed: ${res.status}`);
  const json = await res.json();
  return json.secure_url;
}

function wirePhotoUpload() {
  $("photoFileInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    // Validate type/size BEFORE anything else.
    const okTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!okTypes.includes(file.type)) return toast("Please choose a JPEG, PNG or WebP image.", "err");
    if (file.size > 5 * 1024 * 1024) return toast("Image must be under 5MB.", "err");

    const grid = $("photoGrid");
    grid.classList.add("busy");
    try {
      const url = await uploadToCloudinary(file);
      if (!safePhotoUrl(url)) throw new Error("Unexpected photo address from the upload service");
      const photos = [...(myProfile.photos || []), url];
      await fsSet("users", currentUser.uid, { photos });
      myProfile.photos = photos;
      renderPhotoGrid();
      renderHome();
      toast("Photo added.");
    } catch (err) {
      console.error(err);
      toast(err.message && !/^fsSet/.test(err.message) ? err.message : "Upload failed. Please try again.", "err");
    } finally {
      grid.classList.remove("busy");
    }
  };
}

async function deletePhoto(index) {
  const ok = await uiConfirm("It will be removed from your profile.", { title: "Delete this photo?", okLabel: "Delete", danger: true });
  if (!ok) return;
  // Removes the photo from the profile but not the underlying file from
  // Cloudinary storage (that needs a signed admin call with the API secret,
  // which must never live in client code). A harmless, known limitation.
  const photos = (myProfile.photos || []).filter((_, i) => i !== index);
  try {
    await fsSet("users", currentUser.uid, { photos });
    myProfile.photos = photos;
    renderPhotoGrid();
    renderHome();
  } catch (e) {
    console.error(e);
    toast("Couldn't delete that photo right now.", "err");
  }
}

async function makePrimaryPhoto(index) {
  const photos = [...(myProfile.photos || [])];
  const [chosen] = photos.splice(index, 1);
  photos.unshift(chosen);
  try {
    await fsSet("users", currentUser.uid, { photos });
    myProfile.photos = photos;
    renderPhotoGrid();
    toast("Primary photo updated.");
  } catch (e) {
    console.error(e);
    toast("Couldn't update your primary photo right now.", "err");
  }
}

// ---- Interests ----
function renderInterestGrid() {
  const grid = $("interestGrid");
  grid.innerHTML = "";
  const mine = new Set(myProfile.interests || []);
  INTEREST_TAGS.forEach(tag => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "interest-chip" + (mine.has(tag) ? " sel" : "");
    chip.textContent = tag;
    chip.setAttribute("aria-pressed", String(mine.has(tag)));
    chip.onclick = () => {
      const on = !chip.classList.contains("sel");
      chip.classList.toggle("sel", on);
      chip.setAttribute("aria-pressed", String(on));
    };
    grid.appendChild(chip);
  });
}

function wireInterests() {
  $("saveInterestsBtn").onclick = async () => {
    const selected = Array.from(document.querySelectorAll("#interestGrid .interest-chip.sel")).map(c => c.textContent).slice(0, 12);
    try {
      await fsSet("users", currentUser.uid, { interests: selected });
      myProfile.interests = selected;
      renderHome();
      renderBioInterests();
      await loadDiscover(); // compatibility scores depend on these
      toast("Interests saved.");
    } catch (e) {
      console.error(e);
      toast("Couldn't save interests.", "err");
    }
  };
}

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

function pushConfigured() {
  return !!vapidPublicKey && !String(vapidPublicKey).startsWith("PASTE_");
}

// Shown only when notifications can actually work. Until a VAPID key is set in
// firebase-init.js (and a send-only backend exists), a "Turn on notifications"
// button would just fail, so the whole card stays hidden instead.
function renderPushState() {
  const card = $("pushCard");
  if (card) card.hidden = !pushConfigured();
  const on = !!(myProfile && myProfile.pushSubscription);
  $("pushBox").classList.toggle("on", on);
  $("enablePushBtn").textContent = on ? "Notifications are on" : "Turn on notifications";
  $("enablePushBtn").disabled = on;
}

function wirePush() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isIOS && !isStandalone) $("iosPushNote").style.display = "block";

  $("enablePushBtn").onclick = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return toast("Push notifications aren't supported in this browser.", "err");
    }
    if (!pushConfigured()) {
      return toast("Push notifications aren't switched on for this app yet.", "err");
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return toast("Notification permission wasn't granted.", "err");

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });

      // Real push SENDING needs a server holding the VAPID private key (never
      // client code). sendPushToUser() below is a safe no-op until that exists.
      await fsSet("users", currentUser.uid, { pushSubscription: JSON.stringify(sub) });
      myProfile.pushSubscription = JSON.stringify(sub);
      renderPushState();
    } catch (e) {
      console.error(e);
      toast("Couldn't turn on notifications: " + (e.message || "unknown error"), "err");
    }
  };
}

// A real push needs the VAPID PRIVATE key, which can never live in client
// code. Until a small send-only backend exists (see push-notifications.md),
// this is a safe no-op so likes, matches and messages keep working.
async function sendPushToUser(userId, payload) {
  return;
}

// ============================================================================
// BOOT
// ============================================================================
wireAuthScreen();
wirePhotoUpload();
wireInterests();
initFirebase().catch(e => {
  console.error(e);
  document.body.classList.remove("booting");
  setAuthStatus("Setup error", "err");
  showMsg("authMsg", "Firebase isn't configured yet. Edit firebase-init.js with your project's real config values.", "err");
});
