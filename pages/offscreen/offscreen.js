// Offscreen document runner for FFmpeg demux (embedded subtitles)
// Runs in a DOM context so FFmpeg can spawn Workers (not allowed in MV3 service worker)

function sendOffscreenLog(text, level = 'info', messageId) {
  if (!shouldEmitOffscreenLog(level)) return;
  try {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_LOG',
      text,
      level,
      ts: Date.now(),
      messageId
    });
  } catch (_) { /* ignore */ }
}

console.log('[Offscreen] Initialized');

// Minimal stubs to satisfy ffmpeg.js expectations if needed
if (typeof self.document === 'undefined') {
  self.document = { baseURI: self.location?.href || '', currentScript: null };
}
if (typeof self.window === 'undefined') {
  self.window = self;
}

self.addEventListener('error', (evt) => {
  sendOffscreenLog(`Unhandled error: ${evt?.message || evt?.error?.message || evt}`, 'error');
});
self.addEventListener('unhandledrejection', (evt) => {
  sendOffscreenLog(`Unhandled rejection: ${evt?.reason?.message || evt?.reason || evt}`, 'error');
});

// Shared state
let _ffmpegInstance = null;
let _ffmpegFactory = null;
let _ffmpegMode = 'unknown';
let _bareFfmpegModule = null;
let _workerLooksStub = null;
let _debugEnabled = true; // default to verbose so extraction failures surface without manual toggles
const _chunkedBuffers = new Map();
const CHUNK_BUFFER_TTL_MS = 5 * 60 * 1000;
const OUTGOING_CHUNK_BYTES = 512 * 1024;
const OUTGOING_CHUNK_THRESHOLD = 2.5 * 1024 * 1024; // approx 2.5MB before chunking

const DEBUG_FLAG_KEY = 'debugLogsEnabled';
function refreshDebugFlag() {
  try {
    chrome.storage?.local.get([DEBUG_FLAG_KEY], (res) => {
      const stored = res?.[DEBUG_FLAG_KEY];
      if (typeof stored === 'boolean') {
        _debugEnabled = stored;
      }
    });
  } catch (_) { /* ignore */ }
}
refreshDebugFlag();
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && Object.prototype.hasOwnProperty.call(changes, DEBUG_FLAG_KEY)) {
    const next = changes[DEBUG_FLAG_KEY]?.newValue;
    _debugEnabled = typeof next === 'boolean' ? next : true;
  }
});

function shouldEmitOffscreenLog(level = 'info') {
  return _debugEnabled || level === 'error' || level === 'warn';
}

function stashChunk(transferId, chunkIndex, totalChunks, chunk, expectedBytes, chunkArray) {
  if (!transferId || totalChunks <= 0 || chunkIndex < 0 || chunkIndex >= totalChunks || (!chunk && !chunkArray)) {
    return { ok: false, error: 'Invalid chunk metadata' };
  }
  let part = chunk instanceof Uint8Array ? chunk : (chunk ? new Uint8Array(chunk) : null);
  if ((!part || !part.byteLength) && Array.isArray(chunkArray)) {
    part = new Uint8Array(chunkArray);
  }
  const partBytes = part?.byteLength || 0;
  if (!partBytes) {
    return { ok: false, error: `Empty chunk received (index ${chunkIndex + 1}/${totalChunks})` };
  }
  if (expectedBytes && partBytes !== expectedBytes) {
    return { ok: false, error: `Chunk size mismatch at ${chunkIndex + 1}/${totalChunks}: expected ${expectedBytes}, got ${partBytes}` };
  }
  let entry = _chunkedBuffers.get(transferId);
  if (!entry || entry.totalChunks !== totalChunks) {
    entry = { totalChunks, parts: new Array(totalChunks), received: 0, timer: null };
    _chunkedBuffers.set(transferId, entry);
  }
  if (!entry.parts[chunkIndex]) {
    entry.received += 1;
  }
  entry.parts[chunkIndex] = part;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => _chunkedBuffers.delete(transferId), CHUNK_BUFFER_TTL_MS);
  const complete = entry.received === entry.totalChunks && entry.parts.every(Boolean);
  return { ok: true, complete, received: entry.received, total: entry.totalChunks };
}

function consumeChunkedBuffer(transferId) {
  const entry = _chunkedBuffers.get(transferId);
  if (!entry || !entry.parts || entry.parts.length !== entry.totalChunks || entry.parts.some(p => !p)) {
    return null;
  }
  const totalBytes = entry.parts.reduce((n, p) => n + (p?.byteLength || 0), 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const p of entry.parts) {
    merged.set(p, offset);
    offset += p.byteLength;
  }
  if (entry.timer) clearTimeout(entry.timer);
  _chunkedBuffers.delete(transferId);
  return merged;
}

async function sendResultChunksToBackground(transferId, buffer, messageId, label = 'result') {
  if (!(buffer instanceof Uint8Array)) {
    throw new Error('sendResultChunksToBackground expects Uint8Array');
  }
  const totalBytes = buffer.byteLength;
  const totalChunks = Math.max(1, Math.ceil(totalBytes / OUTGOING_CHUNK_BYTES));
  for (let i = 0; i < totalChunks; i++) {
    const start = i * OUTGOING_CHUNK_BYTES;
    const end = Math.min(totalBytes, start + OUTGOING_CHUNK_BYTES);
    const view = buffer.subarray(start, end);
    const chunkArray = Array.from(view);
    const shouldLog = totalChunks <= 20 || i === 0 || i === totalChunks - 1 || ((i + 1) % 25 === 0);
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_RESULT_CHUNK',
        transferId,
        chunkIndex: i,
        totalChunks,
        chunkArray,
        expectedBytes: view.byteLength,
        messageId,
        label
      }, (resp) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (resp?.ok === false) {
          return reject(new Error(resp?.error || `Chunk ${i + 1}/${totalChunks} rejected`));
        }
        if (shouldLog) {
          console.log('[Offscreen] Result chunk sent', { transferId, idx: i + 1, totalChunks, label });
        }
        resolve();
      });
    });
  }
  return { transferId, totalChunks, totalBytes };
}

async function prepareTracksForSend(tracks, messageId) {
  if (!Array.isArray(tracks)) return { tracks: [] };
  const encoder = new TextEncoder();
  const prepared = [];
  let chunked = false;

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i] || {};
    const base = { ...t };
    const trackLabel = `track_${i + 1}`;

    const stringContent = typeof t.content === 'string' ? t.content : null;
    const base64Content = !stringContent && typeof t.contentBase64 === 'string' ? t.contentBase64 : null;

    const toBytes = () => {
      if (stringContent !== null) {
        return encoder.encode(stringContent);
      }
      if (base64Content !== null) {
        try {
          const bin = atob(base64Content);
          const out = new Uint8Array(bin.length);
          for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
          return out;
        } catch (err) {
          console.warn('[Offscreen] Failed to decode base64 track', err);
        }
      }
      return null;
    };

    const bytes = toBytes();
    const byteLength = bytes?.byteLength || 0;
    if (bytes && byteLength > OUTGOING_CHUNK_THRESHOLD) {
      const transferId = `${trackLabel}_${messageId || Date.now()}_${Math.random().toString(16).slice(2)}`;
      await sendResultChunksToBackground(transferId, bytes, messageId, trackLabel);
      delete base.content;
      delete base.contentBase64;
      prepared.push({
        ...base,
        transferId,
        byteLength,
        chunked: true
      });
      chunked = true;
    } else {
      prepared.push(base);
    }
  }

  return { tracks: prepared, chunked };
}

function analyzeCueTimelines(tracks) {
  let flatCueStarts = false;
  let nonMonotonicCues = false;
  const timeRegex = /(\d{1,2}):(\d{2}):(\d{2}),(\d{3})\s+-->\s+(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g;

  for (const t of tracks || []) {
    if (typeof t?.content !== 'string') continue;
    const starts = [];
    let m;
    while ((m = timeRegex.exec(t.content)) !== null) {
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      const s = parseInt(m[3], 10);
      const ms = parseInt(m[4], 10);
      const startSec = h * 3600 + mi * 60 + s + ms / 1000;
      starts.push(startSec);
      if (starts.length > 1 && startSec + 1e-3 < starts[starts.length - 2]) {
        nonMonotonicCues = true;
      }
    }
    if (starts.length >= 6) {
      const uniqueStarts = new Set(starts.map(v => v.toFixed(3)));
      const uniqueRatio = uniqueStarts.size / starts.length;
      if (uniqueRatio <= 0.2) {
        flatCueStarts = true;
      }
    }
    if (flatCueStarts && nonMonotonicCues) break;
  }

  return { flatCueStarts, nonMonotonicCues };
}

function uint8ToBase64(u8) {
  let str = '';
  for (let i = 0; i < u8.length; i++) {
    str += String.fromCharCode(u8[i]);
  }
  return btoa(str);
}

// Naming helpers to keep extracted tracks consistent across modes
const EXTRACTED_PREFIX = 'extracted_sub';
const EXTRACTED_SRT_PATTERN = /^extracted_sub_\d+\.srt$/i;
const EXTRACTED_COPY_PATTERN = /^extracted_sub_\d+\.mkv$/i;
const EXTRACTED_FIX_PATTERN = /^extracted_sub_fix_\d+\.srt$/i;

const formatExtractedName = (index, ext = 'srt', variant = '') => {
  const num = String(index).padStart(2, '0');
  const prefix = variant ? `${EXTRACTED_PREFIX}_${variant}_` : `${EXTRACTED_PREFIX}_`;
  return `${prefix}${num}.${ext}`;
};

function normalizeExtractedTracks(tracks) {
  if (!Array.isArray(tracks)) return [];
  return tracks.map((t, idx) => {
    const ext = (t && (t.binary || t.codec === 'copy' || (t.mime && String(t.mime).toLowerCase().includes('matroska'))))
      ? 'mkv'
      : 'srt';
    const label = formatExtractedName(idx + 1, ext);
    return {
      ...t,
      id: String(idx + 1),
      label,
      originalLabel: t?.label
    };
  });
}

function loadScriptTag(url, label, messageId) {
  return new Promise((resolve, reject) => {
    try {
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => {
        console.log(`[Offscreen] Loaded ${label}`);
        sendOffscreenLog(`Loaded ${label}`, 'info', messageId);
        resolve();
      };
      script.onerror = (e) => {
        console.warn(`[Offscreen] Failed to load ${label}:`, e);
        sendOffscreenLog(`Failed to load ${label}: ${e?.message || e}`, 'warn', messageId);
        reject(new Error(`Failed to load ${label}`));
      };
      document.head.appendChild(script);
    } catch (err) {
      reject(err);
    }
  });
}

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

async function workerScriptLooksStub(url) {
  if (_workerLooksStub !== null) return _workerLooksStub;
  if (!url) return false;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return false;
    const text = await res.text();
    _workerLooksStub = text.length < 1024 && /placeholder/i.test(text);
    if (_workerLooksStub) {
      sendOffscreenLog('Detected placeholder FFmpeg worker; will prefer bare core fallback', 'warn');
    }
    return _workerLooksStub;
  } catch (_) {
    _workerLooksStub = false;
    return false;
  }
}

async function ensureFfmpegFactory() {
  if (_ffmpegFactory) return _ffmpegFactory;

  const wireUpWasmShim = () => {
    if (!self.createFFmpeg && self.FFmpegWASM?.FFmpeg) {
      self.FFmpeg = self.FFmpegWASM;
      self.createFFmpeg = (opts = {}) => new self.FFmpegWASM.FFmpeg(opts);
    }
    return self.createFFmpeg || (self.FFmpeg && self.FFmpeg.createFFmpeg);
  };

  let factory = wireUpWasmShim();
  const tryLoad = async (url, label) => {
    if (!url) return;
    try {
      sendOffscreenLog(`Loading FFmpeg loader: ${label}`, 'info');
      await loadScriptTag(url, label);
      factory = wireUpWasmShim();
      if (factory) {
        console.log(`[Offscreen] FFmpeg loader ready via ${label}`);
        sendOffscreenLog(`FFmpeg loader ready via ${label}`, 'info');
      }
    } catch (err) {
      console.warn(`[Offscreen] Failed to load FFmpeg loader from ${label}:`, err?.message || err);
      sendOffscreenLog(`FFmpeg loader failed via ${label}: ${err?.message || err}`, 'warn');
    }
  };

  const runtimeUrl = chrome.runtime.getURL('assets/lib/ffmpeg.js');
  await tryLoad(runtimeUrl, 'bundled ffmpeg.js');
  if (!factory) {
    await tryLoad('assets/lib/ffmpeg.js', 'fallback ffmpeg.js');
  }
  if (!factory) {
    throw new Error('FFmpeg loader unavailable in offscreen context.');
  }
  _ffmpegFactory = factory;
  return factory;
}

async function loadBareFfmpegCore(messageId) {
  if (_bareFfmpegModule && _ffmpegInstance) return _ffmpegInstance;
  const coreUrl = chrome.runtime.getURL('assets/lib/ffmpeg-core.js');
  sendOffscreenLog('Falling back to direct FFmpeg core (no worker)...', 'warn', messageId);
  await loadScriptTag(coreUrl, 'ffmpeg-core.js', messageId);
  if (typeof self.createFFmpegCore !== 'function') {
    throw new Error('createFFmpegCore not found after loading core script');
  }
  const module = await withTimeout(self.createFFmpegCore({
    locateFile: (path) => {
      if (path.endsWith('.wasm')) return chrome.runtime.getURL('assets/lib/ffmpeg-core.wasm');
      if (path.endsWith('.worker.js')) return chrome.runtime.getURL('assets/lib/ffmpeg-core.worker.js');
      return chrome.runtime.getURL(`assets/lib/${path}`);
    },
    print: (msg) => sendOffscreenLog(msg, 'info', messageId),
    printErr: (msg) => sendOffscreenLog(msg, 'warn', messageId)
  }), 45000, 'Bare FFmpeg core load timed out');

  const ffmpeg = {
    FS: (cmd, ...args) => {
      const target = module.FS || module;
      const fn = target?.[cmd];
      if (typeof fn === 'function') return fn.apply(target, args);
      if (typeof target.FS === 'function') return target.FS(cmd, ...args);
      throw new Error(`FFmpeg FS command unavailable: ${cmd}`);
    },
    run: async (...args) => {
      const argv = Array.isArray(args[0]) ? args[0] : args;
      const ret = typeof module.exec === 'function'
        ? module.exec(...argv)
        : module.callMain
          ? module.callMain(argv)
          : 0;
      if (typeof ret === 'number' && ret !== 0) {
        throw new Error(`FFmpeg exited with code ${ret}`);
      }
    }
  };

  _bareFfmpegModule = module;
  _ffmpegInstance = ffmpeg;
  _ffmpegMode = 'single-thread-direct';
  sendOffscreenLog('Bare FFmpeg core ready (single-thread, no worker)', 'info', messageId);
  return ffmpeg;
}

async function getFFmpeg(messageId) {
  if (_ffmpegInstance) {
    sendOffscreenLog(`FFmpeg already loaded (${_ffmpegMode})`, 'info', messageId);
    return _ffmpegInstance;
  }

  const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
  const coi = self.crossOriginIsolated;
  sendOffscreenLog(`FFmpeg loading... (SAB:${sabAvailable ? 'yes' : 'no'}, COI:${coi === false ? 'no' : 'yes'})`, 'info', messageId);
  const createFFmpeg = await ensureFfmpegFactory();

  // Force bare core to skip worker-based variants that hang in COI/SAB edge cases (faster and more reliable here).
  const forceBareCore = true;
  const buildPaths = (mt) => ({
    corePath: chrome.runtime.getURL(mt ? 'assets/lib/ffmpeg-core-mt.js' : 'assets/lib/ffmpeg-core.js'),
    wasmPath: chrome.runtime.getURL(mt ? 'assets/lib/ffmpeg-core-mt.wasm' : 'assets/lib/ffmpeg-core.wasm'),
    workerPath: mt ? chrome.runtime.getURL('assets/lib/ffmpeg-core-mt.worker.js') : null,
    mainName: mt ? 'ffmpeg-core-mt' : 'ffmpeg-core'
  });

  const preferBare = forceBareCore || await workerScriptLooksStub(buildPaths(false).workerPath);

  if (preferBare) {
    try {
      const bareReason = forceBareCore
        ? 'Forcing bare FFmpeg core (single-thread, no worker)'
        : 'Using bare FFmpeg core because worker script is a placeholder';
      sendOffscreenLog(bareReason, 'warn', messageId);
      _ffmpegInstance = await loadBareFfmpegCore(messageId);
      return _ffmpegInstance;
    } catch (err) {
      sendOffscreenLog(`Bare core quick path failed; retrying standard loader (${err?.message || err})`, 'warn', messageId);
    }
  }

  const loadWithMode = async (mt) => {
    const paths = buildPaths(mt);
    sendOffscreenLog(`Loading FFmpeg core (${mt ? 'multi-thread' : 'single-thread'})...`, 'info', messageId);

    const toBlobUrl = async (url, type) => {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Fetch failed for ${url} (${res.status})`);
      const buf = await res.arrayBuffer();
      return URL.createObjectURL(new Blob([buf], { type }));
    };

    let corePath = paths.corePath;
    let wasmPath = paths.wasmPath;
    let workerPath = paths.workerPath;

    // For mt, load via Blob URLs so the worker inherits the offscreen document's COI/SAB context.
    if (mt) {
      corePath = await toBlobUrl(paths.corePath, 'application/javascript');
      wasmPath = await toBlobUrl(paths.wasmPath, 'application/wasm');
      workerPath = paths.workerPath ? await toBlobUrl(paths.workerPath, 'application/javascript') : null;
    }

    const ffmpeg = createFFmpeg({
      log: true,
      logger: ({ type, message }) => {
        const level = type === 'fferr' ? 'warn' : 'info';
        sendOffscreenLog(message, level, messageId);
      },
      corePath,
      wasmPath,
      ...(workerPath ? { workerPath } : {}),
      mainName: paths.mainName
    });
    const loadTimeout = mt ? 120000 : 45000;
    await withTimeout(ffmpeg.load(), loadTimeout, `FFmpeg ${mt ? 'multi-thread' : 'single-thread'} load timed out`);
    _ffmpegMode = mt ? 'multi-thread' : 'single-thread';
    sendOffscreenLog(`FFmpeg load finished (${_ffmpegMode})`, 'info', messageId);
    return ffmpeg;
  };

  const preferMt = sabAvailable;
  let lastErr = null;
  const modes = preferMt ? [true, false] : [false];
  if (preferMt && coi === false) {
    sendOffscreenLog('Cross-origin isolation disabled; will attempt multi-thread FFmpeg and fall back if blocked', 'warn', messageId);
  }
  for (const mt of modes) {
    try {
      _ffmpegInstance = await loadWithMode(mt);
      return _ffmpegInstance;
    } catch (err) {
      lastErr = err;
      const level = mt && modes.length > 1 ? 'warn' : 'error';
      sendOffscreenLog(`FFmpeg ${mt ? 'multi-thread' : 'single-thread'} load failed: ${err?.message || err}`, level, messageId);
      console.warn('[Offscreen] FFmpeg load failed:', err);
    }
  }

  try {
    sendOffscreenLog('Attempting bare FFmpeg core fallback after worker load failure...', 'warn', messageId);
    return await loadBareFfmpegCore(messageId);
  } catch (fallbackErr) {
    console.warn('[Offscreen] Bare FFmpeg fallback failed:', fallbackErr);
    sendOffscreenLog(`Bare FFmpeg core fallback failed: ${fallbackErr?.message || fallbackErr}`, 'error', messageId);
    throw lastErr || fallbackErr || new Error('FFmpeg load failed in offscreen page.');
  }
}

async function decodeAudioWindows(windows, mode, messageId) {
  const ffmpeg = await getFFmpeg(messageId);
  const results = [];
  const sharedBuffer = windows.length > 1 && windows.every(w => w.buffer === windows[0].buffer);
  let sharedInputName = null;

  if (sharedBuffer) {
    sharedInputName = 'shared_input.bin';
    ffmpeg.FS('writeFile', sharedInputName, windows[0].buffer instanceof Uint8Array ? windows[0].buffer : new Uint8Array(windows[0].buffer));
  }

  for (let i = 0; i < windows.length; i++) {
    const win = windows[i];
    const inputName = sharedInputName || `win_${i}.bin`;
    const outputName = `win_${i}.wav`;
    const buffer = win.buffer instanceof Uint8Array ? win.buffer : new Uint8Array(win.buffer);
    ffmpeg.FS('writeFile', inputName, buffer);
    const args = ['-i', inputName, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1'];
    if (typeof win.seekToSec === 'number' && win.seekToSec > 0) {
      args.unshift('-ss', String(win.seekToSec));
    }
    if (typeof win.durSec === 'number' && win.durSec > 0) {
      args.push('-t', String(win.durSec));
    }
    args.push(outputName);

    try {
      await ffmpeg.run(...args);
      const data = ffmpeg.FS('readFile', outputName);
      if (!data?.byteLength) {
        throw new Error(`FFmpeg produced empty audio for window ${i + 1}`);
      }
      if (data.byteLength < 44) {
        throw new Error(`FFmpeg produced too-small audio for window ${i + 1} (${data.byteLength} bytes)`);
      }
      results.push({
        audioBytes: data,
        startMs: Math.round(((win.startSec ?? win.seekToSec ?? 0) || 0) * 1000)
      });
    } finally {
      try { ffmpeg.FS('unlink', outputName); } catch (_) { /* ignore */ }
      if (!sharedInputName) {
        try { ffmpeg.FS('unlink', inputName); } catch (_) { /* ignore */ }
      }
    }
  }

  if (sharedInputName) {
    try { ffmpeg.FS('unlink', sharedInputName); } catch (_) { /* ignore */ }
  }

  if (!results.length) {
    throw new Error('FFmpeg could not decode any audio window');
  }

  return results;
}

async function demuxSubtitles(buffer, messageId) {
  const byteLength = typeof buffer?.byteLength === 'number'
    ? buffer.byteLength
    : (typeof buffer?.size === 'number' ? buffer.size : 0);
  const sizeMb = Math.round(((byteLength || 0) / (1024 * 1024)) * 10) / 10;
  sendOffscreenLog(`Starting demux (buffer ~${sizeMb} MB)`, 'info', messageId);
  if (!buffer || !byteLength) {
    sendOffscreenLog('Received empty buffer for demux; aborting.', 'error', messageId);
    throw new Error('Empty buffer received for demux.');
  }
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const ffmpeg = await getFFmpeg(messageId);
  if (ffmpeg?.setLogger) {
    ffmpeg.setLogger(({ type, message }) => {
      const level = type === 'fferr' ? 'warn' : 'info';
      sendOffscreenLog(message, level, messageId);
    });
  }
  if (ffmpeg?.setLogLevel) {
    ffmpeg.setLogLevel('debug');
  }
  const inputName = 'embedded_input.bin';
  sendOffscreenLog('Writing input buffer to FFmpeg FS...', 'info', messageId);
  ffmpeg.FS('writeFile', inputName, view);
  try {
    sendOffscreenLog('Running FFmpeg to extract subtitle streams...', 'info', messageId);
    const srtSeqPattern = `${EXTRACTED_PREFIX}_%02d.srt`;
    // Try generous probe and srt conversion first
    const baseArgs = [
      '-y',
      '-analyzeduration', '60M',
      '-probesize', '60M',
      '-i', inputName,
      '-map', '0:s?',
      '-c:s', 'srt',
      '-start_number', '1',
      srtSeqPattern
    ];
    try {
      await ffmpeg.run(...baseArgs);
    } catch (primaryErr) {
      sendOffscreenLog(`Primary demux attempt failed (${primaryErr?.message || primaryErr}); retrying with stream copy`, 'warn', messageId);
      // Fallback: stream copy to keep bitmap/ass subs intact
      await ffmpeg.run(
        '-y',
        '-analyzeduration', '60M',
        '-probesize', '60M',
        '-i', inputName,
        '-map', '0:s?',
        '-c:s', 'copy',
        '-f', 'matroska',
        'embedded_subs.mkv'
      );
    }
  } catch (err) {
    console.error('[Offscreen] FFmpeg demux failed:', err);
    sendOffscreenLog(`FFmpeg demux failed: ${err?.message || err}`, 'error', messageId);
    throw new Error('FFmpeg could not extract subtitle tracks (no subtitle streams or FFmpeg unavailable).');
  }

  // Gather initial SRT outputs
  let files = ffmpeg.FS('readdir', '/')
    .filter(f => EXTRACTED_SRT_PATTERN.test(f))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const mkvExists = ffmpeg.FS('readdir', '/').includes('embedded_subs.mkv');
  const copiedTracks = [];
  const convertedSrts = [];

  // Always attempt to split every subtitle stream into its own MKV copy to preserve bitmap/ass tracks.
  if (mkvExists) {
    sendOffscreenLog('Inspecting MKV copy to preserve all subtitle streams...', 'info', messageId);
    try {
      const maxTracks = 32;
      for (let i = 0; i < maxTracks; i++) {
        const trackNumber = i + 1;
        const outName = formatExtractedName(trackNumber, 'mkv');
        try {
          await ffmpeg.run(
            '-y',
            '-analyzeduration', '60M',
            '-probesize', '60M',
            '-i', 'embedded_subs.mkv',
            '-map', `0:s:${i}`,
            '-c:s', 'copy',
            outName
          );
          const data = ffmpeg.FS('readFile', outName);
          if (data?.byteLength > 0) {
            copiedTracks.push(outName);
          } else {
            try { ffmpeg.FS('unlink', outName); } catch (_) { }
            break; // no more subtitle streams
          }
        } catch (innerErr) {
          try { ffmpeg.FS('unlink', outName); } catch (_) { }
          break; // stop at first missing stream
        }
      }
      sendOffscreenLog(`Remuxed ${copiedTracks.length} subtitle stream(s) to MKV copy (kept internal)`, 'info', messageId);
    } catch (probeErr) {
      sendOffscreenLog(`Failed to remux MKV copy: ${probeErr?.message || probeErr}`, 'error', messageId);
    }
  }

  // Try to convert each copied track to SRT if we don't already have an SRT for that index
  if (copiedTracks.length) {
    const existingIds = new Set(files.map(f => parseInt((f.match(/extracted_sub_(\d+)\.srt$/i) || [])[1] || '-1', 10)));
    for (const copyName of copiedTracks) {
      const idxMatch = copyName.match(/extracted_sub_(\d+)\.mkv$/i);
      const trackIdx = idxMatch ? parseInt(idxMatch[1], 10) : null;
      if (trackIdx !== null && existingIds.has(trackIdx)) {
        continue; // already have text output for this track
      }
      const srtName = copyName.replace(/\.mkv$/i, '.srt');
      try {
        await ffmpeg.run(
          '-y',
          '-analyzeduration', '60M',
          '-probesize', '60M',
          '-i', copyName,
          '-map', '0:s:0',
          '-c:s', 'srt',
          srtName
        );
        const data = ffmpeg.FS('readFile', srtName);
        if (data?.byteLength) {
          convertedSrts.push(srtName);
        } else {
          try { ffmpeg.FS('unlink', srtName); } catch (_) { }
        }
      } catch (convErr) {
        try { ffmpeg.FS('unlink', srtName); } catch (_) { }
        sendOffscreenLog(`Failed to convert ${copyName} to SRT: ${convErr?.message || convErr}`, 'warn', messageId);
      }
    }
    if (convertedSrts.length) {
      files = [...files, ...convertedSrts].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }
  }
  const skippedCopies = copiedTracks.length;

  if (!files.length) {
    sendOffscreenLog('FFmpeg completed but no subtitle streams were found.', 'warn', messageId);
    throw new Error('No subtitle streams found in media.');
  }
  sendOffscreenLog(`FFmpeg demux produced ${files.length} track file(s)`, 'info', messageId);

  const decoder = new TextDecoder();
  let tracks = files.map((file) => {
    const data = ffmpeg.FS('readFile', file);
    const matchSrt = file.match(/extracted_sub_(\d+)\.srt$/i);
    const matchFix = file.match(/extracted_sub_fix_(\d+)\.srt$/i);
    const matchCopy = file.match(/extracted_sub_(\d+)\.mkv$/i);
    const trackId = matchSrt
      ? String(parseInt(matchSrt[1], 10))
      : matchFix
        ? String(parseInt(matchFix[1], 10))
        : matchCopy
          ? String(parseInt(matchCopy[1], 10))
          : file.replace(/\..*$/, '');
    const isBinary = /\.mkv$/i.test(file);
    const source = matchCopy ? 'copy' : 'srt';
    const base = {
      id: trackId,
      label: file,
      language: 'und',
      codec: isBinary ? 'copy' : 'srt',
      source
    };

    if (isBinary) {
      return {
        ...base,
        binary: true,
        mime: 'video/x-matroska',
        byteLength: data.byteLength,
        contentBase64: uint8ToBase64(data)
      };
    }

    return {
      ...base,
      binary: false,
      byteLength: data.byteLength,
      content: decoder.decode(data)
    };
  });

  // If timelines look broken (e.g., all cues share the same timestamp), retry with a PTS-normalized conversion.
  const timelineStatus = analyzeCueTimelines(tracks);
  if (timelineStatus.flatCueStarts || timelineStatus.nonMonotonicCues) {
    sendOffscreenLog(
      `Detected ${timelineStatus.flatCueStarts ? 'flat' : 'non-monotonic'} cue timestamps; retrying with PTS normalization...`,
      'warn',
      messageId
    );
    try {
      // Remove prior SRT outputs to avoid mixing old/new
      for (const f of ffmpeg.FS('readdir', '/')) {
        if (/^extracted_sub_(fix_)?\d+\.srt$/i.test(f)) {
          try { ffmpeg.FS('unlink', f); } catch (_) { }
        }
      }
      const fixPattern = `${EXTRACTED_PREFIX}_fix_%02d.srt`;
      await ffmpeg.run(
        '-y',
        '-fflags', '+genpts',
        '-copyts',
        '-start_at_zero',
        '-analyzeduration', '60M',
        '-probesize', '60M',
        '-i', inputName,
        '-map', '0:s?',
        '-c:s', 'srt',
        '-fix_sub_duration',
        '-avoid_negative_ts', 'make_zero',
        '-max_interleave_delta', '0',
        '-muxpreload', '0',
        '-muxdelay', '0',
        '-start_number', '1',
        fixPattern
      );
      const fixedFiles = ffmpeg.FS('readdir', '/')
        .filter(f => EXTRACTED_FIX_PATTERN.test(f))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (fixedFiles.length) {
        const fixedTracks = fixedFiles.map((file) => {
          const data = ffmpeg.FS('readFile', file);
          const trackId = String(parseInt((file.match(/extracted_sub_fix_(\d+)\.srt$/i) || [])[1] || '0', 10));
          return {
            id: trackId,
            label: file,
            language: 'und',
            codec: 'srt',
            binary: false,
            byteLength: data.byteLength,
            content: decoder.decode(data)
          };
        });
        const fixedStatus = analyzeCueTimelines(fixedTracks);
        if (!(fixedStatus.flatCueStarts || fixedStatus.nonMonotonicCues)) {
          sendOffscreenLog('PTS-normalized retry improved timelines; using fixed tracks.', 'info', messageId);
          tracks = fixedTracks;
        } else {
          sendOffscreenLog('PTS-normalized retry still looks broken; keeping original tracks.', 'warn', messageId);
        }
      } else {
        sendOffscreenLog('PTS-normalized retry produced no SRT outputs.', 'warn', messageId);
      }
    } catch (normErr) {
      sendOffscreenLog(`PTS-normalized retry failed: ${normErr?.message || normErr}`, 'error', messageId);
    }
  }

  // If still broken, try per-stream remux + setpts-style reset before SRT conversion.
  const postNormStatus = analyzeCueTimelines(tracks);
  if (postNormStatus.flatCueStarts || postNormStatus.nonMonotonicCues) {
    sendOffscreenLog('Timelines still broken after PTS normalization; trying per-stream remux...', 'warn', messageId);
    try {
      const remuxed = [];
      const maxStreams = 32;
      for (let i = 0; i < maxStreams; i++) {
        const outName = `remux_sub_${String(i).padStart(2, '0')}.mkv`;
        try {
          await ffmpeg.run(
            '-y',
            '-analyzeduration', '60M',
            '-probesize', '60M',
            '-copyts',
            '-avoid_negative_ts', 'make_zero',
            '-i', inputName,
            '-map', `0:s:${i}`,
            '-c:s', 'copy',
            outName
          );
          const data = ffmpeg.FS('readFile', outName);
          if (data?.byteLength) remuxed.push(outName);
        } catch (_) {
          try { ffmpeg.FS('unlink', outName); } catch (_) { }
          break;
        }
      }

      const fixedTracks = [];
      for (const remuxName of remuxed) {
        const srtName = remuxName.replace(/\.mkv$/i, '.srt').replace(/^remux_sub_/, 'extracted_sub_fix_');
        try {
          await ffmpeg.run(
            '-y',
            '-fflags', '+genpts',
            '-copyts',
            '-start_at_zero',
            '-avoid_negative_ts', 'make_zero',
            '-analyzeduration', '60M',
            '-probesize', '60M',
            '-i', remuxName,
            '-map', '0:s:0',
            '-c:s', 'srt',
            '-fix_sub_duration',
            srtName
          );
          const data = ffmpeg.FS('readFile', srtName);
          if (data?.byteLength) {
            fixedTracks.push({
              id: String(parseInt((srtName.match(/extracted_sub_fix_(\d+)\.srt$/i) || [])[1] || fixedTracks.length, 10)),
              label: srtName,
              language: 'und',
              codec: 'srt',
              binary: false,
              byteLength: data.byteLength,
              content: decoder.decode(data)
            });
          }
        } catch (convErr) {
          sendOffscreenLog(`Remux conversion failed for ${remuxName}: ${convErr?.message || convErr}`, 'warn', messageId);
        }
      }

      if (fixedTracks.length) {
        const fixedStatus = analyzeCueTimelines(fixedTracks);
        if (!(fixedStatus.flatCueStarts || fixedStatus.nonMonotonicCues)) {
          sendOffscreenLog('Per-stream remux fixed timelines; using remuxed tracks.', 'info', messageId);
          tracks = fixedTracks;
        } else {
          sendOffscreenLog('Per-stream remux still looks broken; keeping prior tracks.', 'warn', messageId);
        }
      } else {
        sendOffscreenLog('Per-stream remux produced no usable tracks.', 'warn', messageId);
      }
    } catch (remuxErr) {
      sendOffscreenLog(`Per-stream remux attempt failed: ${remuxErr?.message || remuxErr}`, 'error', messageId);
    }
  }

  // Apply consistent naming/numbering for all outputs
  tracks = normalizeExtractedTracks(tracks);

  // Best-effort cleanup to avoid FS bloat across runs
  try {
    for (const file of files) ffmpeg.FS('unlink', file);
    ffmpeg.FS('unlink', inputName);
    for (const copyName of copiedTracks) {
      try { ffmpeg.FS('unlink', copyName); } catch (_) { /* ignore */ }
    }
    if (mkvExists) {
      try { ffmpeg.FS('unlink', 'embedded_subs.mkv'); } catch (_) { }
    }
  } catch (_) { /* ignore */ }
  const copyNote = skippedCopies ? `; omitted ${skippedCopies} MKV copy track(s) from output` : '';
  sendOffscreenLog(`Demux finished and cleaned up (${tracks.length} track(s)${copyNote})`, 'info', messageId);

  return tracks;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || `Operation timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/**
 * Extract subtitles using HTML5 Video element and TextTrack API
 * This is the preferred method as it gets complete subtitle tracks without downloading the entire video
 */
async function extractSubtitlesViaVideo(streamUrl, mode, messageId) {
  const normalizedMode = 'single';
  sendOffscreenLog(`Starting video-based subtitle extraction (${normalizedMode} mode)...`, 'info', messageId);
  sendOffscreenLog(`Target URL: ${streamUrl.substring(0, 100)}${streamUrl.length > 100 ? '...' : ''}`, 'info', messageId);

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'use-credentials'; // allow cookie-authenticated hosts (falls back to anonymous on error)
    video.preload = 'metadata';
    video.style.display = 'none';
    document.body.appendChild(video);

    const tracks = [];
    let tracksLoaded = 0;
    let tracksExpected = 0;
    let metadataLoaded = false;
    let cleanupDone = false;
    let retriedAnonymous = false;

    const timeout = setTimeout(() => {
      if (!cleanupDone) {
        cleanup();
        const msg = tracks.length > 0
          ? `Extraction timed out but found ${tracks.length} track(s)`
          : 'Extraction timed out - no tracks found';
        sendOffscreenLog(msg, tracks.length > 0 ? 'warn' : 'error', messageId);
        if (tracks.length > 0) {
          resolve(tracks);
        } else {
          reject(new Error('Video subtitle extraction timed out'));
        }
      }
    }, 120000);

    function cleanup() {
      if (cleanupDone) return;
      cleanupDone = true;
      clearTimeout(timeout);
      video.pause();
      video.src = '';
      video.load();
      try {
        document.body.removeChild(video);
      } catch (_) { }
    }

    function convertVttCuesToSrt(cues) {
      let srt = '';
      let index = 1;

      for (const cue of cues) {
        const startMs = Math.floor(cue.startTime * 1000);
        const endMs = Math.floor(cue.endTime * 1000);

        const startHours = Math.floor(startMs / 3600000);
        const startMinutes = Math.floor((startMs % 3600000) / 60000);
        const startSeconds = Math.floor((startMs % 60000) / 1000);
        const startMillis = startMs % 1000;

        const endHours = Math.floor(endMs / 3600000);
        const endMinutes = Math.floor((endMs % 3600000) / 60000);
        const endSeconds = Math.floor((endMs % 60000) / 1000);
        const endMillis = endMs % 1000;

        const startTime = `${String(startHours).padStart(2, '0')}:${String(startMinutes).padStart(2, '0')}:${String(startSeconds).padStart(2, '0')},${String(startMillis).padStart(3, '0')}`;
        const endTime = `${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:${String(endSeconds).padStart(2, '0')},${String(endMillis).padStart(3, '0')}`;

        srt += `${index}\n${startTime} --> ${endTime}\n${cue.text}\n\n`;
        index++;
      }

      return srt.trim();
    }

    function extractTrackContent(track, trackIndex) {
      return new Promise((resolveTrack) => {
        const trackObj = video.textTracks[trackIndex];
        if (!trackObj) {
          sendOffscreenLog(`Track ${trackIndex} not accessible`, 'warn', messageId);
          resolveTrack(null);
          return;
        }

        const handleCueChange = () => {
          try {
            const cues = Array.from(trackObj.cues || []);
            if (cues.length === 0) {
              sendOffscreenLog(`Track ${trackIndex} loaded but has no cues`, 'warn', messageId);
              resolveTrack(null);
              return;
            }

            const content = convertVttCuesToSrt(cues);
            const sizeKb = Math.round((content.length / 1024) * 10) / 10;
            sendOffscreenLog(`Track ${trackIndex}: extracted ${cues.length} cues (${sizeKb} KB)`, 'info', messageId);

            resolveTrack({
              id: String(trackIndex + 1),
              label: track.label || trackObj.label || `Track ${trackIndex + 1}`,
              language: track.srclang || trackObj.language || 'und',
              codec: 'srt',
              binary: false,
              byteLength: content.length,
              content: content
            });
          } catch (err) {
            sendOffscreenLog(`Failed to extract track ${trackIndex}: ${err?.message || err}`, 'error', messageId);
            resolveTrack(null);
          } finally {
            trackObj.removeEventListener('cuechange', handleCueChange);
            trackObj.mode = 'disabled';
          }
        };

        // Enable the track to trigger cue loading
        trackObj.mode = 'hidden';
        trackObj.addEventListener('cuechange', handleCueChange);

        // If cues are already loaded, trigger immediately
        if (trackObj.cues && trackObj.cues.length > 0) {
          setTimeout(handleCueChange, 100);
        } else {
          // Set a fallback timeout for this specific track
          setTimeout(() => {
            if (trackObj.cues && trackObj.cues.length > 0) {
              handleCueChange();
            } else {
              sendOffscreenLog(`Track ${trackIndex} timed out without loading cues`, 'warn', messageId);
              trackObj.removeEventListener('cuechange', handleCueChange);
              resolveTrack(null);
            }
          }, 30000);
        }
      });
    }

    video.addEventListener('loadedmetadata', async () => {
      if (metadataLoaded) return;
      metadataLoaded = true;

      sendOffscreenLog(`Video metadata loaded - duration: ${Math.round(video.duration)}s, ${video.videoWidth}x${video.videoHeight}`, 'info', messageId);
      sendOffscreenLog(`Video readyState: ${video.readyState}, networkState: ${video.networkState}`, 'info', messageId);

      // Check for text tracks
      tracksExpected = video.textTracks.length;
      sendOffscreenLog(`video.textTracks.length = ${tracksExpected}`, 'info', messageId);

      // Log all available tracks for debugging
      if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
          const track = video.textTracks[i];
          sendOffscreenLog(`  Track ${i}: kind=${track.kind}, label="${track.label}", lang=${track.language}, mode=${track.mode}`, 'info', messageId);
        }
      }

      // Check for video tracks (informational)
      if (video.videoTracks) {
        sendOffscreenLog(`video.videoTracks.length = ${video.videoTracks.length}`, 'info', messageId);
      }

      // Check for audio tracks (informational)
      if (video.audioTracks) {
        sendOffscreenLog(`video.audioTracks.length = ${video.audioTracks.length}`, 'info', messageId);
      }

      if (tracksExpected === 0) {
        sendOffscreenLog('No text tracks found - video.textTracks is empty', 'warn', messageId);
        sendOffscreenLog('IMPORTANT: video.textTracks only exposes tracks added via <track> HTML elements, NOT embedded subtitle streams in the video container (MKV/MP4)', 'warn', messageId);
        sendOffscreenLog('This is expected behavior - FFmpeg fallback will extract embedded streams', 'info', messageId);
        cleanup();
        reject(new Error('No embedded subtitle tracks found in video'));
        return;
      }

      sendOffscreenLog(`Found ${tracksExpected} text track(s), extracting...`, 'info', messageId);

      // Extract each track
      const trackPromises = [];
      for (let i = 0; i < tracksExpected; i++) {
        const track = video.textTracks[i];
        trackPromises.push(extractTrackContent(track, i));
      }

        try {
          const results = await Promise.all(trackPromises);
          const validTracks = results.filter(t => t !== null);

          if (validTracks.length === 0) {
            cleanup();
            reject(new Error('Failed to extract any subtitle content from tracks'));
            return;
          }

          sendOffscreenLog(`Successfully extracted ${validTracks.length}/${tracksExpected} track(s)`, 'info', messageId);
          const namedTracks = normalizeExtractedTracks(validTracks);
          cleanup();
          resolve(namedTracks);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

    video.addEventListener('error', (e) => {
      const error = video.error;
      let errorDetails = 'Unknown error';
      if (error) {
        const errorCodes = {
          1: 'MEDIA_ERR_ABORTED - fetch aborted by user',
          2: 'MEDIA_ERR_NETWORK - network error',
          3: 'MEDIA_ERR_DECODE - decoding error',
          4: 'MEDIA_ERR_SRC_NOT_SUPPORTED - format not supported'
        };
        errorDetails = errorCodes[error.code] || `code ${error.code}`;
        if (error.message) errorDetails += ` - ${error.message}`;
      }
      const msg = `Video element error: ${errorDetails}`;
      sendOffscreenLog(msg, 'error', messageId);
      // If CORS/credentials caused the failure, retry once without credentials
      if (!retriedAnonymous) {
        retriedAnonymous = true;
        sendOffscreenLog('Retrying video load with crossOrigin=anonymous after error...', 'warn', messageId);
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();
          video.crossOrigin = 'anonymous';
          video.src = streamUrl;
          video.load();
          return;
        } catch (_) {
          // fall through to failure
        }
      }
      cleanup();
      reject(new Error(msg));
    });

    // Add event listeners for tracking video load progress
    video.addEventListener('loadstart', () => {
      sendOffscreenLog('Video load started', 'info', messageId);
    });

    let progressCount = 0;
    video.addEventListener('progress', () => {
      // Only log every 5th progress event to avoid spam
      if (++progressCount % 5 === 0) {
        const buffered = video.buffered.length > 0 ? Math.round(video.buffered.end(0) * 10) / 10 : 0;
        sendOffscreenLog(`Video loading progress: ${buffered}s buffered`, 'info', messageId);
      }
    });

    video.addEventListener('stalled', () => {
      sendOffscreenLog('Video load stalled', 'warn', messageId);
    });
    video.addEventListener('suspend', () => {
      sendOffscreenLog('Video load suspended (network idle)', 'info', messageId);
    });
    video.addEventListener('waiting', () => {
      sendOffscreenLog('Video waiting for more data', 'info', messageId);
    });
    video.addEventListener('abort', () => {
      sendOffscreenLog('Video load aborted', 'warn', messageId);
    });

    video.addEventListener('canplay', () => {
      sendOffscreenLog('Video is ready to play', 'info', messageId);
    });

    // Listen for track additions (this would fire if tracks are added dynamically)
    if (video.textTracks) {
      video.textTracks.addEventListener('addtrack', (e) => {
        sendOffscreenLog(`Text track added: kind=${e.track?.kind}, label="${e.track?.label}", lang=${e.track?.language}`, 'info', messageId);
      });
    }

    // Start loading
    sendOffscreenLog('Initializing video element with stream URL...', 'info', messageId);
    video.src = streamUrl;
    video.load();
    sendOffscreenLog('Waiting for video metadata to load...', 'info', messageId);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen] Message received', {
    type: message?.type,
    messageId: message?.messageId,
    transferId: message?.transferId,
    fromTab: sender?.tab?.id,
    frameId: sender?.frameId,
    hasBuffer: !!message?.buffer,
    windowCount: Array.isArray(message?.windows) ? message.windows.length : undefined
  });
  if (message?.type === 'OFFSCREEN_FFMPEG_BUFFER_CHUNK') {
    const res = stashChunk(message.transferId, message.chunkIndex, message.totalChunks, message.chunk, message.expectedBytes, message.chunkArray);
    const shouldLogChunk = message.totalChunks <= 20 || message.chunkIndex === 0 || message.chunkIndex === message.totalChunks - 1 || ((message.chunkIndex + 1) % 25 === 0);
    if (shouldLogChunk) {
      console.log('[Offscreen] Buffer chunk received', {
        transferId: message.transferId,
        idx: message.chunkIndex + 1,
        total: message.totalChunks,
        complete: res?.complete
      });
    }
    sendResponse(res);
    return false;
  }

  if (message?.type === 'OFFSCREEN_FFMPEG_EXTRACT') {
    const requestId = message?.messageId;
    console.log('[Offscreen] Handling OFFSCREEN_FFMPEG_EXTRACT', {
      requestId,
      hasBuffer: !!message?.buffer,
      transferId: message?.transferId
    });
    (async () => {
      let responded = false;
      const respond = (payload) => {
        if (responded) return;
        responded = true;
        console.log('[Offscreen] Responding to demux request', {
          requestId,
          success: payload?.success,
          hasTracks: Array.isArray(payload?.tracks)
        });
        const slim = payload ? {
          success: payload.success,
          error: payload.error,
          messageId: requestId,
          chunked: payload.chunked === true
        } : undefined;
        try { sendResponse(slim); } catch (err) { console.warn('[Offscreen] sendResponse failed:', err); }
        try {
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_FFMPEG_RESULT',
            messageId: requestId,
            ...payload
          });
        } catch (err) {
          console.warn('[Offscreen] Failed to push demux result to background:', err);
        }
      };
      try {
        let incomingBuffer = message?.buffer;
        const transferId = message?.transferId || (incomingBuffer && incomingBuffer.transferId);

        if (message?.transferMethod === 'idb' && transferId) {
          try {
            incomingBuffer = await SubMakerTransfer.loadTransferBuffer(transferId);
            // Clean up immediately after loading
            SubMakerTransfer.deleteTransferBuffer(transferId).catch(e => console.warn('Failed to delete transfer buffer', e));
          } catch (err) {
            throw new Error(`Failed to load IDB transfer buffer: ${err.message}`);
          }
        } else if (!incomingBuffer && transferId) {
          incomingBuffer = consumeChunkedBuffer(transferId);
          if (!incomingBuffer) {
            throw new Error('Chunked buffer incomplete or missing for demux request');
          }
        }
        if (incomingBuffer && incomingBuffer.transferId) {
          incomingBuffer = consumeChunkedBuffer(incomingBuffer.transferId);
        }
        if (!incomingBuffer) throw new Error('Missing buffer in offscreen request');
        const sizeMb = Math.round(((incomingBuffer?.byteLength || incomingBuffer?.size || 0) / (1024 * 1024)) * 10) / 10;
        sendOffscreenLog(`Received demux request (job ${requestId || 'n/a'}), size: ${sizeMb} MB`, 'info', requestId);
        sendOffscreenLog(`Offscreen env: SAB=${typeof SharedArrayBuffer !== 'undefined' ? 'yes' : 'no'}, COI=${self.crossOriginIsolated === false ? 'no' : 'yes'}`, 'info', requestId);
        const tracks = await withTimeout(
          demuxSubtitles(incomingBuffer, requestId),
          90000,
          `FFmpeg demux timed out in offscreen page${requestId ? ` (job ${requestId})` : ''}`
        );
        const prepared = await prepareTracksForSend(tracks, requestId);
        respond({ success: true, tracks: prepared.tracks, chunked: prepared.chunked });
      } catch (err) {
        console.error('[Offscreen] Extraction failed:', err);
        sendOffscreenLog(`Demux failed: ${err?.message || err}`, 'error', requestId);
        respond({ success: false, error: err?.message || String(err) });
      }
    })();
    return true; // async
  }

  if (message?.type === 'OFFSCREEN_FFMPEG_DECODE') {
    const requestId = message?.messageId;
    console.log('[Offscreen] Handling OFFSCREEN_FFMPEG_DECODE', {
      requestId,
      windowCount: Array.isArray(message?.windows) ? message.windows.length : 0
    });
    (async () => {
      let responded = false;
      const cloneAudioWindows = (wins) => {
        if (!Array.isArray(wins)) return [];
        return wins.map((w) => {
          const bytes = w?.audioBytes;
          let cloned = null;
          if (bytes instanceof Uint8Array) {
            cloned = bytes.slice();
          } else if (bytes && typeof bytes.byteLength === 'number') {
            cloned = new Uint8Array(bytes);
          } else if (Array.isArray(bytes)) {
            cloned = Uint8Array.from(bytes);
          }
          return {
            audioBytes: cloned || new Uint8Array(0),
            startMs: Math.round(w?.startMs || 0)
          };
        });
      };
      const respond = (payload) => {
        if (responded) return;
        responded = true;
        console.log('[Offscreen] Responding to decode request', {
          requestId,
          success: payload?.success,
          windows: payload?.audioWindows?.length
        });
        const slim = payload ? {
          success: payload.success,
          error: payload.error,
          messageId: requestId,
          chunked: payload.chunked === true
        } : undefined;
        try { sendResponse(slim); } catch (err) { console.warn('[Offscreen] sendResponse failed:', err); }
        try {
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_FFMPEG_RESULT',
            messageId: requestId,
            ...payload
          });
        } catch (err) {
          console.warn('[Offscreen] Failed to push decode result to background:', err);
        }
      };

      try {
        const rawWindows = Array.isArray(message?.windows) ? message.windows : [];
        if (!rawWindows.length) {
          throw new Error('No audio windows provided for decode');
        }
        const windows = rawWindows.map((w, idx) => {
          let buf = w?.buffer;
          const transferId = w?.transferId || (buf && buf.transferId);
          if (!buf && transferId) {
            buf = consumeChunkedBuffer(transferId);
          }
          if (buf && buf.transferId) {
            buf = consumeChunkedBuffer(buf.transferId);
          }
          if (!buf) {
            throw new Error(`Missing buffer for window ${idx + 1}`);
          }
          return {
            buffer: buf instanceof Uint8Array ? buf : new Uint8Array(buf),
            startSec: w?.startSec,
            durSec: w?.durSec,
            seekToSec: w?.seekToSec
          };
        });

        const decoded = await withTimeout(
          decodeAudioWindows(windows, 'single', requestId),
          180000,
          `FFmpeg audio decode timed out${requestId ? ` (job ${requestId})` : ''}`
        );
        const safeWindows = cloneAudioWindows(decoded);

        const prepared = [];
        for (let i = 0; i < safeWindows.length; i++) {
          const win = safeWindows[i];
          const bytes = win?.audioBytes instanceof Uint8Array ? win.audioBytes : new Uint8Array(win?.audioBytes || []);
          const transferId = `adec_${requestId || Date.now()}_${i}_${Math.random().toString(16).slice(2)}`;
          await sendResultChunksToBackground(transferId, bytes, requestId, `audio_${i + 1}`);
          prepared.push({
            transferId,
            totalBytes: bytes.byteLength,
            startMs: Math.round(win?.startMs || 0),
            chunked: true
          });
        }

        respond({ success: true, audioWindows: prepared, chunked: true });
      } catch (err) {
        console.error('[Offscreen] Audio decode failed:', err);
        sendOffscreenLog(`Audio decode failed: ${err?.message || err}`, 'error', requestId);
        respond({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }

  if (message?.type === 'OFFSCREEN_VIDEO_EXTRACT') {
    const requestId = message?.messageId;
    console.log('[Offscreen] Handling OFFSCREEN_VIDEO_EXTRACT', {
      requestId,
      streamUrl: message?.streamUrl?.substring(0, 80)
    });
    (async () => {
      let responded = false;
      const respond = (payload) => {
        if (responded) return;
        responded = true;
        console.log('[Offscreen] Responding to video extract', {
          requestId,
          success: payload?.success,
          tracks: payload?.tracks?.length
        });
        const slim = payload ? {
          success: payload.success,
          error: payload.error,
          messageId: requestId,
          chunked: payload.chunked === true
        } : undefined;
        try { sendResponse(slim); } catch (err) { console.warn('[Offscreen] sendResponse failed:', err); }
        try {
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_VIDEO_RESULT',
            messageId: requestId,
            ...payload
          });
        } catch (err) {
          console.warn('[Offscreen] Failed to push video extract result to background:', err);
        }
      };

      try {
        const streamUrl = message?.streamUrl;
        const mode = 'single';

        if (!streamUrl) {
          throw new Error('Missing streamUrl for video extraction');
        }

        sendOffscreenLog(`Starting video-based extraction for ${streamUrl.substring(0, 60)}...`, 'info', requestId);

        const tracks = await withTimeout(
          extractSubtitlesViaVideo(streamUrl, mode, requestId),
          180000,
          `Video extraction timed out${requestId ? ` (job ${requestId})` : ''}`
        );

        const prepared = await prepareTracksForSend(tracks, requestId);
        respond({ success: true, tracks: prepared.tracks, chunked: prepared.chunked });
      } catch (err) {
        console.error('[Offscreen] Video extraction failed:', err);
        sendOffscreenLog(`Video extraction failed: ${err?.message || err}`, 'error', requestId);
        respond({ success: false, error: err?.message || String(err) });
      }
    })();
    return true;
  }
});

console.log('[Offscreen] Ready for FFmpeg demux and video extraction requests');
