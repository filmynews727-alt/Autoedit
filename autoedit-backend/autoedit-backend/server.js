require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const transcription = require('./services/transcription');
const editor = require('./services/editor');
const viralBoost = require('./services/viralBoost');
const storage = require('./services/storage');
const { sanitizePreset } = require('./services/validate');
const { requireFirebaseAuth } = require('./services/auth');
const usage = require('./services/usage');
const aiContent = require('./services/aiContent');
const notify = require('./services/notify');
const payments = require('./services/payments');
const voice = require('./services/voice');
const { getAdmin } = require('./services/auth');
const stats = require('./services/stats');

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

// -----------------------------------------------------------------------
// App-key check — a shared secret only your own frontend knows, sent as the
// x-app-key header. This is NOT unbreakable (anyone who reads your website's
// JavaScript can find the key — no client-side secret ever truly is), but it
// stops the two most common problems on a public URL: search-engine/bot
// scanners and copy-pasted curl commands finding your endpoint and abusing
// it without ever opening your site. Real user-level security still needs
// proper login on the backend (see README) — this is a baseline, not a wall.
// -----------------------------------------------------------------------
function requireAppKey(req, res, next) {
  if (!process.env.APP_SECRET_KEY) return next(); // not configured — skip (see README)
  if (req.headers['x-app-key'] !== process.env.APP_SECRET_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Rate limiting — caps how many uploads/status-checks a single IP can make,
// so one abusive script can't burn through your AssemblyAI credits or fill
// your server's disk.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many uploads from this connection — please wait a bit and try again.' },
});
const statusLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', statusLimiter);

// Multer: cap file size and only accept actual video files.
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('video/')) {
      return cb(new Error('Only video files are accepted'));
    }
    cb(null, true);
  },
});

// In-memory job store. For production, swap this for Redis/a database —
// but this alone is enough to get real processing working end-to-end.
const jobs = new Map(); // jobId -> { status, progress, stage, outputUrl, error }

function setJob(id, patch) {
  jobs.set(id, { ...(jobs.get(id) || {}), ...patch });
}

// -----------------------------------------------------------------------
// Job queue — a free server has limited CPU/RAM, and running two heavy
// FFmpeg renders at once can crash the process for everyone. This runs jobs
// one at a time in the order they arrive; everyone else just waits their
// turn (shown as "Queued — Nth in line").
// -----------------------------------------------------------------------
// -----------------------------------------------------------------------
// Rendering concurrency — the FFmpeg render step is the CPU-heavy part, so
// only a limited number of renders run at once (protects a free/small
// server from crashing under load). Transcription (AssemblyAI/OpenAI/
// ElevenLabs calls) is mostly waiting on external APIs, not local CPU, so
// it's allowed to run for many jobs at the same time — this means multiple
// people can upload and get to "Rendering…" together; only the actual
// render step queues up behind each other.
// Bump MAX_CONCURRENT_RENDERS in your environment variables once you've
// upgraded past Render's free tier to let more renders run in parallel.
const MAX_CONCURRENT_RENDERS = parseInt(process.env.MAX_CONCURRENT_RENDERS, 10) || 1;
let activeRenders = 0;
const renderWaiters = [];
function acquireRenderSlot(jobId) {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      if (activeRenders < MAX_CONCURRENT_RENDERS) {
        activeRenders++;
        resolve();
      } else {
        setJob(jobId, { stage: `Waiting to render — ${renderWaiters.length + 1} ahead of you` });
        renderWaiters.push(tryAcquire);
      }
    };
    tryAcquire();
  });
}
function releaseRenderSlot() {
  activeRenders--;
  const next = renderWaiters.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// POST /api/videos/upload  — multipart form: file, presetJson
// Kicks off the whole pipeline in the background and returns a jobId immediately.
// ---------------------------------------------------------------------------
app.post('/api/videos/upload', requireAppKey, requireFirebaseAuth, uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (or it was rejected — video files only, max 300MB)' });
  let preset;
  try {
    preset = sanitizePreset(JSON.parse(req.body.presetJson || '{}'));
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Invalid preset data' });
  }

  // Usage limit — only enforced when Firestore is configured AND the request
  // carries a verified user (see services/usage.js). Otherwise this is a no-op.
  const uid = req.user?.uid || null;
  const email = req.user?.email || null;
  const usageCheck = await usage.checkUsage(uid).catch(() => ({ allowed: true }));
  if (!usageCheck.allowed) {
    fs.unlink(req.file.path, () => {});
    return res.status(403).json({
      error: `You've used all ${usageCheck.limit} auto-edits on your ${usageCheck.plan} plan this month. Upgrade your plan to keep going.`,
    });
  }

  const jobId = uuid();
  setJob(jobId, { status: 'processing', progress: 0, stage: 'Starting' });
  res.json({ jobId }); // respond immediately — frontend polls /status from here
  processJob(jobId, req.file.path, preset, uid, email).catch((err) => {
    console.error('Job failed:', jobId, err);
    setJob(jobId, { status: 'failed', error: err.message });
  });
});

// Multer errors (oversized/wrong-type files) land here instead of crashing the process.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'Only video files are accepted') {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/status  — frontend polls this every second or two
// ---------------------------------------------------------------------------
app.get('/api/jobs/:jobId/status', requireAppKey, requireFirebaseAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// GET /api/voices/list — live list of ElevenLabs voices available on THIS
// account, for the frontend's AI Voiceover dropdown. Deliberately not
// hardcoded (see services/voice.js for why).
// ---------------------------------------------------------------------------
app.get('/api/voices/list', requireAppKey, requireFirebaseAuth, async (req, res) => {
  if (!voice.isConfigured()) return res.json({ voices: [] });
  const voices = await voice.listVoices();
  res.json({ voices });
});

// ---------------------------------------------------------------------------
// GET /api/admin/stats — one-place usage overview across all users/services,
// so you know when you're approaching a free-tier limit or should upgrade.
// Only accessible to the email in ADMIN_EMAIL — everyone else gets a 403,
// even if they're a normal signed-in user.
// ---------------------------------------------------------------------------
app.get('/api/admin/stats', requireAppKey, requireFirebaseAuth, async (req, res) => {
  if (!process.env.ADMIN_EMAIL || req.user?.email !== process.env.ADMIN_EMAIL) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const data = (await stats.getStats()) || {};
  res.json({
    videosProcessed: data.videosProcessed || 0,
    videosStarted: data.videosStarted || 0,
    videosFailed: Math.max(0, (data.videosStarted || 0) - (data.videosProcessed || 0)),
    assemblyaiSecondsProcessed: data.assemblyaiSecondsProcessed || 0,
    assemblyaiHoursProcessed: Math.round(((data.assemblyaiSecondsProcessed || 0) / 3600) * 100) / 100,
    assemblyaiFreeHoursLimit: 3, // AssemblyAI's free tier — update if this changes
    openaiCalls: data.openaiCalls || 0,
    openaiImages: data.openaiImages || 0,
    elevenlabsCharacters: data.elevenlabsCharacters || 0,
    postersGenerated: data.postersGenerated || 0,
    currentlyRendering: activeRenders,
    maxConcurrentRenders: MAX_CONCURRENT_RENDERS,
    jobsWaitingToRender: renderWaiters.length,
  });
});

// ---------------------------------------------------------------------------
// POST /api/posters/generate — standalone banner/poster generator (no video
// needed). Same AI engine as the video thumbnail feature, usable on its own
// for shop banners, sale posters, and social media posts.
// ---------------------------------------------------------------------------
const posterLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
app.post('/api/posters/generate', requireAppKey, requireFirebaseAuth, posterLimiter, async (req, res) => {
  if (!aiContent.isConfigured()) {
    return res.status(503).json({ error: 'AI image generation is not set up on this server yet — see README (OpenAI API key).' });
  }
  const description = String(req.body.description || '').slice(0, 500);
  const size = ['1024x1024', '1024x1536', '1536x1024'].includes(req.body.size) ? req.body.size : '1024x1024';
  if (!description.trim()) return res.status(400).json({ error: 'Please describe what the poster/banner should show.' });

  const uid = req.user?.uid || null;
  const usageCheck = await usage.checkUsage(uid).catch(() => ({ allowed: true }));
  if (!usageCheck.allowed) {
    return res.status(403).json({ error: `You've used up this month's quota on your ${usageCheck.plan} plan. Upgrade to keep going.` });
  }

  try {
    const stylePrompt = `A professional, eye-catching promotional poster/banner for a small business. ${description}. Bold composition, high contrast, suitable for print or social media.`;
    const imageBuffer = await aiContent.generateImageFromPrompt(stylePrompt, size);
    if (!imageBuffer) return res.status(502).json({ error: 'Image generation failed — please try again.' });

    let imageUrl = null;
    if (storage.isConfigured()) {
      imageUrl = await storage.uploadBuffer(imageBuffer, 'image', `poster-${uuid()}`);
    } else {
      // No Cloudinary configured — send the image straight back as base64 instead.
      imageUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;
    }

    const caption = await aiContent.generateCaptionFromDescription(description).catch(() => null);
    await usage.incrementUsage(uid).catch(() => {});
    stats.increment({ postersGenerated: 1, openaiCalls: caption ? 2 : 1, openaiImages: 1 }).catch(() => {});
    res.json({ imageUrl, caption });
  } catch (e) {
    console.error('Poster generation failed:', e.message);
    res.status(500).json({ error: 'Something went wrong generating your poster — please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Payments (Razorpay) — creates an order for a plan upgrade, and verifies the
// signature after checkout before actually upgrading the person's plan in
// Firestore. Both routes return a clear 503 if Razorpay isn't set up yet.
// ---------------------------------------------------------------------------
app.post('/api/payments/create-order', requireAppKey, requireFirebaseAuth, async (req, res) => {
  if (!payments.isConfigured()) {
    return res.status(503).json({ error: 'Payments are not set up on this server yet — see README (Razorpay keys).' });
  }
  try {
    const order = await payments.createOrder(req.body.plan);
    res.json({ orderId: order.id, amount: order.amount, currency: order.currency, keyId: process.env.RAZORPAY_KEY_ID });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/payments/verify', requireAppKey, requireFirebaseAuth, async (req, res) => {
  if (!payments.isConfigured()) {
    return res.status(503).json({ error: 'Payments are not set up on this server yet.' });
  }
  const { orderId, paymentId, signature, plan } = req.body;
  if (!orderId || !paymentId || !signature || !plan) {
    return res.status(400).json({ error: 'Missing payment details.' });
  }
  if (!payments.verifySignature({ orderId, paymentId, signature })) {
    return res.status(400).json({ error: 'Payment verification failed — please contact support before retrying.' });
  }
  const uid = req.user?.uid;
  const admin = getAdmin();
  if (admin && uid) {
    await admin.firestore().collection('users').doc(uid).set({ plan }, { merge: true });
  }
  res.json({ success: true, plan });
});

// ---------------------------------------------------------------------------
// The actual pipeline: AssemblyAI transcript -> silence detection -> FFmpeg render
// ---------------------------------------------------------------------------
async function processJob(jobId, inputPath, preset, uid, email) {
  setJob(jobId, { status: 'processing', stage: 'Uploading to transcription service', progress: 5 });
  const audioUrl = await transcription.uploadFile(inputPath);

  setJob(jobId, { stage: 'Detecting speech', progress: 15 });
  const transcriptId = await transcription.requestTranscript(audioUrl);

  setJob(jobId, { stage: 'Analyzing silence & pauses', progress: 25 });
  const transcript = await transcription.waitForTranscript(transcriptId, () => {
    setJob(jobId, { progress: 35 });
  });

  const words = transcript.words || [];
  const totalDuration = (transcript.audio_duration || 0);
  stats.increment({ assemblyaiSecondsProcessed: Math.round(totalDuration), videosStarted: 1 }).catch(() => {});
  const minSilence = preset.cuts?.minSilence ?? 1.0;
  const silenceGaps = preset.cuts?.silenceRemoval ? transcription.findSilenceGaps(words, minSilence) : [];

  // --- Filler Word Removal — cuts "um", "uh", "matlab", "like", etc. the
  // same real editors trim by hand. Uses the same {start,end} shape as
  // silence gaps, so it merges straight into the same cut-building step.
  let fillerRanges = [];
  if (preset.cuts?.fillerWordRemoval) {
    setJob(jobId, { stage: 'Removing filler words', progress: 40 });
    fillerRanges = transcription.findFillerWordRanges(words);
  }
  const removeRanges = [...silenceGaps, ...fillerRanges].sort((a, b) => a.start - b.start);

  setJob(jobId, { stage: 'Applying cuts', progress: 45 });
  let keepSegments = editor.buildKeepSegments(
    totalDuration,
    removeRanges,
    preset.cuts?.trimStart || 0,
    preset.cuts?.trimEnd || 0
  );

  // --- Viral Boost: Hook Optimizer — reorder so the loudest/most energetic
  // window leads the video instead of playing in its original position.
  let hookWindow = null;
  if (preset.viralBoost?.hookOptimizer) {
    setJob(jobId, { stage: 'Finding your video\'s hook', progress: 48 });
    hookWindow = await viralBoost.findLoudestWindow(inputPath, 3).catch(() => null);
    if (hookWindow) keepSegments = viralBoost.reorderForHook(keepSegments, hookWindow);
  }

  // --- Viral Boost: Beat Sync — snap cut boundaries to detected beat times
  // (approximate — see services/viralBoost.js for the real limitation).
  if (preset.viralBoost?.beatSync && preset.music?.enabled) {
    setJob(jobId, { stage: 'Syncing cuts to the beat', progress: 50 });
    const beatTimes = await viralBoost.estimateBeatTimes(inputPath).catch(() => []);
    if (beatTimes.length) keepSegments = viralBoost.snapSegmentsToBeats(keepSegments, beatTimes);
  }

  // Re-express the hook window in OUTPUT-timeline coordinates. hookWindow was
  // found by scanning the ORIGINAL input video, but Hook Optimizer moves that
  // segment to play FIRST in the final video — so anything timed against the
  // old input-time coordinates (zoom, whoosh) would land in the wrong spot
  // without this remapping. After reordering, the hook segment is always
  // keepSegments[0].
  let hookWindowOutput = null;
  if (hookWindow && keepSegments.length) {
    const hookSeg = keepSegments[0];
    const isLong = (hookSeg.end - hookSeg.start) > (preset.viralBoost?.speedRampThreshold || 4);
    const speed = (preset.viralBoost?.speedRamping && isLong) ? (preset.viralBoost.speedRampFactor || 1.2) : 1;
    hookWindowOutput = { start: 0, end: (hookSeg.end - hookSeg.start) / speed };
  }

  // Captions file (only if enabled in the preset) — Karaoke style gets a real
  // word-by-word highlighted .ass file; every other style gets a plain .srt.
  let srtPath = null;
  if (preset.captions?.enabled && words.length) {
    setJob(jobId, { stage: 'Generating captions', progress: 55 });
    if (preset.captions.style === 'Karaoke') {
      srtPath = path.join(__dirname, 'outputs', `${jobId}.ass`);
      const [resX, resY] = preset.format.ratio === '16:9' ? [1920, 1080]
        : preset.format.ratio === '1:1' ? [1080, 1080]
        : preset.format.ratio === '4:5' ? [1080, 1350]
        : [1080, 1920];
      fs.writeFileSync(srtPath, transcription.wordsToKaraokeASS(words, { resX, resY, fontName: preset.captions.font }));
    } else {
      srtPath = path.join(__dirname, 'outputs', `${jobId}.srt`);
      fs.writeFileSync(srtPath, transcription.wordsToSRT(words));
    }
  }

  // --- Viral Boost: Auto Zoom / Punch-ins — zoom in during the hook window
  // (and any other high-energy window we found) to hold attention. Uses the
  // OUTPUT-timeline window computed above, so it lands correctly even after
  // Hook Optimizer reordering.
  let zoomFilter = null;
  if (preset.viralBoost?.autoZoom) {
    const zoomWindows = hookWindowOutput ? [hookWindowOutput] : [];
    zoomFilter = viralBoost.buildZoomFilter(zoomWindows, preset.viralBoost.zoomIntensity || 50);
  }

  // --- Viral Boost: Transition Sound Effects (Whoosh) — synthesized on the
  // fly (no sound file, no copyright risk, no new account). Placed at the
  // same "important moment" used for zoom, so the punch-in and the whoosh
  // land together.
  let whooshResult = null;
  if (preset.viralBoost?.transitionSounds) {
    const whooshMoments = hookWindowOutput ? [hookWindowOutput.start] : [];
    whooshResult = viralBoost.buildWhooshFilter(whooshMoments);
  }

  // --- Memes & Stickers — placed at the midpoint of each detected silence
  // gap, since those are natural "beat" pauses in speech to react to.
  let memeFilter = null;
  if (preset.memes?.enabled) {
    setJob(jobId, { stage: 'Placing memes & stickers', progress: 58 });
    const pausePoints = silenceGaps.map((g) => (g.start + g.end) / 2);
    memeFilter = viralBoost.buildMemeOverlayFilter(pausePoints, preset.memes);
  }

  // Music/Logo — the person's Brand Kit / preset uploads (Cloudinary URLs
  // sent straight from the frontend). FFmpeg can read https:// URLs directly
  // as input, so no extra download step is needed here.
  const musicPath = preset.music?.enabled ? (preset.music.fileUrl || null) : null;
  const logoPath = preset.branding?.enabled ? (preset.branding.logoUrl || null) : null;

  // --- AI Voiceover — replaces the original (possibly weak/noisy) audio with
  // a clean, professionally-generated narration, built from the same words
  // that survived the cuts (so it roughly matches what's actually shown).
  let voiceoverPath = null;
  if (preset.sound?.aiVoiceover?.enabled && preset.sound.aiVoiceover.voiceId && voice.isConfigured()) {
    setJob(jobId, { stage: 'Generating AI voiceover', progress: 62 });
    const keptText = words
      .filter((w) => keepSegments.some((s) => w.start / 1000 >= s.start && w.end / 1000 <= s.end))
      .map((w) => w.text)
      .join(' ');
    const voiceBuffer = await voice.generateSpeech(keptText, preset.sound.aiVoiceover.voiceId).catch(() => null);
    if (voiceBuffer) {
      voiceoverPath = path.join(__dirname, 'outputs', `${jobId}-voiceover.mp3`);
      fs.writeFileSync(voiceoverPath, voiceBuffer);
      stats.increment({ elevenlabsCharacters: keptText.length }).catch(() => {});
    }
  }

  await acquireRenderSlot(jobId);
  var outputPath = path.join(__dirname, 'outputs', `${jobId}.mp4`);
  try {
    setJob(jobId, { stage: 'Rendering video', progress: 65 });
    await editor.renderVideo({
      inputPath,
      outputPath,
      preset,
      keepSegments,
      srtPath,
      musicPath,
      logoPath,
      zoomFilter,
      memeFilter,
      voiceoverPath,
      whooshResult,
      onProgress: (p) => setJob(jobId, { progress: 65 + Math.round(p * 0.2) }),
    });

    // --- Intro / Outro — stitched on as a second pass over the finished video,
    // since intro/outro clips can be any resolution/frame rate of their own.
    if (preset.introOutro?.introEnabled || preset.introOutro?.outroEnabled) {
      const introUrl = preset.introOutro.introEnabled ? (preset.introOutro.introUrl || null) : null;
      const outroUrl = preset.introOutro.outroEnabled ? (preset.introOutro.outroUrl || null) : null;
      if (introUrl || outroUrl) {
        setJob(jobId, { stage: 'Adding intro/outro', progress: 88 });
        const stitchedPath = path.join(__dirname, 'outputs', `${jobId}-final.mp4`);
        try {
          await editor.stitchIntroOutro({
            corePath: outputPath,
            introPath: introUrl,
            outroPath: outroUrl,
            outputPath: stitchedPath,
            ratio: preset.format.ratio,
            fps: preset.format.fps,
            onProgress: (p) => setJob(jobId, { progress: 88 + Math.round(p * 0.03) }),
          });
          fs.unlink(outputPath, () => {});
          outputPath = stitchedPath;
        } catch (e) {
          console.warn('Intro/outro stitching failed, using core render instead:', e.message);
        }
      }
    }

    // --- Multi-Platform Export — renders the SAME edit (same cuts, captions,
    // color grading, etc.) again at each additional ratio requested, so one
    // upload gives you Reels + Square post + YouTube versions together.
    // This re-runs the FFmpeg render per extra ratio (not the transcription —
    // that already happened once above), so it adds render time per ratio.
    var multiOutputs = [];
    const extraRatios = preset.viralBoost?.multiPlatformExport
      ? (preset.viralBoost.multiPlatformRatios || []).filter((r) => r !== preset.format.ratio)
      : [];
    if (extraRatios.length) {
      for (let i = 0; i < extraRatios.length; i++) {
        const ratio = extraRatios[i];
        setJob(jobId, { stage: `Rendering ${ratio} version (${i + 1}/${extraRatios.length})`, progress: 90 });
        try {
          const variantPreset = { ...preset, format: { ...preset.format, ratio } };
          const variantPath = path.join(__dirname, 'outputs', `${jobId}-${ratio.replace(':', 'x')}.mp4`);
          await editor.renderVideo({
            inputPath, outputPath: variantPath, preset: variantPreset, keepSegments, srtPath, musicPath, logoPath, zoomFilter, memeFilter, voiceoverPath, whooshResult,
            onProgress: () => {},
          });
          let variantUrl = `/outputs/${jobId}-${ratio.replace(':', 'x')}.mp4`;
          if (storage.isConfigured()) {
            variantUrl = await storage.uploadFile(variantPath, 'video', `${jobId}-${ratio.replace(':', 'x')}`);
            fs.unlink(variantPath, () => {});
          }
          multiOutputs.push({ ratio, url: variantUrl });
        } catch (e) {
          console.warn(`Multi-platform render failed for ${ratio}:`, e.message);
        }
      }
    }

    // --- Viral Boost: Auto Thumbnail Picker — genuinely automatic, using
    // FFmpeg's own frame-scoring "thumbnail" filter.
    var thumbnailUrl = null;
    if (preset.viralBoost?.thumbnailPicker) {
      setJob(jobId, { stage: 'Picking your best thumbnail', progress: 92 });
      const thumbPath = path.join(__dirname, 'outputs', `${jobId}-thumb.jpg`);
      try{
        await viralBoost.pickThumbnail(outputPath, thumbPath);
        thumbnailUrl = `/outputs/${jobId}-thumb.jpg`;
      } catch(e){ console.warn('Thumbnail extraction failed:', e.message); }
    }
  } finally {
    releaseRenderSlot();
  }

  // --- Viral Boost: Trending Sound Match — suggestion only (see viralBoost.js).
  let trendingSound = null;
  if (preset.viralBoost?.trendingSound) {
    trendingSound = viralBoost.suggestTrendingSound(totalDuration);
  }

  // --- AI Viral Caption + Hashtags — reads the ACTUAL transcript (more
  // accurate than the frontend's name-based template) when OpenAI is set up.
  let aiCaption = null;
  if (preset.viralBoost?.captionGenerator && aiContent.isConfigured()) {
    setJob(jobId, { stage: 'Writing your caption & hashtags', progress: 93 });
    const transcriptText = words.map((w) => w.text).join(' ');
    aiCaption = await aiContent.generateViralCaption(transcriptText, preset).catch(() => null);
    if (aiCaption) stats.increment({ openaiCalls: 1 }).catch(() => {});
  }

  // --- AI-Generated Thumbnail Image — a brand-new image (not a video frame),
  // based on what the video is actually about.
  let aiImageUrl = null;
  if (preset.viralBoost?.aiImageGeneration && aiContent.isConfigured()) {
    setJob(jobId, { stage: 'Generating a custom thumbnail image', progress: 94 });
    const transcriptText = words.map((w) => w.text).join(' ');
    const imageBuffer = await aiContent.generateThumbnailImage(transcriptText, preset).catch(() => null);
    if (imageBuffer && storage.isConfigured()) {
      try { aiImageUrl = await storage.uploadBuffer(imageBuffer, 'image', `${jobId}-ai-image`); stats.increment({ openaiCalls: 1, openaiImages: 1 }).catch(() => {}); }
      catch (e) { console.warn('AI image upload failed:', e.message); }
    }
  }

  // --- Permanent storage (Cloudinary) — without this, the video/thumbnail
  // only exist on this server's local disk and are LOST on the next restart.
  // If Cloudinary isn't configured, we fall back to serving from local disk
  // so the app still works end-to-end, just without persistence.
  let outputUrl = `/outputs/${jobId}.mp4`;
  let finalThumbnailUrl = thumbnailUrl;
  if (storage.isConfigured()) {
    setJob(jobId, { stage: 'Saving to permanent storage', progress: 96 });
    try {
      outputUrl = await storage.uploadFile(outputPath, 'video', jobId);
      if (thumbnailUrl) {
        const thumbPath = path.join(__dirname, 'outputs', `${jobId}-thumb.jpg`);
        finalThumbnailUrl = await storage.uploadFile(thumbPath, 'image', `${jobId}-thumb`);
      }
      // Local copies are no longer needed once they're safely in the cloud.
      fs.unlink(outputPath, () => {});
      if (thumbnailUrl) fs.unlink(path.join(__dirname, 'outputs', `${jobId}-thumb.jpg`), () => {});
    } catch (e) {
      console.warn('Cloudinary upload failed, falling back to local file:', e.message);
    }
  }

  setJob(jobId, {
    status: 'done',
    stage: 'Finalizing export',
    progress: 100,
    outputUrl,
    thumbnailUrl: finalThumbnailUrl,
    trendingSound,
    aiCaption,
    aiImageUrl,
    multiOutputs,
  });

  // Count this against the user's monthly plan quota (no-op if Firestore isn't configured).
  await usage.incrementUsage(uid).catch((e) => console.warn('Usage increment failed:', e.message));
  stats.increment({ videosProcessed: 1 }).catch(() => {});

  // Let the person know their video is ready — no-op if Resend isn't configured.
  notify.sendVideoReadyEmail(email, path.basename(inputPath), outputUrl).catch(() => {});

  // Clean up the raw upload and temporary voiceover file — keep only the rendered output.
  fs.unlink(inputPath, () => {});
  if (voiceoverPath) fs.unlink(voiceoverPath, () => {});
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AutoEdit AI backend running on port ${PORT}`));
