const { getAdmin } = require('./auth');

// A single Firestore document that tracks totals across ALL users — this is
// what powers the /admin dashboard so you don't have to check 5 different
// service dashboards separately. No-ops if Firestore isn't configured.
function statsRef() {
  const admin = getAdmin();
  if (!admin) return null;
  return admin.firestore().collection('stats').doc('global');
}

async function increment(fields) {
  const ref = statsRef();
  if (!ref) return;
  const admin = getAdmin();
  const inc = {};
  for (const [key, amount] of Object.entries(fields)) {
    inc[key] = admin.firestore.FieldValue.increment(amount);
  }
  try { await ref.set(inc, { merge: true }); }
  catch (e) { console.warn('Stats increment failed:', e.message); }
}

async function getStats() {
  const ref = statsRef();
  if (!ref) return null;
  try {
    const snap = await ref.get();
    return snap.exists ? snap.data() : {};
  } catch (e) {
    console.warn('Stats read failed:', e.message);
    return {};
  }
}

module.exports = { increment, getStats };
