const axios = require('axios');

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

// Sends a "your video is ready" email. Silently does nothing if Resend isn't
// configured, or if the person has no email on file — never blocks the
// actual video processing over a notification failure.
async function sendVideoReadyEmail(toEmail, videoName, downloadUrl) {
  if (!isConfigured() || !toEmail) return;
  try {
    await axios.post('https://api.resend.com/emails', {
      from: process.env.NOTIFY_FROM_EMAIL || 'AutoEdit AI <onboarding@resend.dev>',
      to: [toEmail],
      subject: `Your video "${videoName}" is ready 🎬`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
          <h2>Your auto-edited video is ready!</h2>
          <p>"${videoName}" has finished processing — cuts, captions, branding and everything else from your preset are applied.</p>
          <p><a href="${downloadUrl}" style="display:inline-block;background:#F5A623;color:#1a1206;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Open your video</a></p>
        </div>`,
    }, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
  } catch (e) {
    console.warn('Email notification failed:', e.response?.data || e.message);
  }
}

module.exports = { isConfigured, sendVideoReadyEmail };
