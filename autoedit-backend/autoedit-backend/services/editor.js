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
function ratioToDims(ratio) {
  switch (ratio) {
    case '16:9': return { w: 1920, h: 1080 };
    case '1:1': return { w: 1080, h: 1080 };
    case '4:5': return { w: 1080, h: 1350 };
    default: return { w: 1080, h: 1920 }; // 9:16 and 'Original' fallback
  }
}

// Escapes text for safe use inside an FFmpeg drawtext filter (colons,
// quotes and backslashes all have special meaning in filter syntax).
function escapeDrawtext(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '');
}

// Maps a Color Grading preset style to a real FFmpeg filter chain. `intensity`
// (0-100) blends the effect strength — 0 leaves the image untouched.
function colorGradingFilter(style, intensityPercent = 60) {
  const t = Math.max(0, Math.min(100, intensityPercent)) / 100;
  switch (style) {
    case 'Vibrant': return `eq=saturation=${1 + t * 0.6}:contrast=${1 + t * 0.15}`;
    case 'Cinematic': return `curves=preset=medium_contrast,eq=saturation=${1 - t * 0.15}:contrast=${1 + t * 0.2}`;
    case 'Warm': return `colorbalance=rs=${t * 0.15}:gs=${t * 0.05}:bs=${-t * 0.15}`;
    case 'Cool': return `colorbalance=rs=${-t * 0.15}:bs=${t * 0.15}`;
    case 'B&W': return `hue=s=${1 - t}`; // t=1 fully desaturated
    case 'Vintage': return `curves=preset=vintage,eq=saturation=${1 - t * 0.2}`;
    case 'Natural': return `eq=saturation=${1 + t * 0.08}:contrast=${1 + t * 0.04}`;
    default: return null;
  }
}

/**
 * Runs the full preset pipeline on one video.
 * @param {string} inputPath   - path to the uploaded source video
 * @param {string} outputPath  - where to write the final .mp4
 * @param {object} preset      - the preset object (same shape as your frontend wizard produces)
 * @param {array}  keepSegments - [{start,end}, ...] from buildKeepSegments()
 * @param {string} srtPath     - path to the captions .srt file (or null if captions disabled)
 * @param {string} zoomFilter  - optional crop-based zoom filter string from viralBoost.buildZoomFilter()
 * @param {string} memeFilter  - optional drawtext sticker chain from viralBoost.buildMemeOverlayFilter()
 * @param {function} onProgress - called with 0-100 as FFmpeg reports progress
 */
function renderVideo({ inputPath, outputPath, preset, keepSegments, srtPath, musicPath, logoPath, zoomFilter, memeFilter, voiceoverPath, whooshResult, onProgress }) {
  return new Promise((resolve, reject) => {
    const filters = [];
    let videoLabel = '0:v';
    let audioLabel = '0:a';

    // Estimated final duration after cuts + speed ramping — used to pad/trim
    // an AI voiceover track so it lines up with the edited video's length.
    let finalDuration = 0;
    if (keepSegments && keepSegments.length) {
      keepSegments.forEach((seg) => {
        const isLong = (seg.end - seg.start) > (preset.viralBoost?.speedRampThreshold || 4);
        const speed = (preset.viralBoost?.speedRamping && isLong) ? (preset.viralBoost.speedRampFactor || 1.2) : 1;
        finalDuration += (seg.end - seg.start) / speed;
      });
    }

    // 1. Cuts: keep only the segments that survived silence/filler-word removal
    // and trimming. Each segment is trimmed and re-timestamped individually,
    // then concatenated in the given ORDER — this is what actually makes Hook
    // Optimizer's reordering take effect (a plain select/between filter only
    // ever plays frames back in original chronological order, so it silently
    // ignored reordering before). Per-segment speed also enables Speed Ramping.
    if (keepSegments && keepSegments.length) {
      const vParts = [], aParts = [];
      keepSegments.forEach((seg, i) => {
        const isLong = (seg.end - seg.start) > (preset.viralBoost?.speedRampThreshold || 4);
        const speed = (preset.viralBoost?.speedRamping && isLong) ? (preset.viralBoost.speedRampFactor || 1.2) : 1;
        const vLabel = `vseg${i}`, aLabel = `aseg${i}`;
        filters.push(`[0:v]trim=start=${seg.start}:end=${seg.end},setpts=(PTS-STARTPTS)/${speed}[${vLabel}]`);
        // atempo only accepts 0.5–2.0 per instance — our ramp factors always stay inside that range.
        filters.push(`[0:a]atrim=start=${seg.start}:end=${seg.end},asetpts=PTS-STARTPTS,atempo=${speed}[${aLabel}]`);
        vParts.push(`[${vLabel}]`); aParts.push(`[${aLabel}]`);
      });
      const concatInputs = vParts.map((v, i) => v + aParts[i]).join('');
      filters.push(`${concatInputs}concat=n=${keepSegments.length}:v=1:a=1[vcut][acut]`);
      videoLabel = 'vcut';
      audioLabel = 'acut';
    }

    // 2. Ratio / crop
    const scaleFilter = ratioToScale(preset.format.ratio);
    if (scaleFilter) {
      filters.push(`[${videoLabel}]${scaleFilter}[vscaled]`);
      videoLabel = 'vscaled';
    }

    // 3. Auto Zoom / Punch-ins (Viral Boost) — applied on the already-cropped frame
    if (zoomFilter) {
      filters.push(`[${videoLabel}]${zoomFilter},scale=trunc(iw/2)*2:trunc(ih/2)*2[vzoom]`);
      videoLabel = 'vzoom';
    }

    // 4. Automatic Color Grading — before captions, so text stays crisp on top
    if (preset.colorGrading?.enabled) {
      const cg = colorGradingFilter(preset.colorGrading.style, preset.colorGrading.intensity);
      if (cg) {
        filters.push(`[${videoLabel}]${cg}[vgraded]`);
        videoLabel = 'vgraded';
      }
    }

    // 5. Captions (burned in from the AssemblyAI-generated file — .srt for
    // normal styles, .ass for Karaoke's word-by-word highlight)
    if (srtPath && preset.captions.enabled) {
      const escaped = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:');
      const isASS = srtPath.toLowerCase().endsWith('.ass');
      // .ass files already carry their own styling (font/size/colors) from
      // transcription.wordsToKaraokeASS — force_style would fight with that.
      const styleArg = isASS ? '' : `:force_style='FontName=${preset.captions.font},Fontsize=22,Bold=1'`;
      filters.push(`[${videoLabel}]subtitles='${escaped}'${styleArg}[vcap]`);
      videoLabel = 'vcap';
    }

    // 5b. Memes & Stickers — placed on top of everything so far (after color
    // grading and captions), so stickers read clearly over the finished frame.
    if (memeFilter) {
      filters.push(`[${videoLabel}]${memeFilter}[vmeme]`);
      videoLabel = 'vmeme';
    }

    // 6. Branding logo overlay
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

    // 6b. Text Overlay (CTA) — "Follow for more", "DM us now", etc.
    if (preset.textOverlay?.enabled) {
      const text = escapeDrawtext(preset.textOverlay.custom || preset.textOverlay.preset || 'Follow for more');
      const yMap = { Top: '60', Center: '(h-text_h)/2', Bottom: 'h-120' };
      const y = yMap[preset.textOverlay.position] || 'h-120';
      filters.push(`[${videoLabel}]drawtext=text='${text}':fontsize=42:fontcolor=white:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=${y}[vtext]`);
      videoLabel = 'vtext';
    }

    // 6c. AI Voiceover replacement, OR plain voice cleanup filters — these are
    // mutually exclusive: an AI voiceover already sounds clean, so we skip the
    // noise/EQ filters on it and just make sure its length matches the video.
    if (voiceoverPath && finalDuration) {
      inputs.push(voiceoverPath);
      const voiceInputIdx = inputs.length - 1;
      // Pad with silence if the voiceover is shorter than the edited video,
      // or trim it if it's longer — keeps the two roughly in sync even though
      // this isn't full word-level lip-sync (see README for that caveat).
      filters.push(`[${voiceInputIdx}:a]atrim=0:${finalDuration},apad=whole_dur=${finalDuration}[vovr]`);
      audioLabel = 'vovr';
    } else {
      const voiceFilters = [];
      if (preset.sound?.noiseReduction) voiceFilters.push('afftdn=nf=-25');
      if (preset.sound?.voiceEnhance) voiceFilters.push('highpass=f=100', 'equalizer=f=3000:width_type=o:width=2:g=3', 'acompressor=threshold=-18dB:ratio=3:attack=5:release=50');
      if (voiceFilters.length) {
        filters.push(`[${audioLabel}]${voiceFilters.join(',')}[vclean]`);
        audioLabel = 'vclean';
      }
    }

    // 7. Music mixing + ducking
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

    // 7b. Transition Sound Effects (Whoosh) — mixed in after music, before
    // final loudness normalization. The whoosh generator filters don't know
    // the current audio label ahead of time, so the amix line is built here.
    if (whooshResult && whooshResult.filters && whooshResult.filters.length) {
      filters.push(...whooshResult.filters);
      const mixInputs = `[${audioLabel}]${whooshResult.whooshLabels.join('')}`;
      filters.push(`${mixInputs}amix=inputs=${whooshResult.whooshLabels.length + 1}:duration=first:dropout_transition=0[awhoosh]`);
      audioLabel = 'awhoosh';
    }

    // 8. Loudness normalization — brings audio to a consistent, platform-
    // standard loudness (EBU R128 target used by YouTube/Spotify/etc.), the
    // same "make it sound professional" step a real audio editor runs last.
    if (preset.sound?.normalize) {
      filters.push(`[${audioLabel}]loudnorm=I=-16:LRA=11:TP=-1.5[anorm]`);
      audioLabel = 'anorm';
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

// Prepends/appends Intro/Outro clips to the finished, fully-edited video.
// This runs as a SECOND ffmpeg pass over the rendered output rather than
// inside the main filter graph — intro/outro clips can be any resolution or
// frame rate, so each one is scaled/padded/fps-matched here before concat.
function stitchIntroOutro({ corePath, introPath, outroPath, outputPath, ratio, fps, onProgress }) {
  return new Promise((resolve, reject) => {
    const { w, h } = ratioToDims(ratio);
    const inputs = [];
    const filters = [];
    const vLabels = [], aLabels = [];
    let idx = 0;
    const addClip = (clipPath) => {
      inputs.push(clipPath);
      filters.push(`[${idx}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${idx}]`);
      filters.push(`[${idx}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${idx}]`);
      vLabels.push(`[v${idx}]`); aLabels.push(`[a${idx}]`);
      idx++;
    };
    if (introPath) addClip(introPath);
    addClip(corePath);
    if (outroPath) addClip(outroPath);

    const concatInputs = vLabels.map((v, i) => v + aLabels[i]).join('');
    filters.push(`${concatInputs}concat=n=${vLabels.length}:v=1:a=1[vout][aout]`);

    const cmd = ffmpeg();
    inputs.forEach((i) => cmd.input(i));
    cmd
      .complexFilter(filters)
      .outputOptions(['-map [vout]', '-map [aout]', '-c:v libx264', '-c:a aac', '-preset fast'])
      .output(outputPath)
      .on('progress', (p) => onProgress && onProgress(Math.min(99, Math.round(p.percent || 0))))
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

module.exports = { buildKeepSegments, renderVideo, colorGradingFilter, stitchIntroOutro };
