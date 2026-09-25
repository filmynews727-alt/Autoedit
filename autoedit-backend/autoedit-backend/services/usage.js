const { getAdmin } = require('./auth');

// Plan limits — keep these in sync with the pricing shown on the frontend.
const PLAN_LIMITS = { starter: 5, creator: 60, agency: Infinity };

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-09"
}

// Checks whether this user still has quota this month. If Firebase/Firestore
// isn't configured, enforcement is skipped entirely (never blocks the app)
// — same graceful-fallback pattern used everywhere else in this backend.
async function checkUsage(uid) {
  const admin = getAdmin();
  if (!admin || !uid) return { allowed: true, enforced: false };

  const db = admin.firestore();
  const monthKey = currentMonthKey();
  const ref = db.collection('users').doc(uid);
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : {};
  const plan = data.plan || 'starter';
  const limit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;
  const used = (data.monthlyUsage && data.monthlyUsage[monthKey]) || 0;

  if (used >= limit) {
    return { allowed: false, enforced: true, plan, limit, used, monthKey };
  }
  return { allowed: true, enforced: true, plan, limit, used, monthKey, ref };
}

// Call this AFTER a video finishes processing successfully.
async function incrementUsage(uid) {
  const admin = getAdmin();
  if (!admin || !uid) return;
  const db = admin.firestore();
  const monthKey = currentMonthKey();
  const ref = db.collection('users').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const used = (data.monthlyUsage && data.monthlyUsage[monthKey]) || 0;
    tx.set(ref, { monthlyUsage: { ...(data.monthlyUsage || {}), [monthKey]: used + 1 } }, { merge: true });
  });
}

module.exports = { checkUsage, incrementUsage, PLAN_LIMITS };
