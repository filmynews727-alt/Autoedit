const crypto = require('crypto');
const Razorpay = require('razorpay');

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}
function client() {
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
}

// Keep these in sync with what's shown on the frontend pricing page.
const PLAN_PRICES_INR = { creator: 999, agency: 3499 };

async function createOrder(plan) {
  if (!isConfigured()) throw new Error('Payments are not set up on this server yet');
  const amount = PLAN_PRICES_INR[plan];
  if (!amount) throw new Error('Invalid plan selected');
  return client().orders.create({ amount: amount * 100, currency: 'INR', notes: { plan } }); // amount is in paise
}

// Verifies the signature Razorpay sends back after a successful checkout —
// this is what proves the payment is real and wasn't spoofed by the browser.
function verifySignature({ orderId, paymentId, signature }) {
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

module.exports = { isConfigured, createOrder, verifySignature, PLAN_PRICES_INR };
