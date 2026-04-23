import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  setLayerDimensions,
} from 'pdfjs-dist/build/pdf.mjs';

GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const RENDER_SCALE = 1.35;
const CHUNK_CHAR_TARGET = 880;
const HEIGHT_PREFETCH_CONCURRENCY = 8;
const SPEAK_RESTART_MS = 52;
const THEME_KEY = 'pdf-audio-theme';
const VOICE_URI_KEY = 'pdf-audio-voice-uri';

const els = {
  fileInput: document.getElementById('file-input'),
  stage: document.getElementById('stage'),
  empty: document.getElementById('empty-state'),
  viewer: document.getElementById('viewer'),
  ttsToggle: document.getElementById('tts-toggle'),
  ttsPanel: document.getElementById('tts-panel'),
  themeToggle: document.getElementById('theme-toggle'),
  rate: document.getElementById('rate'),
  rateLabel: document.getElementById('rate-label'),
  voiceTrigger: document.getElementById('voice-trigger'),
  voiceTriggerLabel: document.getElementById('voice-trigger-label'),
  voicePanel: document.getElementById('voice-panel'),
  voiceFilter: document.getElementById('voice-filter'),
  voiceListbox: document.getElementById('voice-listbox'),
  voiceField: document.getElementById('voice-field'),
  chunk: document.getElementById('chunk'),
  seekTrack: document.getElementById('seek-track'),
  seekFill: document.getElementById('seek-fill'),
  seekThumb: document.getElementById('seek-thumb'),
  seekTime: document.getElementById('seek-time'),
  prevChunk: document.getElementById('prev-chunk'),
  nextChunk: document.getElementById('next-chunk'),
  playPause: document.getElementById('play-pause'),
  stop: document.getElementById('stop'),
  rewindStart: document.getElementById('rewind-start'),
};

/** @type {import('pdfjs-dist/build/pdf.mjs').PDFDocumentProxy | null} */
let pdfDoc = null;
/** @type {HTMLSpanElement[]} */
let orderedSpans = [];
/** @type {{ start: number; end: number; text: string }[]} */
let chunks = [];
let currentChunk = 0;
let speaking = false;
let paused = false;
/** True between scheduling speak and first utterance (covers cancel→speak delay). */
let ttsArmed = false;

/** Bumps whenever TTS should abandon in-flight scheduling or utterance chains. */
let speakGen = 0;
/** @type {ReturnType<typeof setTimeout> | 0} */
let speakScheduleTimer = 0;
/** @type {ReturnType<typeof setTimeout> | 0} */
let restartDebounceTimer = 0;

const rendered = new Set();
let io = null;

/** @type {string} */
let selectedVoiceUri = '';
/** @type {SpeechSynthesisVoice[]} */
let cachedSortedVoices = [];
let voiceListOpen = false;

let seekDragging = false;
let seekResumePlayback = false;

function isActivelyPlaying() {
  const s = window.speechSynthesis;
  return ttsArmed || speaking || s.speaking || s.pending || s.paused;
}

function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
  if (els.themeToggle) {
    els.themeToggle.setAttribute(
      'aria-label',
      t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
    );
  }
}

function initTheme() {
  let t = 'light';
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') t = stored;
  } catch {
    /* ignore */
  }
  applyTheme(t);
}

function formatRate(v) {
  const n = Math.round(Number(v) * 20) / 20;
  return `${n}×`;
}

function readStoredVoiceUri() {
  try {
    return localStorage.getItem(VOICE_URI_KEY) || '';
  } catch {
    return '';
  }
}

function writeStoredVoiceUri(uri) {
  try {
    if (uri) localStorage.setItem(VOICE_URI_KEY, uri);
  } catch {
    /* ignore */
  }
}

function pickVoiceUri(voices, previousUri, storedUri) {
  const byUri = (uri) => uri && voices.some((v) => v.voiceURI === uri);
  if (byUri(previousUri)) return previousUri;
  if (byUri(storedUri)) return storedUri;
  const nav = voices.find((v) => v.lang.startsWith(navigator.language));
  if (nav) return nav.voiceURI;
  return voices[0]?.voiceURI || '';
}

function formatVoiceLabel(v) {
  const scope = v.localService ? 'Local' : 'Browser';
  return `${v.name} — ${v.lang} (${scope})`;
}

function sortVoicesList(raw) {
  return raw.slice().sort((a, b) => {
    const la = (a.localService ? '0' : '1') + a.name;
    const lb = (b.localService ? '0' : '1') + b.name;
    return la.localeCompare(lb);
  });
}

function populateVoices() {
  const raw = window.speechSynthesis.getVoices();
  if (!raw.length) return;

  const previousUri = selectedVoiceUri;
  const storedUri = readStoredVoiceUri();

  cachedSortedVoices = sortVoicesList(raw);
  const chosen = pickVoiceUri(cachedSortedVoices, previousUri, storedUri);
  selectedVoiceUri = chosen || '';
  syncVoiceTriggerLabel();
  hideVoiceList();
}

function getSelectedVoice() {
  const fromCache = cachedSortedVoices.find((v) => v.voiceURI === selectedVoiceUri);
  if (fromCache) return fromCache;
  return window.speechSynthesis.getVoices().find((v) => v.voiceURI === selectedVoiceUri) || null;
}

function syncVoiceTriggerLabel() {
  const v = getSelectedVoice();
  const label = v ? formatVoiceLabel(v) : 'Choose a voice…';
  els.voiceTriggerLabel.textContent = label;
  els.voiceTriggerLabel.title = v ? formatVoiceLabel(v) : '';
}

function clearVoiceFilter() {
  els.voiceFilter.value = '';
}

function voiceMatchesFilter(v, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  const hay = `${v.name} ${v.lang} ${v.voiceURI}`.toLowerCase();
  return hay.includes(needle);
}

function renderVoiceListbox() {
  const q = els.voiceFilter.value;
  const frag = document.createDocumentFragment();
  for (const v of cachedSortedVoices) {
    if (!voiceMatchesFilter(v, q)) continue;
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = 'voice-option';
    if (v.voiceURI === selectedVoiceUri) li.classList.add('is-selected');
    li.setAttribute('aria-selected', v.voiceURI === selectedVoiceUri ? 'true' : 'false');
    li.textContent = formatVoiceLabel(v);
    li.dataset.voiceUri = v.voiceURI;
    li.tabIndex = -1;
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      selectVoiceByUri(v.voiceURI);
    });
    frag.appendChild(li);
  }
  if (!frag.childNodes.length) {
    const empty = document.createElement('li');
    empty.className = 'voice-option voice-option-empty';
    empty.textContent = q.trim()
      ? 'No voices match — try a shorter search'
      : 'No voices available';
    frag.appendChild(empty);
  }
  els.voiceListbox.replaceChildren(frag);
  const first = els.voiceListbox.querySelector('.voice-option:not(.voice-option-empty)');
  first?.scrollIntoView({ block: 'nearest' });
}

function showVoiceList() {
  voiceListOpen = true;
  els.voicePanel.hidden = false;
  els.voiceTrigger.setAttribute('aria-expanded', 'true');
  renderVoiceListbox();
  window.setTimeout(() => els.voiceFilter.focus(), 0);
}

function hideVoiceList() {
  voiceListOpen = false;
  els.voicePanel.hidden = true;
  els.voiceTrigger.setAttribute('aria-expanded', 'false');
  clearVoiceFilter();
}

function selectVoiceByUri(uri) {
  if (!cachedSortedVoices.some((v) => v.voiceURI === uri)) return;
  selectedVoiceUri = uri;
  writeStoredVoiceUri(uri);
  syncVoiceTriggerLabel();
  hideVoiceList();
  scheduleRestartIfPlaying();
}

function joinChunkParts(parts) {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {HTMLSpanElement[]} spans
 */
function buildChunksFromSpans(spans) {
  const out = [];
  /** @type {{ i: number; t: string }[]} */
  let buf = [];

  const flush = () => {
    if (!buf.length) return;
    const text = joinChunkParts(buf.map((b) => b.t));
    if (text) {
      out.push({
        start: buf[0].i,
        end: buf[buf.length - 1].i,
        text,
      });
    }
    buf = [];
  };

  for (let i = 0; i < spans.length; i++) {
    const raw = (spans[i].textContent || '').replace(/\u00a0/g, ' ');
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) continue;

    const trial = joinChunkParts(buf.length ? [...buf.map((b) => b.t), t] : [t]);
    if (trial.length > CHUNK_CHAR_TARGET && buf.length) {
      flush();
    }
    buf.push({ i, t });
  }
  flush();
  return out;
}

function rebuildReadingOrder() {
  /** @type {HTMLSpanElement[]} */
  const next = [];
  for (const shell of els.viewer.querySelectorAll('.page-shell')) {
    const tl = shell.querySelector('.textLayer');
    if (!tl) continue;
    for (const n of tl.querySelectorAll('span[role="presentation"]')) {
      if (n instanceof HTMLSpanElement) next.push(n);
    }
  }
  const wasSpeaking = window.speechSynthesis.speaking || window.speechSynthesis.pending;
  orderedSpans = next;
  chunks = buildChunksFromSpans(orderedSpans);
  currentChunk = Math.min(currentChunk, Math.max(0, chunks.length - 1));
  syncChunkUi();
  if (wasSpeaking) stopSpeech(false);
}

function estimateChunkSeconds(text, rate) {
  const r = Math.max(0.5, rate);
  const chars = Math.max(1, text.length);
  return Math.max(1.2, chars / (12.5 * r));
}

function chunkTimeStartsAndTotal() {
  const rate = Number(els.rate.value) || 1;
  const starts = [0];
  for (let i = 0; i < chunks.length; i++) {
    starts.push(starts[i] + estimateChunkSeconds(chunks[i].text, rate));
  }
  return { starts, total: starts[starts.length - 1] || 0 };
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function ratioFromClientX(clientX) {
  const rect = els.seekTrack.getBoundingClientRect();
  if (rect.width <= 0) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

function chunkIndexFromSeekRatio(ratio) {
  if (!chunks.length) return 0;
  if (chunks.length === 1) return 0;
  return Math.min(chunks.length - 1, Math.round(ratio * (chunks.length - 1)));
}

function ratioFromChunkIndex(ci) {
  if (!chunks.length || chunks.length === 1) return 0;
  return ci / (chunks.length - 1);
}

function updateSeekVisuals() {
  if (!els.seekTime) return;
  if (!chunks.length) {
    els.seekTime.textContent = '0:00 / 0:00';
    els.seekFill.style.width = '0%';
    els.seekThumb.style.left = '0%';
    els.seekTrack.setAttribute('aria-valuemax', '0');
    els.seekTrack.setAttribute('aria-valuenow', '0');
    els.seekTrack.setAttribute('aria-valuetext', 'No document loaded');
    return;
  }
  const { starts, total } = chunkTimeStartsAndTotal();
  const max = chunks.length - 1;
  const safeChunk = Math.min(currentChunk, max);
  const elapsed = starts[safeChunk] ?? 0;
  els.seekTime.textContent = `${formatClock(elapsed)} / ${formatClock(total)}`;
  const pct = ratioFromChunkIndex(safeChunk) * 100;
  els.seekFill.style.width = `${pct}%`;
  els.seekThumb.style.left = `${pct}%`;
  els.seekTrack.setAttribute('aria-valuemax', String(max));
  els.seekTrack.setAttribute('aria-valuenow', String(safeChunk));
  els.seekTrack.setAttribute(
    'aria-valuetext',
    `Passage ${safeChunk + 1} of ${chunks.length}, about ${formatClock(elapsed)}`,
  );
}

function applySeekClientX(clientX) {
  if (!chunks.length) return;
  const ratio = ratioFromClientX(clientX);
  currentChunk = chunkIndexFromSeekRatio(ratio);
  syncChunkUi();
}

function wireSeekScrubber() {
  const endSeek = (e) => {
    if (!seekDragging) return;
    seekDragging = false;
    try {
      els.seekTrack.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    applySeekClientX(e.clientX);
    if (seekResumePlayback) speakFromCurrent();
    seekResumePlayback = false;
  };

  els.seekTrack.addEventListener('pointerdown', (e) => {
    if (!chunks.length || e.button !== 0) return;
    seekDragging = true;
    seekResumePlayback = isActivelyPlaying();
    if (seekResumePlayback) stopSpeech(false);
    try {
      els.seekTrack.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    applySeekClientX(e.clientX);
  });

  els.seekTrack.addEventListener('pointermove', (e) => {
    if (!seekDragging) return;
    applySeekClientX(e.clientX);
  });

  els.seekTrack.addEventListener('pointerup', endSeek);
  els.seekTrack.addEventListener('pointercancel', endSeek);

  els.seekTrack.addEventListener('keydown', (e) => {
    if (!chunks.length) return;
    const max = chunks.length - 1;
    let next = currentChunk;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(max, currentChunk + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, currentChunk - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    const was = isActivelyPlaying();
    if (was) stopSpeech(false);
    currentChunk = next;
    syncChunkUi();
    if (was) speakFromCurrent();
  });
}

function syncChunkUi() {
  const max = Math.max(0, chunks.length - 1);
  els.chunk.max = String(max);
  els.chunk.value = String(Math.min(currentChunk, max));
  els.prevChunk.disabled = currentChunk <= 0;
  els.nextChunk.disabled = currentChunk >= max;
  updateSeekVisuals();
}

function chunkIndexForSpanIndex(spanIdx) {
  if (spanIdx < 0 || !chunks.length) return 0;
  for (let c = 0; c < chunks.length; c++) {
    const { start, end } = chunks[c];
    if (spanIdx >= start && spanIdx <= end) return c;
  }
  return 0;
}

function stopSpeech(resetChunk = false) {
  if (speakScheduleTimer) {
    window.clearTimeout(speakScheduleTimer);
    speakScheduleTimer = 0;
  }
  ttsArmed = false;
  speakGen++;
  window.speechSynthesis.cancel();
  try {
    window.speechSynthesis.resume();
  } catch {
    /* ignore */
  }
  speaking = false;
  paused = false;
  els.playPause.textContent = 'Play';
  if (resetChunk) currentChunk = 0;
  syncChunkUi();
}

function speakFromCurrent() {
  if (!chunks.length) return;

  if (speakScheduleTimer) {
    window.clearTimeout(speakScheduleTimer);
    speakScheduleTimer = 0;
  }
  speakGen++;
  const myGen = speakGen;
  ttsArmed = true;
  window.speechSynthesis.cancel();
  try {
    window.speechSynthesis.resume();
  } catch {
    /* ignore */
  }

  speakScheduleTimer = window.setTimeout(() => {
    speakScheduleTimer = 0;
    if (myGen !== speakGen) {
      ttsArmed = false;
      return;
    }

    paused = false;
    speaking = true;
    els.playPause.textContent = 'Pause';

    const run = (i) => {
      if (myGen !== speakGen) return;
      if (i >= chunks.length) {
        stopSpeech(false);
        currentChunk = Math.max(0, chunks.length - 1);
        syncChunkUi();
        return;
      }
      currentChunk = i;
      syncChunkUi();
      const u = new SpeechSynthesisUtterance(chunks[i].text);
      u.rate = Number(els.rate.value) || 1;
      const voice = getSelectedVoice();
      if (voice) u.voice = voice;
      u.onend = () => {
        if (myGen !== speakGen) return;
        run(i + 1);
      };
      u.onerror = () => {
        if (myGen !== speakGen) return;
        run(i + 1);
      };
      window.speechSynthesis.speak(u);
    };

    run(currentChunk);
  }, SPEAK_RESTART_MS);
}

function togglePlayPause() {
  if (!chunks.length) return;
  if (!isActivelyPlaying()) {
    speakFromCurrent();
    return;
  }
  if (ttsArmed && !speaking) {
    return;
  }
  if (window.speechSynthesis.speaking && !window.speechSynthesis.paused) {
    try {
      window.speechSynthesis.pause();
      paused = true;
      els.playPause.textContent = 'Play';
    } catch {
      stopSpeech(false);
    }
  } else if (window.speechSynthesis.paused) {
    try {
      window.speechSynthesis.resume();
    } catch {
      speakFromCurrent();
      return;
    }
    paused = false;
    els.playPause.textContent = 'Pause';
  } else {
    speakFromCurrent();
  }
}

function scheduleRestartIfPlaying() {
  if (restartDebounceTimer) window.clearTimeout(restartDebounceTimer);
  restartDebounceTimer = window.setTimeout(() => {
    restartDebounceTimer = 0;
    if (!chunks.length) return;
    if (!isActivelyPlaying()) return;
    speakFromCurrent();
  }, 100);
}

async function renderPage(pageNum) {
  if (!pdfDoc || rendered.has(pageNum)) return;
  rendered.add(pageNum);

  const shell = els.viewer.querySelector(`.page-shell[data-page="${pageNum}"]`);
  if (!shell) return;

  shell.innerHTML = '';
  const inner = document.createElement('div');
  inner.className = 'page-inner';
  const canvas = document.createElement('canvas');
  const textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  inner.append(canvas, textLayerDiv);
  shell.append(inner);

  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: RENDER_SCALE });
  shell.style.setProperty('--scale-factor', String(viewport.scale));

  const ctx = canvas.getContext('2d', { alpha: false });
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({ canvasContext: ctx, viewport }).promise;

  setLayerDimensions(textLayerDiv, viewport);
  const textLayer = new TextLayer({
    textContentSource: page.streamTextContent({
      includeMarkedContent: true,
      disableNormalization: true,
    }),
    container: textLayerDiv,
    viewport,
  });
  await textLayer.render();

  const end = document.createElement('div');
  end.className = 'endOfContent';
  textLayerDiv.append(end);

  rebuildReadingOrder();
}

function setupIntersectionObserver() {
  io?.disconnect();
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const p = Number(e.target.getAttribute('data-page'));
        if (p) void renderPage(p);
      }
    },
    { root: els.stage, rootMargin: '320px 0px', threshold: 0 },
  );
  for (const shell of els.viewer.querySelectorAll('.page-shell')) io.observe(shell);
}

async function prefetchHeights(numPages) {
  if (!pdfDoc) return;
  let next = 1;
  const worker = async () => {
    while (next <= numPages) {
      const p = next++;
      const page = await pdfDoc.getPage(p);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const shell = els.viewer.querySelector(`.page-shell[data-page="${p}"]`);
      if (shell) shell.style.minHeight = `${vp.height}px`;
    }
  };
  await Promise.all(
    Array.from({ length: HEIGHT_PREFETCH_CONCURRENCY }, () => worker()),
  );
}

async function loadPdfBuffer(buf) {
  stopSpeech(true);
  rendered.clear();
  orderedSpans = [];
  chunks = [];
  currentChunk = 0;
  syncChunkUi();

  pdfDoc = await getDocument({ data: buf }).promise;
  const n = pdfDoc.numPages;

  els.empty.classList.add('hidden');
  els.viewer.classList.remove('hidden');
  els.viewer.innerHTML = '';

  for (let p = 1; p <= n; p++) {
    const shell = document.createElement('div');
    shell.className = 'page-shell';
    shell.dataset.page = String(p);
    shell.innerHTML = '<div class="page-placeholder">Page loading…</div>';
    els.viewer.append(shell);
  }

  setupIntersectionObserver();
  await prefetchHeights(n);

  for (const shell of els.viewer.querySelectorAll('.page-shell')) {
    const ph = shell.querySelector('.page-placeholder');
    ph?.remove();
  }

  void renderPage(1);
}

function onViewerClick(ev) {
  if (!(ev.target instanceof Element)) return;
  if (ev.target.closest('.tts-panel, .tts-fab')) return;
  if (window.getSelection()?.toString().trim()) return;

  const span = ev.target.closest('span[role="presentation"]');
  if (!(span instanceof HTMLSpanElement)) return;
  if (!orderedSpans.length || !chunks.length) return;

  const idx = orderedSpans.indexOf(span);
  if (idx < 0) return;

  currentChunk = chunkIndexForSpanIndex(idx);
  syncChunkUi();
  speakFromCurrent();
  els.ttsPanel.classList.remove('hidden');
  els.ttsToggle.setAttribute('aria-expanded', 'true');
}

function wireUi() {
  initTheme();
  els.themeToggle?.addEventListener('click', () => {
    const next =
      document.documentElement.getAttribute('data-theme') === 'light'
        ? 'dark'
        : 'light';
    applyTheme(next);
  });

  els.rate.addEventListener('input', () => {
    els.rateLabel.textContent = formatRate(els.rate.value);
    scheduleRestartIfPlaying();
    updateSeekVisuals();
  });
  els.rateLabel.textContent = formatRate(els.rate.value);

  els.voiceTrigger.addEventListener('click', () => {
    if (voiceListOpen) hideVoiceList();
    else showVoiceList();
  });

  els.voiceFilter.addEventListener('input', () => {
    renderVoiceListbox();
  });

  els.voiceFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      hideVoiceList();
      els.voiceTrigger.focus();
    }
  });

  els.voiceTrigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (!voiceListOpen) showVoiceList();
    }
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (!(e.target instanceof Node)) return;
      if (!voiceListOpen) return;
      if (els.voiceField.contains(e.target)) return;
      hideVoiceList();
    },
    true,
  );

  window.speechSynthesis.addEventListener('voiceschanged', populateVoices);
  populateVoices();

  els.fileInput.addEventListener('change', async () => {
    const f = els.fileInput.files?.[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    await loadPdfBuffer(new Uint8Array(buf));
    els.fileInput.value = '';
  });

  els.stage.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  els.stage.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (!f || f.type !== 'application/pdf') return;
    const buf = await f.arrayBuffer();
    await loadPdfBuffer(new Uint8Array(buf));
  });

  els.viewer.addEventListener('click', onViewerClick);

  wireSeekScrubber();

  els.ttsToggle.addEventListener('click', () => {
    const open = els.ttsPanel.classList.toggle('hidden');
    els.ttsToggle.setAttribute('aria-expanded', String(!open));
  });

  els.chunk.addEventListener('input', () => {
    currentChunk = Number(els.chunk.value);
    syncChunkUi();
    if (isActivelyPlaying()) speakFromCurrent();
  });

  els.prevChunk.addEventListener('click', () => {
    currentChunk = Math.max(0, currentChunk - 1);
    syncChunkUi();
    if (isActivelyPlaying()) speakFromCurrent();
  });

  els.nextChunk.addEventListener('click', () => {
    currentChunk = Math.min(chunks.length - 1, currentChunk + 1);
    syncChunkUi();
    if (isActivelyPlaying()) speakFromCurrent();
  });

  els.playPause.addEventListener('click', () => togglePlayPause());
  els.stop.addEventListener('click', () => stopSpeech(false));
  els.rewindStart.addEventListener('click', () => {
    currentChunk = 0;
    syncChunkUi();
    speakFromCurrent();
  });

  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
    if (t === els.voiceTrigger) return;
    if (t instanceof Node && els.seekTrack.contains(t)) return;
    if (!chunks.length) return;
    e.preventDefault();
    togglePlayPause();
  });
}

wireUi();
