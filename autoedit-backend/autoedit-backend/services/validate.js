// Preset values are used to build FFmpeg filter strings and file paths.
// If someone calls the API directly (not through your app) with crafted
// data, unvalidated strings could break the filter syntax or, in the worst
// case, be used to try to manipulate the FFmpeg command. This file forces
// every field into a known-safe shape before it ever reaches editor.js.

const ALLOWED_RATIOS = ['9:16', '1:1', '4:5', '16:9', 'Original'];
const ALLOWED_RESOLUTIONS = ['720p', '1080p', '4K'];
const ALLOWED_FPS = [24, 30, 60];
const ALLOWED_COLOR_STYLES = ['Vibrant', 'Cinematic', 'Warm', 'Cool', 'B&W', 'Vintage', 'Natural'];
const ALLOWED_MEME_STYLES = ['Trending', 'Funny', 'Reaction', 'Minimal', 'Custom'];
const ALLOWED_MEME_DENSITY = ['Light', 'Medium', 'Heavy'];
const ALLOWED_MEME_PLACEMENT = ['Random', 'Top corners', 'Bottom corners', 'Follow captions'];
const ALLOWED_BRAND_POSITIONS = ['Top-left', 'Top-right', 'Bottom-left', 'Bottom-right', 'Center'];
const ALLOWED_CAPTION_LANGS = ['Hindi', 'English', 'Hinglish', 'Punjabi'];
const ALLOWED_CAPTION_FONTS = ['Inter', 'Space Grotesk', 'Poppins', 'Anton', 'Montserrat'];
const ALLOWED_CAPTION_STYLES = ['Bold', 'Minimal', 'Karaoke', 'Highlight', 'Modern', 'Creator'];

function pick(value, allowedList, fallback) {
  return allowedList.includes(value) ? value : fallback;
}
function num(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
// Strips characters that have special meaning in FFmpeg filter syntax
// (quotes, colons, brackets, backslashes) from free-text fields, and caps
// their length so a single field can't bloat the filter graph.
function safeText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/['":\\\[\]]/g, '').slice(0, maxLen);
}
// Emoji/short-symbol fields — keep only emoji-range characters and spaces,
// dropping anything else (including any text that could be a filter injection).
function safeEmojis(value, maxLen) {
  if (typeof value !== 'string') return '';
  const matches = value.match(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\s]/gu) || [];
  return matches.join('').slice(0, maxLen);
}
// Media URLs (music/logo/intro/outro) get fetched directly by FFmpeg, so an
// unrestricted URL here would let anyone make this server request arbitrary
// addresses. Only allow URLs actually hosted on your own Cloudinary account.
function safeMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  return /^https:\/\/res\.cloudinary\.com\//.test(value) ? value : null;
}

function sanitizePreset(input) {
  const p = input && typeof input === 'object' ? input : {};
  const format = p.format || {};
  const cuts = p.cuts || {};
  const music = p.music || {};
  const captions = p.captions || {};
  const sound = p.sound || {};
  const branding = p.branding || {};
  const colorGrading = p.colorGrading || {};
  const memes = p.memes || {};
  const viralBoost = p.viralBoost || {};
  const textOverlay = p.textOverlay || {};
  const introOutro = p.introOutro || {};

  return {
    name: safeText(p.name, 60) || 'Untitled preset',
    format: {
      ratio: pick(format.ratio, ALLOWED_RATIOS, '9:16'),
      resolution: pick(format.resolution, ALLOWED_RESOLUTIONS, '1080p'),
      fps: ALLOWED_FPS.includes(Number(format.fps)) ? Number(format.fps) : 30,
    },
    cuts: {
      trimStart: num(cuts.trimStart, 0, 10, 0),
      trimEnd: num(cuts.trimEnd, 0, 10, 0),
      maxDuration: num(cuts.maxDuration, 5, 600, 60),
      silenceRemoval: !!cuts.silenceRemoval,
      removeLongPauses: !!cuts.removeLongPauses,
      fillerWordRemoval: !!cuts.fillerWordRemoval,
      minSilence: num(cuts.minSilence, 0.2, 5, 1.0),
    },
    music: {
      enabled: !!music.enabled,
      volume: num(music.volume, 0, 100, 50),
      originalVolume: num(music.originalVolume, 0, 100, 80),
      fileUrl: safeMediaUrl(music.fileUrl),
    },
    sound: {
      normalize: !!sound.normalize,
      voiceEnhance: !!sound.voiceEnhance,
      noiseReduction: !!sound.noiseReduction,
      aiVoiceover: {
        enabled: !!(sound.aiVoiceover && sound.aiVoiceover.enabled),
        voiceId: safeText(sound.aiVoiceover && sound.aiVoiceover.voiceId, 100),
      },
    },
    captions: {
      enabled: !!captions.enabled,
      language: pick(captions.language, ALLOWED_CAPTION_LANGS, 'English'),
      font: pick(captions.font, ALLOWED_CAPTION_FONTS, 'Inter'),
      style: pick(captions.style, ALLOWED_CAPTION_STYLES, 'Bold'),
    },
    branding: {
      enabled: !!branding.enabled,
      position: pick(branding.position, ALLOWED_BRAND_POSITIONS, 'Bottom-right'),
      opacity: num(branding.opacity, 0, 100, 85),
      logoUrl: safeMediaUrl(branding.logoUrl),
    },
    introOutro: {
      introEnabled: !!introOutro.introEnabled,
      outroEnabled: !!introOutro.outroEnabled,
      introUrl: safeMediaUrl(introOutro.introUrl),
      outroUrl: safeMediaUrl(introOutro.outroUrl),
    },
    textOverlay: {
      enabled: !!textOverlay.enabled,
      preset: safeText(textOverlay.preset, 40),
      custom: safeText(textOverlay.custom, 80),
    },
    colorGrading: {
      enabled: !!colorGrading.enabled,
      style: pick(colorGrading.style, ALLOWED_COLOR_STYLES, 'Vibrant'),
      intensity: num(colorGrading.intensity, 0, 100, 60),
    },
    memes: {
      enabled: !!memes.enabled,
      style: pick(memes.style, ALLOWED_MEME_STYLES, 'Trending'),
      density: pick(memes.density, ALLOWED_MEME_DENSITY, 'Light'),
      placement: pick(memes.placement, ALLOWED_MEME_PLACEMENT, 'Random'),
      customEmojis: safeEmojis(memes.customEmojis, 40),
    },
    viralBoost: {
      hookOptimizer: !!viralBoost.hookOptimizer,
      beatSync: !!viralBoost.beatSync,
      autoZoom: !!viralBoost.autoZoom,
      zoomIntensity: num(viralBoost.zoomIntensity, 0, 100, 50),
      trendingSound: !!viralBoost.trendingSound,
      thumbnailPicker: !!viralBoost.thumbnailPicker,
      captionGenerator: !!viralBoost.captionGenerator,
      aiImageGeneration: !!viralBoost.aiImageGeneration,
      speedRamping: !!viralBoost.speedRamping,
      speedRampFactor: num(viralBoost.speedRampFactor, 1.05, 2.0, 1.2),
      speedRampThreshold: num(viralBoost.speedRampThreshold, 2, 15, 4),
      multiPlatformExport: !!viralBoost.multiPlatformExport,
      multiPlatformRatios: Array.isArray(viralBoost.multiPlatformRatios)
        ? viralBoost.multiPlatformRatios.filter((r) => ALLOWED_RATIOS.includes(r)).slice(0, 3)
        : [],
      transitionSounds: !!viralBoost.transitionSounds,
    },
  };
}

module.exports = { sanitizePreset };
