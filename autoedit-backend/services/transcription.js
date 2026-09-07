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

module.exports = { uploadFile, requestTranscript, waitForTranscript, findSilenceGaps, wordsToSRT };
