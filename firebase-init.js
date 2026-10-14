// ============================================================================
// FIREBASE PROJECT CONFIG — edit this block with YOUR real values.
// ============================================================================
// Where to find these: Firebase console → gear icon (top left) → Project
// settings → scroll to "Your apps" → the web app you registered → the
// firebaseConfig object is shown there, or re-click "SDK setup and
// configuration" if you don't see it.
//
// These values are NOT secret — they identify your project, they don't
// authorize anything by themselves. It's normal and expected for them to
// be visible in a browser's page source. Security comes from
// firestore.rules (already published) and Firebase Authentication, not
// from hiding this config.
// ============================================================================
const firebaseConfig = {
  apiKey: "AIzaSyAgHVepFvjswOS4WTLouxAUVRhebv3gDgE",
  authDomain: "tumingle-t.firebaseapp.com",
  projectId: "tumingle-t",
  storageBucket: "tumingle-t.firebasestorage.app",
  messagingSenderId: "422308359227",
  appId: "1:422308359227:web:11307627e52bf505c4801e"
};

// ============================================================================
// CLOUDINARY CONFIG — your unsigned upload preset.
// ============================================================================
// cloudName: Cloudinary dashboard → shown at the top as "Cloud name".
// uploadPreset: the preset you created — "tumingle_unsigned".
// ============================================================================
const cloudinaryConfig = {
  cloudName: "jazlor7n",
  uploadPreset: "tumingle_unsigned"
};

// ============================================================================
// VAPID PUBLIC KEY — for push notifications.
// ============================================================================
// This is generated once and is safe to be public (it's the "public" half
// of a keypair, like the public key in HTTPS). See push-notifications.md
// for how to generate this pair — it does NOT require any paid account.
// Leave the placeholder in place and the Enable Notifications button will
// just explain that push isn't configured yet, instead of breaking.
// ============================================================================
const vapidPublicKey = "PASTE_YOUR_VAPID_PUBLIC_KEY_HERE";
