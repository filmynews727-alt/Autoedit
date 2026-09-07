const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

// Turns "silence gaps to remove" into the list of segments we KEEP,
// then uses FFmpeg's select filter to concatenate only those segments.
// This directly maps to your preset's cuts.silenceRemoval / trimStart / trimEnd rules.
function buildKeepSegments(totalDuration, silenceGaps, trimStart, trimEnd) {
  const segments = [];
  let cursor = trimStart || 0;
  const usableEnd = totalDuration - (trimEnd || 0);

  for (const gap of silenceGaps) {
    if (gap.start > cursor && gap.start < usableEnd) {
      segments.push({ start: cursor, end: Math.min(gap.start, usableEnd) });
      cursor = Math.max(cursor, gap.end);
    }
  }
  if (cursor < usableEnd) segments.push({ start: cursor, end: usableEnd });
  return segments.filter((s) => s.end - s.start > 0.05); // drop zero-length slivers
}

function ratioToScale(ratio) {
  switch (ratio) {
    case '9:16': return 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
    case '1:1': return 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080';
    case '4:5': return 'scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350';
    case '16:9': return 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080';
    default: return null; // 'Original' — no forced crop
  }
}

/**
 * Runs the full preset pipeline on one video.
 * @param {string} inputPath   - path to the uploaded source video
 * @param {string} outputPath  - where to write the final .mp4
 * @param {object} preset      - the preset object (same shape as your frontend wizard produces)
 * @param {array}  keepSegments - [{start,end}, ...] from buildKeepSegments()
 * @param {string} srtPath     - path to the captions .srt file (or null if captions disabled)
 * @param {function} onProgress - called with 0-100 as FFmpeg reports progress
 */
function renderVideo({ inputPath, outputPath, preset, keepSegments, srtPath, musicPath, logoPath, onProgress }) {
  return new Promise((resolve, reject) => {
    const filters = [];
    let videoLabel = '0:v';
    let audioLabel = '0:a';

    // 1. Cuts: keep only the segments that survived silence-removal / trimming
    if (keepSegments && keepSegments.length) {
      const selectExpr = keepSegments.map((s) => `between(t,${s.start},${s.end})`).join('+');
      filters.push(`[0:v]select='${selectExpr}',setpts=N/FRAME_RATE/TB[vcut]`);
      filters.push(`[0:a]aselect='${selectExpr}',asetpts=N/SR/TB[acut]`);
      videoLabel = 'vcut';
      audioLabel = 'acut';
    }

    // 2. Ratio / crop
    const scaleFilter = ratioToScale(preset.format.ratio);
    if (scaleFilter) {
      filters.push(`[${videoLabel}]${scaleFilter}[vscaled]`);
      videoLabel = 'vscaled';
    }

    // 3. Captions (burned in from the AssemblyAI-generated SRT)
    if (srtPath && preset.captions.enabled) {
      const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      filters.push(`[${videoLabel}]subtitles='${escaped}':force_style='FontName=${preset.captions.font},Fontsize=22,Bold=1'[vcap]`);
      videoLabel = 'vcap';
    }

    // 4. Branding logo overlay
    let inputs = [inputPath];
    if (logoPath && preset.branding.enabled) {
      inputs.push(logoPath);
      const posMap = {
        'Top-left': '20:20', 'Top-right': 'W-w-20:20',
        'Bottom-left': '20:H-h-20', 'Bottom-right': 'W-w-20:H-h-20',
        'Center': '(W-w)/2:(H-h)/2',
      };
      const pos = posMap[preset.branding.position] || 'W-w-20:H-h-20';
      filters.push(`[${videoLabel}][1:v]overlay=${pos}:format=auto[vbrand]`);
      videoLabel = 'vbrand';
    }

    // 5. Music mixing + ducking
    if (musicPath && preset.music.enabled) {
      inputs.push(musicPath);
      const musicInputIdx = inputs.length - 1;
      const voiceVol = (preset.music.originalVolume || 80) / 100;
      const musicVol = (preset.music.volume || 50) / 100;
      filters.push(`[${audioLabel}]volume=${voiceVol}[voice]`);
      filters.push(`[${musicInputIdx}:a]volume=${musicVol}[music]`);
      filters.push(`[voice][music]amix=inputs=2:duration=first[amixed]`);
      audioLabel = 'amixed';
    }

    const cmd = ffmpeg();
    inputs.forEach((i) => cmd.input(i));
    cmd
      .complexFilter(filters)
      .outputOptions([`-map [${videoLabel}]`, `-map [${audioLabel}]`, '-c:v libx264', '-c:a aac', '-preset fast'])
      .fps(Number(preset.format.fps) || 30)
      .output(outputPath)
      .on('progress', (p) => onProgress && onProgress(Math.min(99, Math.round(p.percent || 0))))
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

module.exports = { buildKeepSegments, renderVideo };
