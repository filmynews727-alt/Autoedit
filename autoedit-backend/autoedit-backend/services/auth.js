// Verifies the Firebase ID token the frontend sends with every request, so
// the backend knows this call really came from a signed-in user — not just
// anyone who found the URL. Without FIREBASE_SERVICE_ACCOUNT_JSON set, this
// gracefully no-ops (falls back to the APP_SECRET_KEY-only check in
// server.js) so the app still works while you're setting Firebase up.

let admin = null;
let initialized = false;

function ensureInit() {
  if (initialized) return admin !== null;
  initialized = true;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return false;
  try {
    admin = require('firebase-admin');
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    return true;
  } catch (e) {
    console.warn('Firebase Admin init failed — falling back to app-key-only auth:', e.message);
    admin = null;
    return false;
  }
}

function isConfigured() {
  return ensureInit();
}

// Exposes the initialized admin SDK instance (e.g. for services/usage.js to
// read/write Firestore) — null if Firebase isn't configured.
function getAdmin() {
  return ensureInit() ? admin : null;
}

// Express middleware: verifies the Authorization: Bearer <idToken> header.
// If Firebase isn't configured at all, it lets the request through (the
// APP_SECRET_KEY check in server.js is still the gate in that case).
// If Firebase IS configured, a missing/invalid token is rejected — this is
// the real "only logged-in users" security layer.
function requireFirebaseAuth(req, res, next) {
  if (!ensureInit()) return next();
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please sign in to use AutoEdit AI.' });

  admin.auth().verifyIdToken(token)
    .then((decoded) => { req.user = decoded; next(); })
    .catch(() => res.status(401).json({ error: 'Your session has expired — please sign in again.' }));
}

module.exports = { isConfigured, requireFirebaseAuth, getAdmin };
