const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); return; }
      resolve({ stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// 1. AUTO THUMBNAIL PICKER — genuinely automatic.
// FFmpeg's own "thumbnail" filter scores frames (based on a histogram-difference
// heuristic) across a batch and picks the most representative one — this is a
// real, well-established technique, not a mock.
// ---------------------------------------------------------------------------
async function pickThumbnail(inputPath, outputPath) {
  await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-vf', 'thumbnail,scale=720:-1',
    '-frames:v', '1',
    outputPath,
  ]);
  return outputPath;
}

// ---------------------------------------------------------------------------
// 2. HOOK OPTIMIZER — finds the loudest ~3s window (a reasonable proxy for
// "most energetic moment") using FFmpeg's astats filter, so the timeline can
// be reordered to lead with it.
// ---------------------------------------------------------------------------
async function findLoudestWindow(inputPath, windowSeconds = 3) {
  const { stderr } = await run('ffmpeg', [
    '-i', inputPath,
    '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f', 'null', '-',
  ]).catch((e) => ({ stderr: e.stderr || '' })); // astats can exit non-zero on some builds; we only need stderr/stdout text

  // Parse "frame:N pts_time:T ... lavfi.astats.Overall.RMS_level=-XX.XX" lines.
  const points = [];
  const re = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    points.push({ t: parseFloat(m[1]), rms: parseFloat(m[2]) });
  }
  if (points.length < 2) return { start: 0, end: windowSeconds }; // fallback: no usable data

  const totalDuration = points[points.length - 1].t;
  let best = { start: 0, score: -Infinity };
  for (let t = 0; t < totalDuration - windowSeconds; t += 0.5) {
    const windowPoints = points.filter((p) => p.t >= t && p.t < t + windowSeconds);
    if (!windowPoints.length) continue;
    const avg = windowPoints.reduce((s, p) => s + p.rms, 0) / windowPoints.length;
    if (avg > best.score) best = { start: t, score: avg };
  }
  return { start: Math.max(0, best.start), end: Math.min(totalDuration, best.start + windowSeconds) };
}

// Reorders keepSegments so the hook window plays first, then the rest in original order.
function reorderForHook(keepSegments, hookWindow) {
  const hookSeg = { start: hookWindow.start, end: hookWindow.end };
  const rest = [];
  for (const seg of keepSegments) {
    // Split segments that overlap the hook window so we don't play it twice.
    if (seg.end <= hookWindow.start || seg.start >= hookWindow.end) {
      rest.push(seg);
    } else {
      if (seg.start < hookWindow.start) rest.push({ start: seg.start, end: hookWindow.start });
      if (seg.end > hookWindow.end) rest.push({ start: hookWindow.end, end: seg.end });
    }
  }
  return [hookSeg, ...rest].filter((s) => s.end - s.start > 0.05);
}

// ---------------------------------------------------------------------------
// 3. BEAT SYNC (approximation) — a lightweight energy-based onset detector.
// This is NOT a full music-information-retrieval beat tracker (that needs a
// dedicated library like aubio/essentia) — it estimates likely beat times by
// picking peaks in short-term audio energy, which works reasonably well for
// music with a clear, steady rhythm but can drift on complex tracks.
// ---------------------------------------------------------------------------
async function estimateBeatTimes(inputPath) {
  const { stderr } = await run('ffmpeg', [
    '-i', inputPath,
    '-af', "astats=metadata=1:reset=1:length=0.1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    '-f', 'null', '-',
  ]).catch((e) => ({ stderr: e.stderr || '' }));

  const points = [];
  const re = /pts_time:([\d.]+)[\s\S]*?RMS_level=(-?[\d.]+)/g;
  let m;
  while ((m = re.exec(stderr))) points.push({ t: parseFloat(m[1]), rms: parseFloat(m[2]) });
  if (points.length < 4) return [];

  // Peak-pick: a point is a "beat" if it's a local energy maximum and at least
  // ~250ms since the last detected beat (avoids double-counting one hit).
  const beats = [];
  let lastBeat = -1;
  for (let i = 1; i < points.length - 1; i++) {
    const { t, rms } = points[i];
    if (rms > points[i - 1].rms && rms >= points[i + 1].rms && t - lastBeat > 0.25) {
      beats.push(t);
      lastBeat = t;
    }
  }
  return beats;
}

// Snaps each cut boundary to the nearest detected beat within a small tolerance,
// so the edit visually "lands" on the music instead of an arbitrary point.
function snapSegmentsToBeats(keepSegments, beatTimes, toleranceSeconds = 0.15) {
  if (!beatTimes.length) return keepSegments;
  const snap = (t) => {
    let closest = t, minDiff = toleranceSeconds;
    for (const b of beatTimes) {
      const diff = Math.abs(b - t);
      if (diff < minDiff) { minDiff = diff; closest = b; }
    }
    return closest;
  };
  return keepSegments.map((s) => ({ start: snap(s.start), end: snap(s.end) }))
    .filter((s) => s.end - s.start > 0.05);
}

// ---------------------------------------------------------------------------
// 4. AUTO ZOOM / PUNCH-INS — builds an FFmpeg crop expression that gently
// zooms in during the hook window and stays subtle elsewhere.
// ---------------------------------------------------------------------------
function buildZoomFilter(zoomWindows, intensityPercent = 50, videoWidth = 1080, videoHeight = 1920) {
  if (!zoomWindows.length) return null;
  const maxZoom = 1 + (intensityPercent / 100) * 0.18; // up to ~18% zoom at 100%
  const conditions = zoomWindows
    .map((w) => `if(between(t,${w.start},${w.end}),${maxZoom},1)`)
    .reduceRight((acc, cur) => (acc ? cur.replace('1)', `${acc})`) : cur), null);
  const zoomExpr = conditions || '1';
  const cropW = `iw/(${zoomExpr})`;
  const cropH = `ih/(${zoomExpr})`;
  return `crop=w='${cropW}':h='${cropH}':x='(iw-${cropW})/2':y='(ih-${cropH})/2'`;
}

// ---------------------------------------------------------------------------
// 5. TRENDING SOUND MATCH — honest limitation: there is no public API for
// "what's trending on Instagram/TikTok right now", and embedding real trending
// tracks would need per-track licensing. This returns curated, royalty-free-
// style suggestions matched by duration/mood as a starting point — the person
// still needs to supply/license the actual audio file to use it.
// ---------------------------------------------------------------------------
const TRENDING_SOUND_LIBRARY = [
  { name: 'Upbeat Pop Bounce', moods: ['funny', 'trending'], bpm: 128, minDuration: 5, maxDuration: 30 },
  { name: 'Cinematic Build', moods: ['dramatic', 'reveal'], bpm: 90, minDuration: 10, maxDuration: 60 },
  { name: 'Lo-fi Chill Loop', moods: ['calm', 'vlog'], bpm: 80, minDuration: 5, maxDuration: 90 },
  { name: 'Hype Trap Beat', moods: ['hype', 'sports'], bpm: 140, minDuration: 5, maxDuration: 45 },
  { name: 'Acoustic Feel-Good', moods: ['wholesome', 'story'], bpm: 100, minDuration: 5, maxDuration: 60 },
];
function suggestTrendingSound(durationSeconds) {
  const candidates = TRENDING_SOUND_LIBRARY.filter(
    (t) => durationSeconds >= t.minDuration && durationSeconds <= t.maxDuration
  );
  const pick = (candidates.length ? candidates : TRENDING_SOUND_LIBRARY)[0];
  return { ...pick, note: 'Suggestion only — license/download this style of track yourself and add it as your music source.' };
}

// ---------------------------------------------------------------------------
// 6. MEMES & STICKERS (optional) — drops emoji reaction stickers at natural
// pause points in the video using FFmpeg's drawtext filter.
// Honest limitation: FFmpeg's drawtext renders emoji using whatever font
// fontconfig resolves on the server — on Linux this is usually monochrome
// (not full-color) unless a color-emoji font is installed on the machine.
// It's a real, working overlay, just not guaranteed to look identical to a
// phone's native colorful emoji everywhere.
// ---------------------------------------------------------------------------
const MEME_STYLE_EMOJIS = {
  Trending: ['🔥', '✨', '💯', '😱'],
  Funny: ['😂', '🤣', '😅', '💀'],
  Reaction: ['😳', '👀', '😮', '🙌'],
  Minimal: ['✔️', '•'],
};
function buildMemeOverlayFilter(pausePoints, memeConfig) {
  if (!pausePoints || !pausePoints.length) return null;
  const densityMap = { Light: 2, Medium: 4, Heavy: 7 };
  const count = Math.min(densityMap[memeConfig.density] || 2, pausePoints.length);
  const emojis = memeConfig.style === 'Custom'
    ? (memeConfig.customEmojis || '🔥').trim().split(/\s+/).filter(Boolean)
    : (MEME_STYLE_EMOJIS[memeConfig.style] || MEME_STYLE_EMOJIS.Trending);
  if (!emojis.length) return null;

  const positionFor = (placement) => {
    switch (placement) {
      case 'Top corners': return { x: 'w*0.08', y: 'h*0.08' };
      case 'Bottom corners': return { x: 'w*0.08', y: 'h*0.82' };
      case 'Follow captions': return { x: '(w-tw)/2', y: 'h*0.72' };
      default: return null; // 'Random' — computed per-sticker below
    }
  };

  const chosen = pausePoints.slice(0, count);
  const filters = chosen.map((t, i) => {
    const emoji = emojis[i % emojis.length];
    const pos = positionFor(memeConfig.placement) ||
      { x: `w*${(0.15 + ((i * 0.37) % 0.6)).toFixed(2)}`, y: `h*${(0.15 + ((i * 0.53) % 0.55)).toFixed(2)}` };
    const start = Math.max(0, t - 0.1).toFixed(2);
    const end = (t + 1.1).toFixed(2);
    return `drawtext=text='${emoji}':fontsize=90:x=${pos.x}:y=${pos.y}:enable='between(t\\,${start}\\,${end})'`;
  });
  return filters.join(',');
}

// ---------------------------------------------------------------------------
// 7. TRANSITION SOUND EFFECTS (Whoosh) — the punchy transition sound heard on
// most viral Reels/Shorts at cut/zoom moments. Generated on the fly with
// FFmpeg's own noise + filter tools (no sound file needed at all, so there's
// zero copyright risk and no new account required).
// Reuses the SAME "important moments" already found for Auto Zoom / Hook
// Optimizer, rather than firing on every tiny cut — that would sound
// cluttered and turns a subtle effect into noise.
// ---------------------------------------------------------------------------
function buildWhooshFilter(momentsSeconds) {
  const points = (momentsSeconds || []).filter((t) => t >= 0).slice(0, 8); // cap so the filter graph stays small
  if (!points.length) return null;

  const filters = [];
  const whooshLabels = [];
  points.forEach((t, i) => {
    const label = `whoosh${i}`;
    const delayMs = Math.round(t * 1000);
    // Pink-noise burst, band-passed to sound like air/wind, with a fast
    // attack and a slightly longer decay — the classic "whoosh" shape.
    filters.push(
      `anoisesrc=d=0.35:c=pink:r=44100,` +
      `bandpass=f=1800:width_type=h:width=1600,` +
      `afade=t=in:d=0.03,afade=t=out:st=0.22:d=0.13,` +
      `volume=0.55,` +
      `adelay=${delayMs}|${delayMs}[${label}]`
    );
    whooshLabels.push(`[${label}]`);
  });

  // Note: no final mix line here — the caller (editor.js) knows the current
  // audio label at the point it's mixing this in, and builds the amix line
  // itself using these generator filters + labels.
  return { filters, whooshLabels };
}

module.exports = {
  pickThumbnail,
  findLoudestWindow,
  reorderForHook,
  estimateBeatTimes,
  snapSegmentsToBeats,
  buildZoomFilter,
  suggestTrendingSound,
  buildMemeOverlayFilter,
  buildWhooshFilter,
};
