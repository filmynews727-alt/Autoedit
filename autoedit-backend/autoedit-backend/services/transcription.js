const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'https://api.assemblyai.com/v2';
const headers = () => ({ authorization: process.env.ASSEMBLYAI_API_KEY });

// 1. Upload the local video/audio file to AssemblyAI's storage
async function uploadFile(filePath) {
  const stream = fs.createReadStream(filePath);
  const res = await axios.post(`${BASE_URL}/upload`, stream, {
    headers: { ...headers(), 'transfer-encoding': 'chunked' },
    maxBodyLength: Infinity,
  });
  return res.data.upload_url;
}

// 2. Ask AssemblyAI to transcribe it (gives word-level timestamps back)
async function requestTranscript(audioUrl) {
  const res = await axios.post(
    `${BASE_URL}/transcript`,
    { audio_url: audioUrl, punctuate: true, format_text: true },
    { headers: headers() }
  );
  return res.data.id;
}

// 3. Poll until AssemblyAI finishes processing
async function waitForTranscript(transcriptId, onProgress) {
  while (true) {
    const res = await axios.get(`${BASE_URL}/transcript/${transcriptId}`, { headers: headers() });
    const t = res.data;
    if (onProgress) onProgress(t.status);
    if (t.status === 'completed') return t;
    if (t.status === 'error') throw new Error('AssemblyAI transcription failed: ' + t.error);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Turns the word list into silence gaps — this is what powers "silence removal"
// and "remove long pauses" from your preset rules.
function findSilenceGaps(words, minSilenceSeconds = 1.0) {
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) {
    const endMs = words[i].end;
    const nextStartMs = words[i + 1].start;
    const gapSeconds = (nextStartMs - endMs) / 1000;
    if (gapSeconds >= minSilenceSeconds) {
      gaps.push({ start: endMs / 1000, end: nextStartMs / 1000, duration: gapSeconds });
    }
  }
  return gaps;
}

// FILLER WORD REMOVAL — a real editor's most common manual chore. Scans the
// transcript for common English/Hinglish filler words and returns their time
// ranges so they get cut out the same way silence does.
const DEFAULT_FILLER_WORDS = [
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm',
  'like', 'basically', 'actually', 'literally', 'so yeah', 'you know',
  'matlab', 'toh', 'yaani', 'like matlab', 'haan toh',
];
function findFillerWordRanges(words, customFillerList) {
  const fillers = new Set((customFillerList && customFillerList.length ? customFillerList : DEFAULT_FILLER_WORDS)
    .map((w) => w.toLowerCase().trim()));
  const ranges = [];
  for (const w of words) {
    const clean = (w.text || '').toLowerCase().replace(/[.,!?]/g, '').trim();
    if (fillers.has(clean)) {
      ranges.push({ start: w.start / 1000, end: w.end / 1000, duration: (w.end - w.start) / 1000 });
    }
  }
  return ranges;
}

// Builds an SRT captions file from the transcript's words — feeds directly into FFmpeg.
function wordsToSRT(words, wordsPerCaption = 4) {
  let srt = '';
  let index = 1;
  for (let i = 0; i < words.length; i += wordsPerCaption) {
    const chunk = words.slice(i, i + wordsPerCaption);
    const start = msToSRTTime(chunk[0].start);
    const end = msToSRTTime(chunk[chunk.length - 1].end);
    const text = chunk.map((w) => w.text).join(' ');
    srt += `${index}\n${start} --> ${end}\n${text}\n\n`;
    index++;
  }
  return srt;
}
function msToSRTTime(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const msPart = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${msPart}`;
}
function msToASSTime(ms) {
  const h = String(Math.floor(ms / 3600000)).padStart(1, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const centis = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `${h}:${m}:${s}.${centis}`;
}

// KARAOKE CAPTIONS — the word-by-word color-fill style used in most viral
// Reels/Shorts. Builds a real .ass subtitle file using libass's \kf (karaoke
// fill) tag, so each word highlights exactly as it's spoken.
function wordsToKaraokeASS(words, opts = {}) {
  const wordsPerLine = opts.wordsPerLine || 4;
  const fontName = opts.fontName || 'Arial';
  const fontSize = opts.fontSize || 20;
  const primaryColor = opts.primaryColorASS || '&H0000A5FF'; // highlighted word (BGR + alpha in ASS order)
  const secondaryColor = opts.secondaryColorASS || '&H00FFFFFF'; // not-yet-spoken words
  const resX = opts.resX || 1080;
  const resY = opts.resY || 1920;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${resX}
PlayResY: ${resY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${secondaryColor},${primaryColor},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  let body = '';
  for (let i = 0; i < words.length; i += wordsPerLine) {
    const chunk = words.slice(i, i + wordsPerLine);
    const lineStart = chunk[0].start;
    const lineEnd = chunk[chunk.length - 1].end;
    const text = chunk.map((w) => {
      const durationCentis = Math.max(1, Math.round((w.end - w.start) / 10));
      return `{\\kf${durationCentis}}${(w.text || '').replace(/[{}]/g, '')} `;
    }).join('');
    body += `Dialogue: 0,${msToASSTime(lineStart)},${msToASSTime(lineEnd)},Default,,0,0,0,,${text.trim()}\n`;
  }
  return header + body;
}

module.exports = {
  uploadFile,
  requestTranscript,
  waitForTranscript,
  findSilenceGaps,
  findFillerWordRanges,
  wordsToSRT,
  wordsToKaraokeASS,
};
