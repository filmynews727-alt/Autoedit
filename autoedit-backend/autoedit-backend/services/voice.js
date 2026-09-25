const axios = require('axios');

const ELEVEN_BASE = 'https://api.elevenlabs.io/v1';
function headers() {
  return { 'xi-api-key': process.env.ELEVENLABS_API_KEY };
}
function isConfigured() {
  return !!process.env.ELEVENLABS_API_KEY;
}

// Fetches the voices actually available on THIS account. We deliberately
// don't hardcode voice IDs — ElevenLabs is retiring its old "Default voices"
// (gone by end of 2026, and already unavailable to accounts made after
// March 2026), so any ID baked into this code could stop working. The
// frontend calls this to populate a live dropdown instead.
async function listVoices() {
  if (!isConfigured()) return [];
  try {
    const res = await axios.get(`${ELEVEN_BASE}/voices`, { headers: headers(), timeout: 15000 });
    return (res.data.voices || []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category }));
  } catch (e) {
    console.warn('ElevenLabs voice list failed:', e.response?.data?.detail || e.message);
    return [];
  }
}

// Generates speech audio for the given text using the chosen voice. Uses the
// multilingual model so Hindi/Hinglish scripts work, not just English.
async function generateSpeech(text, voiceId) {
  if (!isConfigured()) return null;
  if (!text || !voiceId) return null;
  try {
    const res = await axios.post(
      `${ELEVEN_BASE}/text-to-speech/${voiceId}`,
      { text: text.slice(0, 5000), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { ...headers(), 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 60000 }
    );
    return Buffer.from(res.data);
  } catch (e) {
    console.warn('ElevenLabs speech generation failed:', e.response?.data?.detail || e.message);
    return null;
  }
}

module.exports = { isConfigured, listVoices, generateSpeech };
