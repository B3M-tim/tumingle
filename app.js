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

function studentEmailValid(email) {
  return /^[^@\s]+@students\.tum\.ac\.ke$/i.test(String(email || "").trim());
}
function isAdultAge(age) {
  const n = Number(age);
  return Number.isInteger(n) && n >= 18 && n <= 100;
}
function clean(x, n) {
  return String(x == null ? "" : x).trim().slice(0, n || 500);
}
function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s == null ? "" : s);
  return d.innerHTML;
}

// ============================================================================
// FIRESTORE REST HELPERS
// Pattern carried over from the 3M app: talk to Firestore's REST API
// directly with fetch() + the Firebase Auth ID token as the bearer token,
// rather than pulling in the full Firestore SDK. Keeps this a single file
// with no build step, which is the whole point of this architecture.
// ============================================================================
let firebaseApp, auth, currentUser = null, idToken = null;
let FS_PROJECT, FS_BASE;
// Set true while the signup handler is between creating the Auth account
// and finishing the Firestore profile write. onAuthStateChanged fires as
// soon as the Auth account exists, which can race ahead of that write —
// without this flag, the listener would see no profile yet and wrongly
// boot a brand-new user back to the auth screen with an error.
let signupInFlight = false;
let tokenRefreshTimer = null;

function toFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else if (typeof v === "number") fields[k] = Number.isInteger(v) ? { integerValue: v } : { doubleValue: v };
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
  const res = await fetch(`${FS_BASE}/${collection}/${encodeURIComponent(docId)}`, {
    headers: { "Authorization": `Bearer ${idToken}` }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fsGet ${collection}/${docId}: ${res.status}`);
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
  const maskParams = Object.keys(data)
    .map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const url = `${FS_BASE}/${collection}/${encodeURIComponent(docId)}${maskParams ? "?" + maskParams : ""}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`fsSet ${collection}/${docId}: ${res.status} ${await res.text()}`);
  return await res.json();
}

// fsCreate: a REAL create, for the one spot (signup) where the document is
// guaranteed not to exist yet.
//
// Why this can't just be fsSet(): fsSet() always sends PATCH with an
// updateMask (required so routine profile *updates* don't wipe fields the
// request didn't mention — see the comment above fsSet). But Firestore
// evaluates ANY masked PATCH — even one aimed at a document that doesn't
// exist — as an "update", not a "create". The users/{userId} rule's
// `allow update` reads `resource.data.verified`, and `resource` is the
// document as it stood BEFORE this write — which doesn't exist yet at
// signup, so `resource.data` is null and `resource.data.verified` throws
// inside the rule. The result is a guaranteed, 100%-reproducible
// permission-denied on every single signup, every time (confirmed live:
// the Auth account gets created, the Firestore profile write silently
// fails right after, every attempt — not an intermittent fluke).
//
// The fix is to use Firestore's real create endpoint instead: POST to the
// collection with ?documentId=<uid>, no updateMask involved at all. That's
// evaluated under `allow create`, which only checks request.auth.uid —
// it never touches resource.data, so there's nothing to throw on.
async function fsCreate(collection, docId, data) {
  const url = `${FS_BASE}/${collection}?documentId=${encodeURIComponent(docId)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: toFirestoreFields(data) })
  });
  if (!res.ok) throw new Error(`fsCreate ${collection}/${docId}: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function fsDelete(collection, docId) {
  const res = await fetch(`${FS_BASE}/${collection}/${encodeURIComponent(docId)}`, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${idToken}` }
  });
  return res.ok || res.status === 404;
}

// runQuery, not plain collection GET — plain GETs 403 against real
// security rules (confirmed the hard way in 3M). where/orderBy are
// optional; pass {} for an unfiltered query against a collection.
async function fsQuery(collectionId, { where, limit } = {}) {
  const structuredQuery = { from: [{ collectionId }], limit: limit || 300 };
  if (where) structuredQuery.where = where;
  const res = await fetch(`${FS_BASE}:runQuery`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery })
  });
  if (!res.ok) throw new Error(`fsQuery ${collectionId}: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return (rows || [])
    .filter(r => r.document)
    .map(r => ({ id: r.document.name.split("/").pop(), ...fromFirestoreFields(r.document.fields) }));
}

function fieldFilter(fieldPath, op, value) {
  const valueField = typeof value === "number"
    ? (Number.isInteger(value) ? { integerValue: value } : { doubleValue: value })
    : typeof value === "boolean" ? { booleanValue: value }
    : { stringValue: String(value) };
  return { fieldFilter: { field: { fieldPath }, op, value: valueField } };
}
function andFilter(filters) {
  return { compositeFilter: { op: "AND", filters } };
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
  document.getElementById("logoutBtn").style.display = which === "auth" ? "none" : "inline-block";
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

  firebaseApp = initializeApp(firebaseConfig);
  auth = authMod.getAuth(firebaseApp);
  FS_PROJECT = firebaseConfig.projectId;
  FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/default/documents`;

  authMod.onAuthStateChanged(auth, async (user) => {
    if (!user) {
      currentUser = null; idToken = null; myProfile = null;
      setAuthStatus("Logged out");
      showScreen("auth");
      return;
    }
    currentUser = user;
    idToken = await user.getIdToken();
    // Keep token fresh for long sessions. Clear any previous timer first —
    // this listener can fire more than once per page load (e.g. external
    // token changes), and without clearing we'd stack up a new interval
    // each time.
    if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
    tokenRefreshTimer = setInterval(async () => {
      try { idToken = await currentUser.getIdToken(true); } catch (_) {}
    }, 50 * 60 * 1000);

    try {
      myProfile = await fsGet("users", user.uid);
      if (!myProfile) {
        if (signupInFlight) {
          // The Firestore profile write is still in flight from signup —
          // this isn't a real error, just this listener winning a race
          // against that write. Wait briefly and check again rather than
          // showing the new user an error about their own fresh account.
          await new Promise(r => setTimeout(r, 700));
          myProfile = await fsGet("users", user.uid);
        }
      }
      if (!myProfile) {
        // TEMPORARY, by explicit instruction (2026-10-12): the Firestore
        // write at signup is failing for a reason not yet root-caused —
        // confirmed to still fail even with a real, correctly-configured
        // Firestore database and published rules, so the actual cause is
        // still unknown. Rather than lock everyone out until that's
        // solved, we now let the person into the app on a LOCAL-ONLY
        // placeholder profile instead of blocking here.
        //
        // Real, lasting consequences of this, not cosmetic ones:
        //   - Nothing about this profile is saved anywhere. Refreshing
        //     the page, logging out, or opening the app on another
        //     device loses it completely — it's recreated empty every
        //     time this listener runs with no Firestore doc behind it.
        //   - Every OTHER profile-dependent feature (editing the profile
        //     from the Profile tab, appearing in other students'
        //     Discover stacks, being likeable/matchable) still calls the
        //     same broken fsSet()/fsCreate() underneath, so those will
        //     keep failing too, not just signup. This does not fix the
        //     app end-to-end — it only stops this ONE screen from
        //     blocking entry.
        // Revisit by replacing this fallback once the real Firestore
        // write failure is root-caused — see conversation history
        // 2026-10-11/12 for what's been ruled out so far (SDK, rules
        // content, wrong project, missing database all checked and
        // eliminated; exact cause still open).
        myProfile = {
          id: user.uid, displayName: user.email.split("@")[0], email: user.email,
          age: 18, gender: "", preference: "Everyone",
          course: "", department: "", year: "", bio: "",
          interests: [], photos: [], blocked: [],
          verified: true, createdAt: new Date().toISOString(),
          _unsaved: true // other code can check this if it needs to know
        };
        showMsg("authMsg", "Note: profile saving is temporarily unavailable — changes won't persist yet.", "info");
      }
      setAuthStatus(myProfile.displayName || user.email, "ok");
      showScreen("app");
      enterApp();
    } catch (e) {
      console.error(e);
      setAuthStatus("Error loading profile", "err");
      showMsg("authMsg", "Couldn't load your profile. Check your connection and refresh.", "err");
    }
  });
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

        // No account yet for this email — this is this student's first
        // time, so create one now instead of making them go through a
        // separate signup screen. Still requires a real TUM email and an
        // 8+ character password, same as before — just no extra step.
        if (!studentEmailValid(email)) {
          showMsg("authMsg", "Use your TUM student email ending in @students.tum.ac.ke.", "err");
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
        FS_PROJECT = firebaseConfig.projectId;
        FS_BASE = `https://firestore.googleapis.com/v1/projects/${FS_PROJECT}/databases/default/documents`;
        // Minimal profile — just enough to use the app. The rest (name,
        // course, department, bio, photos...) gets filled in from the
        // Profile tab, same data as before, just collected after entry
        // instead of before it.
        try {
          await fsCreate("users", cred.user.uid, {
            displayName: email.split("@")[0], email,
            age: 18, gender: "", preference: "Everyone",
            course: "", department: "", year: "",
            bio: "", interests: [], photos: [], blocked: [],
            verified: true, createdAt: new Date().toISOString()
          });
          // onAuthStateChanged fires automatically and routes into the app.
        } catch (fsErr) {
          // TEMPORARY, by explicit instruction (2026-10-12): this write is
          // failing for a reason not yet root-caused (see the matching
          // note in onAuthStateChanged above for what's been ruled out).
          // Deliberately NOT re-thrown — a real Firebase Auth account now
          // exists either way, and onAuthStateChanged's own fallback will
          // let the person into the app on a local, unsaved placeholder
          // profile rather than stranding them at this login box with an
          // account that technically exists but can never get in.
          console.error("Profile create failed (continuing with unsaved fallback):", fsErr);
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

  document.getElementById("logoutBtn").onclick = async () => {
    const authMod = window.__fbAuthMod;
    await authMod.signOut(auth);
  };
}

// ============================================================================
// APP SHELL — tabs
// ============================================================================
let appEntered = false;
function enterApp() {
  if (appEntered) {
    // Returning to the app (e.g. after verifying) — just refresh data.
    loadDiscover(); loadMatches(); fillProfileForm(); renderPhotoGrid(); renderInterestGrid();
    return;
  }
  appEntered = true;

  document.querySelectorAll(".tab").forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(tab.dataset.panel).classList.add("active");
      closeChatView();
    };
  });

  populateDeptSelect(document.getElementById("profileDept"));
  wireDiscover();
  wireProfile();
  wireMatches();
  wirePush();

  loadDiscover();
  loadMatches();
  fillProfileForm();
  renderPhotoGrid();
  renderInterestGrid();
}

// ============================================================================
// DISCOVER / SWIPE
// ============================================================================
let discoverQueue = [];
let myLikedIds = new Set();
let myBlockedIds = new Set();

async function fetchUsersBatch() {
  // No practical way to express "not me, not already liked, not blocked"
  // as a single Firestore query (dynamic NOT-IN lists aren't well
  // supported), so fetch a batch and filter client-side — same approach
  // used in 3M for equivalent exclusion logic.
  return fsQuery("users", { limit: 100 });
}

async function loadDiscover() {
  hideMsg("discoverMsg");
  try {
    const [likes, allUsers] = await Promise.all([
      fsQuery("likes", { where: fieldFilter("from", "EQUAL", currentUser.uid) }),
      fetchUsersBatch()
    ]);
    myLikedIds = new Set(likes.map(l => l.to));
    myBlockedIds = new Set(myProfile.blocked || []);

    const myPref = (myProfile.preference || "Everyone").toLowerCase();
    discoverQueue = allUsers.filter(u => {
      if (u.id === currentUser.uid) return false;
      if (myLikedIds.has(u.id)) return false;
      if (myBlockedIds.has(u.id)) return false;
      if ((u.blocked || []).includes(currentUser.uid)) return false; // they blocked me
      const theirPref = (u.preference || "Everyone").toLowerCase();
      const iMatchThem = myPref === "everyone" || myPref === String(u.gender || "").toLowerCase();
      const theyMatchMe = theirPref === "everyone" || theirPref === String(myProfile.gender || "").toLowerCase();
      return iMatchThem && theyMatchMe;
    });
    renderStack();
  } catch (e) {
    console.error(e);
    showMsg("discoverMsg", "Couldn't load profiles. Check your connection and try again.", "err");
  }
}

function renderStack() {
  const stack = document.getElementById("stack");
  stack.innerHTML = "";
  if (discoverQueue.length === 0) {
    stack.innerHTML = '<div class="empty-state">No more profiles right now.<br>Check back later, or widen your preferences in Profile.</div>';
    return;
  }
  // Render top 2 for a slight depth effect; only the top one is interactive.
  discoverQueue.slice(0, 2).reverse().forEach((u, idx, arr) => {
    const isTop = idx === arr.length - 1;
    const card = document.createElement("div");
    card.className = "swipe-card";
    if (!isTop) { card.style.transform = "scale(.96) translateY(8px)"; card.style.opacity = ".6"; card.style.pointerEvents = "none"; }
    const photo = (u.photos && u.photos[0]) || "";
    card.innerHTML = `
      ${photo ? `<div class="photo-slot-view" style="background-image:url('${esc(photo)}')"></div>` : `<div class="photo-slot-view">No photo yet</div>`}
      <h3>${esc(u.displayName)}, ${esc(u.age)}</h3>
      <div class="dept">${esc(u.department || "Department not set")}</div>
      <div class="meta">${esc(u.course || "")} • ${esc(u.year || "")}</div>
      <div class="bio">${esc(u.bio || "No bio yet.")}</div>
      <div class="tag-row">${(u.interests || []).map(i => `<span class="tag">${esc(i)}</span>`).join("")}</div>
    `;
    if (isTop) attachDrag(card, u);
    stack.appendChild(card);
  });
}

function attachDrag(card, user) {
  let startX = 0, currentX = 0, dragging = false;
  const threshold = 90;

  function onStart(x) { dragging = true; startX = x; card.style.transition = "none"; }
  function onMove(x) {
    if (!dragging) return;
    currentX = x - startX;
    card.style.transform = `translateX(${currentX}px) rotate(${currentX / 20}deg)`;
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    card.style.transition = "transform .25s ease";
    if (currentX > threshold) { decide(user, "like"); }
    else if (currentX < -threshold) { decide(user, "pass"); }
    else { card.style.transform = ""; }
    currentX = 0;
  }
  card.addEventListener("mousedown", e => onStart(e.clientX));
  window.addEventListener("mousemove", e => onMove(e.clientX));
  window.addEventListener("mouseup", onEnd);
  card.addEventListener("touchstart", e => onStart(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchmove", e => onMove(e.touches[0].clientX), { passive: true });
  card.addEventListener("touchend", onEnd);
}

async function decide(user, action) {
  discoverQueue = discoverQueue.filter(u => u.id !== user.id);
  renderStack();
  if (action === "pass") return;

  try {
    await fsSet("likes", `${currentUser.uid}_${user.id}`, {
      from: currentUser.uid, to: user.id, createdAt: new Date().toISOString()
    });
    myLikedIds.add(user.id);
    // Check for mutual match.
    const theirLike = await fsGet("likes", `${user.id}_${currentUser.uid}`);
    if (theirLike) {
      alert(`It's a match! You and ${user.displayName} liked each other. ♥`);
      loadMatches();
      sendPushToUser(user.id, { title: "New match!", body: `You and ${myProfile.displayName} matched on TUMingle.` });
    }
  } catch (e) {
    console.error(e);
    showMsg("discoverMsg", "Couldn't save that like — it may not have gone through.", "err");
  }
}

function wireDiscover() {
  document.getElementById("likeBtn").onclick = () => {
    if (discoverQueue[0]) decide(discoverQueue[0], "like");
  };
  document.getElementById("passBtn").onclick = () => {
    if (discoverQueue[0]) decide(discoverQueue[0], "pass");
  };
  document.getElementById("blockProfileBtn").onclick = async () => {
    const u = discoverQueue[0];
    if (!u) return;
    if (!confirm(`Block ${u.displayName}? You won't see each other again.`)) return;
    try {
      const updatedBlocked = Array.from(new Set([...(myProfile.blocked || []), u.id]));
      await fsSet("users", currentUser.uid, { blocked: updatedBlocked });
      myProfile.blocked = updatedBlocked;
      // Also remove any like I'd sent them, symmetric with the original backend's block behavior.
      await fsDelete("likes", `${currentUser.uid}_${u.id}`);
      discoverQueue = discoverQueue.filter(x => x.id !== u.id);
      renderStack();
    } catch (e) {
      console.error(e);
      alert("Couldn't block this profile right now.");
    }
  };
  document.getElementById("reportProfileBtn").onclick = async () => {
    const u = discoverQueue[0];
    if (!u) return;
    const reason = prompt(`Why are you reporting ${u.displayName}?`);
    if (!reason) return;
    try {
      const reportId = `${currentUser.uid}_${u.id}_${Date.now()}`;
      await fsSet("reports", reportId, {
        reporterUid: currentUser.uid, reportedUid: u.id, reason: clean(reason, 500),
        status: "open", createdAt: new Date().toISOString()
      });
      alert("Report submitted. Thank you.");
    } catch (e) {
      console.error(e);
      alert("Couldn't submit the report right now.");
    }
  };
}

// ============================================================================
// MATCHES + CHAT
// ============================================================================
let currentChatPartner = null;

async function loadMatches() {
  try {
    const myLikes = await fsQuery("likes", { where: fieldFilter("from", "EQUAL", currentUser.uid) });
    const mutualIds = [];
    for (const l of myLikes) {
      const back = await fsGet("likes", `${l.to}_${currentUser.uid}`);
      if (back) mutualIds.push(l.to);
    }
    const list = document.getElementById("matchesList");
    if (mutualIds.length === 0) {
      list.innerHTML = '<div class="empty-state">No matches yet. Keep swiping in Discover!</div>';
      return;
    }
    const users = await Promise.all(mutualIds.map(id => fsGet("users", id)));
    list.innerHTML = "";
    users.filter(Boolean).forEach(u => {
      const row = document.createElement("div");
      row.className = "match-row";
      const photo = (u.photos && u.photos[0]) || "";
      row.innerHTML = `
        <div class="av" style="${photo ? `background-image:url('${esc(photo)}')` : ""}">${photo ? "" : esc((u.displayName || "?")[0])}</div>
        <div><div class="nm">${esc(u.displayName)}</div><div class="dp">${esc(u.department || "")}</div></div>
      `;
      row.onclick = () => openChat(u);
      list.appendChild(row);
    });
  } catch (e) {
    console.error(e);
    document.getElementById("matchesList").innerHTML = '<div class="empty-state">Couldn\'t load matches. Try again shortly.</div>';
  }
}

function wireMatches() {
  document.getElementById("backToMatches").onclick = closeChatView;
  document.getElementById("chatForm").onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById("chatInput");
    const text = clean(input.value, 1000);
    if (!text || !currentChatPartner) return;
    input.value = "";
    try {
      const msgId = `${currentUser.uid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      await fsSet("messages", msgId, {
        from: currentUser.uid, to: currentChatPartner.id, text, createdAt: new Date().toISOString()
      });
      appendBubble(text, true);
      sendPushToUser(currentChatPartner.id, { title: myProfile.displayName, body: text });
    } catch (e) {
      console.error(e);
      alert("Message couldn't be sent. You may have unmatched, or your connection dropped.");
    }
  };
  document.getElementById("unmatchBtn").onclick = async () => {
    if (!currentChatPartner) return;
    if (!confirm(`Unmatch ${currentChatPartner.displayName}? This will delete your message history and can't be undone.`)) return;
    await unmatchUser(currentChatPartner.id);
  };
}

function closeChatView() {
  document.getElementById("chatView").classList.remove("active");
  document.getElementById("matchesList").style.display = "block";
  currentChatPartner = null;
}

async function openChat(user) {
  currentChatPartner = user;
  document.getElementById("matchesList").style.display = "none";
  document.getElementById("chatView").classList.add("active");
  document.getElementById("chatWithName").textContent = user.displayName;
  await loadMessages(user.id);
}

async function loadMessages(otherId) {
  const box = document.getElementById("chatMessages");
  box.innerHTML = '<div class="empty-state">Loading…</div>';
  try {
    // Fetch both directions, since a single query can't OR across from/to.
    const [sent, received] = await Promise.all([
      fsQuery("messages", { where: andFilter([fieldFilter("from", "EQUAL", currentUser.uid), fieldFilter("to", "EQUAL", otherId)]) }),
      fsQuery("messages", { where: andFilter([fieldFilter("from", "EQUAL", otherId), fieldFilter("to", "EQUAL", currentUser.uid)]) })
    ]);
    const all = [...sent, ...received].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    box.innerHTML = "";
    if (all.length === 0) {
      box.innerHTML = '<div class="empty-state">Say hello 👋</div>';
      return;
    }
    all.forEach(m => appendBubble(m.text, m.from === currentUser.uid));
  } catch (e) {
    console.error(e);
    box.innerHTML = '<div class="empty-state">Couldn\'t load messages.</div>';
  }
}

function appendBubble(text, mine) {
  const box = document.getElementById("chatMessages");
  const el = document.createElement("div");
  el.className = "bubble " + (mine ? "mine" : "theirs");
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// Fetch every message in one direction between two users, with real
// document IDs attached, so each can be deleted individually. Needed
// because Firestore REST deletes are by-ID only — there's no
// "delete where" operation.
async function fetchDirectionWithIds(fromId, toId) {
  return fsQuery("messages", { where: andFilter([fieldFilter("from", "EQUAL", fromId), fieldFilter("to", "EQUAL", toId)]) });
}

async function unmatchUser(otherId) {
  try {
    // Remove BOTH like directions — a match only exists while both exist,
    // so leaving either one behind would silently resurrect the match.
    await Promise.all([
      fsDelete("likes", `${currentUser.uid}_${otherId}`),
      fsDelete("likes", `${otherId}_${currentUser.uid}`)
    ]);
    // Delete all messages in both directions.
    const [mine, theirs] = await Promise.all([
      fetchDirectionWithIds(currentUser.uid, otherId),
      fetchDirectionWithIds(otherId, currentUser.uid)
    ]);
    await Promise.all([...mine, ...theirs].map(m => fsDelete("messages", m.id)));

    closeChatView();
    loadMatches();
    loadDiscover();
  } catch (e) {
    console.error(e);
    alert("Unmatch didn't fully complete — please try again, or refresh and check your matches.");
  }
}

// ============================================================================
// PROFILE
// ============================================================================
function fillProfileForm() {
  const form = document.getElementById("profileForm");
  for (const [k, v] of Object.entries(myProfile)) {
    const el = form.elements[k];
    if (el) el.value = v == null ? "" : v;
  }
}

function wireProfile() {
  document.getElementById("profileForm").onsubmit = async (e) => {
    e.preventDefault();
    hideMsg("profileMsg");
    const form = e.target;
    const department = form.elements.department.value;
    if (department && !DEPARTMENTS.includes(department)) {
      return showMsg("profileMsg", "Choose a valid TUM department.", "err");
    }
    // Age now lives only on this form — accounts created through the
    // single login/signup box (see loginBtn in wireAuthScreen) start with
    // a placeholder age of 18 and no other way to correct it, so this is
    // the one place that validation can still be enforced.
    const ageVal = form.elements.age.value;
    if (ageVal && !isAdultAge(ageVal)) {
      return showMsg("profileMsg", "You must be 18 or older to use TUMingle.", "err");
    }
    const updates = {
      displayName: clean(form.elements.displayName.value, 40) || myProfile.displayName,
      age: ageVal ? Number(ageVal) : myProfile.age,
      gender: clean(form.elements.gender.value, 30),
      preference: clean(form.elements.preference.value, 40) || "Everyone",
      course: clean(form.elements.course.value, 100),
      department: department || myProfile.department,
      year: clean(form.elements.year.value, 40),
      bio: clean(form.elements.bio.value, 500)
    };
    try {
      await fsSet("users", currentUser.uid, updates);
      Object.assign(myProfile, updates);
      showMsg("profileMsg", "Profile saved.", "ok");
    } catch (e) {
      console.error(e);
      // myProfile._unsaved (set in onAuthStateChanged's fallback) means
      // there's no real document in Firestore for this account at all —
      // "try again" would be misleading, since no amount of retrying
      // fixes that; it needs the underlying write bug fixed first.
      if (myProfile._unsaved) {
        showMsg("profileMsg", "Profile saving is temporarily unavailable — this change isn't being saved yet. It'll work once this is fixed.", "err");
      } else {
        showMsg("profileMsg", "Couldn't save your profile. Try again.", "err");
      }
    }
  };
}

// ---- Photos (Cloudinary unsigned upload) ----
function renderPhotoGrid() {
  const grid = document.getElementById("photoGrid");
  grid.innerHTML = "";
  const photos = myProfile.photos || [];
  for (let i = 0; i < 6; i++) {
    const slot = document.createElement("div");
    const url = photos[i];
    if (url) {
      slot.className = "photo-slot filled";
      slot.style.backgroundImage = `url('${url}')`;
      if (i === 0) {
        const badge = document.createElement("span");
        badge.className = "primary-badge";
        badge.textContent = "Primary";
        slot.appendChild(badge);
      }
      const del = document.createElement("button");
      del.className = "del-btn";
      del.textContent = "✕";
      del.title = "Delete photo";
      del.onclick = (ev) => { ev.stopPropagation(); deletePhoto(i); };
      slot.appendChild(del);
      slot.onclick = () => { if (i !== 0) makePrimaryPhoto(i); };
    } else {
      slot.className = "photo-slot";
      slot.innerHTML = '<span class="plus">+</span>';
      slot.onclick = () => triggerPhotoUpload();
    }
    grid.appendChild(slot);
  }
}

function triggerPhotoUpload() {
  const photos = myProfile.photos || [];
  if (photos.length >= 6) return alert("Maximum 6 photos.");
  document.getElementById("photoFileInput").click();
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
  document.getElementById("photoFileInput").onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;

    // Validate type/size BEFORE anything else — this ordering bug bit us
    // once already in the old backend (config checked before file type),
    // so type/size validation runs first here, unconditionally.
    const okTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!okTypes.includes(file.type)) {
      return alert("Please choose a JPEG, PNG, or WebP image.");
    }
    if (file.size > 5 * 1024 * 1024) {
      return alert("Image must be under 5MB.");
    }

    try {
      const url = await uploadToCloudinary(file);
      const photos = [...(myProfile.photos || []), url];
      await fsSet("users", currentUser.uid, { photos });
      myProfile.photos = photos;
      renderPhotoGrid();
    } catch (err) {
      console.error(err);
      alert(err.message || "Upload failed. Please try again.");
    }
  };
}

async function deletePhoto(index) {
  if (!confirm("Delete this photo?")) return;
  // Note: this removes the photo from the profile but does not delete the
  // underlying file from Cloudinary storage (that requires a signed admin
  // API call, which needs the API secret — not safe to do client-side).
  // A harmless, known limitation, same as flagged in the original README.
  const photos = (myProfile.photos || []).filter((_, i) => i !== index);
  try {
    await fsSet("users", currentUser.uid, { photos });
    myProfile.photos = photos;
    renderPhotoGrid();
  } catch (e) {
    console.error(e);
    alert("Couldn't delete that photo right now.");
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
  } catch (e) {
    console.error(e);
    alert("Couldn't update your primary photo right now.");
  }
}

// ---- Interests ----
function renderInterestGrid() {
  const grid = document.getElementById("interestGrid");
  grid.innerHTML = "";
  const mine = new Set(myProfile.interests || []);
  INTEREST_TAGS.forEach(tag => {
    const chip = document.createElement("div");
    chip.className = "interest-chip" + (mine.has(tag) ? " sel" : "");
    chip.textContent = tag;
    chip.onclick = () => { chip.classList.toggle("sel"); };
    grid.appendChild(chip);
  });
}

function wireInterests() {
  document.getElementById("saveInterestsBtn").onclick = async () => {
    const selected = Array.from(document.querySelectorAll(".interest-chip.sel")).map(c => c.textContent).slice(0, 12);
    try {
      await fsSet("users", currentUser.uid, { interests: selected });
      myProfile.interests = selected;
      showMsg("profileMsg", "Interests saved.", "ok");
    } catch (e) {
      console.error(e);
      showMsg("profileMsg", "Couldn't save interests.", "err");
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

function wirePush() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
  if (isIOS && !isStandalone) {
    document.getElementById("iosPushNote").style.display = "block";
  }

  document.getElementById("enablePushBtn").onclick = async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      return alert("Push notifications aren't supported in this browser.");
    }
    if (!vapidPublicKey || vapidPublicKey.startsWith("PASTE_")) {
      return alert("Push notifications aren't configured yet for this app.");
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return alert("Notifications permission was not granted.");

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });

      // Store the subscription on the user's profile document. Real push
      // SENDING requires a server with the VAPID private key (never put a
      // private key in client code) — see push-notifications.md for how
      // to wire up the small send-only function this needs eventually.
      // sendPushToUser() below is a safe no-op stub until that exists.
      await fsSet("users", currentUser.uid, { pushSubscription: JSON.stringify(sub) });
      myProfile.pushSubscription = JSON.stringify(sub);

      document.getElementById("pushBox").classList.add("on");
      document.getElementById("enablePushBtn").textContent = "Notifications enabled ✓";
      document.getElementById("enablePushBtn").disabled = true;
    } catch (e) {
      console.error(e);
      alert("Couldn't enable notifications: " + (e.message || "unknown error"));
    }
  };

  if (myProfile && myProfile.pushSubscription) {
    document.getElementById("pushBox").classList.add("on");
    document.getElementById("enablePushBtn").textContent = "Notifications enabled ✓";
    document.getElementById("enablePushBtn").disabled = true;
  }
}

// Sending a real push notification needs the VAPID PRIVATE key, which can
// never live in client-side code (it would let anyone impersonate your
// server and spam any subscriber). Until a small send-only backend
// function exists for this, this is a safe no-op: it doesn't throw, it
// just does nothing, so the rest of the app (likes, matches, messages)
// keeps working today even though push sending itself is wired up later.
// See push-notifications.md for the minimal way to add this (a single
// Cloudflare Worker endpoint, still free, still no card required).
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
  setAuthStatus("Setup error", "err");
  showMsg("authMsg", "Firebase isn't configured yet. Edit firebase-init.js with your project's real config values.", "err");
});
