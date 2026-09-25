const axios = require('axios');

const OPENAI_BASE = 'https://api.openai.com/v1';
function headers() {
  return { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' };
}
function isConfigured() {
  return !!process.env.OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// VIRAL CAPTION + HASHTAGS — reads the video's ACTUAL transcript (not just
// the preset's name) and asks an LLM for a caption + hashtags that fit what
// was actually said in the video. Falls back to null if not configured, so
// the frontend's simpler template-based suggestion still works either way.
// ---------------------------------------------------------------------------
async function generateViralCaption(transcriptText, preset) {
  if (!isConfigured()) return null;
  const platform = preset.format?.ratio === '9:16' ? 'Instagram Reels / YouTube Shorts'
    : preset.format?.ratio === '16:9' ? 'YouTube'
    : 'Instagram';
  const prompt = `You are a social media caption writer. Based on the transcript of a short video below, write:
1. A short, scroll-stopping caption (max 2 lines, can include emoji) for ${platform}.
2. 6-8 relevant hashtags (mix of niche and broad, no spaces inside a tag).

Transcript:
"""${(transcriptText || '').slice(0, 3000)}"""

Respond ONLY as JSON: {"caption": "...", "hashtags": ["#tag1", "#tag2", ...]}`;
  return generateCaptionJSON(prompt);
}

// Same caption+hashtag engine, but for a plain text description instead of a
// video transcript — used by the standalone Poster/Banner Generator.
async function generateCaptionFromDescription(description) {
  if (!isConfigured()) return null;
  const prompt = `You are a social media caption writer for a small business. Based on this description of a poster/banner, write:
1. A short, catchy caption (max 2 lines, can include emoji) to post alongside the image.
2. 6-8 relevant hashtags (mix of local/niche and broad, no spaces inside a tag).

Description: """${(description || '').slice(0, 1000)}"""

Respond ONLY as JSON: {"caption": "...", "hashtags": ["#tag1", "#tag2", ...]}`;
  return generateCaptionJSON(prompt);
}

async function generateCaptionJSON(prompt) {
  try {
    const res = await axios.post(`${OPENAI_BASE}/chat/completions`, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.8,
      response_format: { type: 'json_object' },
    }, { headers: headers(), timeout: 30000 });
    const raw = res.data.choices?.[0]?.message?.content;
    const parsed = JSON.parse(raw);
    if (!parsed.caption) return null;
    return { text: parsed.caption, hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.slice(0, 8) : [] };
  } catch (e) {
    console.warn('AI caption generation failed:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI-GENERATED THUMBNAIL IMAGE — generates a brand-new image (not extracted
// from the video) based on what the video is actually about, for use as a
// custom cover/thumbnail. Returns a base64 PNG the caller can upload to
// Cloudinary — this function itself doesn't touch storage.
// ---------------------------------------------------------------------------
async function generateThumbnailImage(transcriptText, preset) {
  if (!isConfigured()) return null;
  const summaryPrompt = `Summarize what this short video is about in under 15 words, for use as an image generation prompt:\n"""${(transcriptText || '').slice(0, 1500)}"""`;
  try {
    const summaryRes = await axios.post(`${OPENAI_BASE}/chat/completions`, {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: summaryPrompt }],
      temperature: 0.5,
    }, { headers: headers(), timeout: 20000 });
    const topic = summaryRes.data.choices?.[0]?.message?.content?.trim() || 'a social media video';

    const style = preset.colorGrading?.style || 'Vibrant';
    const imagePrompt = `A bold, eye-catching, ${style.toLowerCase()}-toned thumbnail image representing: ${topic}. Clean composition, high contrast, suitable as a social media video cover. No text.`;
    return await generateImageFromPrompt(imagePrompt, '1024x1536');
  } catch (e) {
    console.warn('AI image generation failed:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// GENERIC IMAGE GENERATION — the same engine as the video thumbnail feature,
// but usable standalone for shop banners, posters, and social media posts.
// Returns a raw image Buffer (PNG) — the caller uploads it to storage.
// ---------------------------------------------------------------------------
async function generateImageFromPrompt(prompt, size = '1024x1024') {
  if (!isConfigured()) return null;
  const res = await axios.post(`${OPENAI_BASE}/images/generations`, {
    model: 'gpt-image-1',
    prompt,
    size,
    n: 1,
  }, { headers: headers(), timeout: 60000 });
  const b64 = res.data.data?.[0]?.b64_json;
  return b64 ? Buffer.from(b64, 'base64') : null;
}

module.exports = { isConfigured, generateViralCaption, generateCaptionFromDescription, generateThumbnailImage, generateImageFromPrompt };
