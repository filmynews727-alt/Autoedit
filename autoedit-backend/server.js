require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');

const transcription = require('./services/transcription');
const editor = require('./services/editor');

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

// In-memory job store. For production, swap this for Redis/a database —
// but this alone is enough to get real processing working end-to-end.
const jobs = new Map(); // jobId -> { status, progress, stage, outputUrl, error }

function setJob(id, patch) {
  jobs.set(id, { ...(jobs.get(id) || {}), ...patch });
}

// ---------------------------------------------------------------------------
// POST /api/videos/upload  — multipart form: file, presetJson
// Kicks off the whole pipeline in the background and returns a jobId immediately.
// ---------------------------------------------------------------------------
app.post('/api/videos/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const preset = JSON.parse(req.body.presetJson || '{}');
  const jobId = uuid();
  setJob(jobId, { status: 'queued', progress: 0, stage: 'Uploading' });
  res.json({ jobId }); // respond immediately — frontend polls /status from here

  processJob(jobId, req.file.path, preset).catch((err) => {
    console.error('Job failed:', jobId, err);
    setJob(jobId, { status: 'failed', error: err.message });
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs/:jobId/status  — frontend polls this every second or two
// ---------------------------------------------------------------------------
app.get('/api/jobs/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ---------------------------------------------------------------------------
// The actual pipeline: AssemblyAI transcript -> silence detection -> FFmpeg render
// ---------------------------------------------------------------------------
async function processJob(jobId, inputPath, preset) {
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
  const minSilence = preset.cuts?.minSilence ?? 1.0;
  const silenceGaps = preset.cuts?.silenceRemoval ? transcription.findSilenceGaps(words, minSilence) : [];

  setJob(jobId, { stage: 'Applying cuts', progress: 45 });
  const keepSegments = editor.buildKeepSegments(
    totalDuration,
    silenceGaps,
    preset.cuts?.trimStart || 0,
    preset.cuts?.trimEnd || 0
  );

  // Captions file (only if enabled in the preset)
  let srtPath = null;
  if (preset.captions?.enabled && words.length) {
    setJob(jobId, { stage: 'Generating captions', progress: 55 });
    srtPath = path.join(__dirname, 'outputs', `${jobId}.srt`);
    fs.writeFileSync(srtPath, transcription.wordsToSRT(words));
  }

  // NOTE: musicPath / logoPath would come from files the user already saved to
  // their Brand Kit / preset — wire these up to wherever you store those uploads.
  const musicPath = null;
  const logoPath = null;

  setJob(jobId, { stage: 'Rendering video', progress: 65 });
  const outputPath = path.join(__dirname, 'outputs', `${jobId}.mp4`);
  await editor.renderVideo({
    inputPath,
    outputPath,
    preset,
    keepSegments,
    srtPath,
    musicPath,
    logoPath,
    onProgress: (p) => setJob(jobId, { progress: 65 + Math.round(p * 0.3) }),
  });

  setJob(jobId, {
    status: 'done',
    stage: 'Finalizing export',
    progress: 100,
    outputUrl: `/outputs/${jobId}.mp4`,
  });

  // Clean up the raw upload — keep only the rendered output.
  fs.unlink(inputPath, () => {});
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`AutoEdit AI backend running on port ${PORT}`));
