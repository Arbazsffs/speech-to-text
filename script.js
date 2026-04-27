/**
 * VoiceNotes Pro — app.js
 * Speech recognition, translation, session history, UI controls
 */

'use strict';

/* ── DOM References ── */
const $ = id => document.getElementById(id);

const startBtn = $('start-btn');
const stopBtn = $('stop-btn');
const clearBtn = $('clear-btn');
const copyBtn = $('copy-btn');
const downloadBtn = $('download-btn');
const transcriptEl = $('transcript');
const statusTextEl = $('status-text');
const statusClockEl = $('status-clock');
const langSelect = $('lang-select');
const translateToggle = $('translate-toggle');
const timestampToggle = $('timestamp-toggle');
const historyList = $('history-list');
const historyEmpty = $('history-empty');
const clearHistoryBtn = $('clear-history-btn');
const wordCountEl = $('word-count');
const charCountEl = $('char-count');
const toastEl = $('toast');
const recorderUnit = $('recorder-unit');
const unsupportedOverlay = $('unsupported-overlay');

/* ── State ── */
let fullTranscript = '';
let sessionHistory = [];
let sessionStart = null;
let clockInterval = null;
let isRecording = false;
let toastTimeout = null;
let recognition = null;

/* ─────────────────────────────────
   TOAST
───────────────────────────────── */
function showToast(message, duration = 2400) {
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toastEl.classList.remove('is-visible'), duration);
}

/* ─────────────────────────────────
   STATUS & UI STATE
───────────────────────────────── */
const STATUS = {
  IDLE: { cls: '', text: 'STANDBY' },
  RECORDING: { cls: 'is-recording', text: 'RECORDING' },
  TRANSLATING: { cls: 'is-translating', text: 'TRANSLATING' },
};

function setStatus(state) {
  recorderUnit.classList.remove('is-recording', 'is-translating');
  if (state.cls) recorderUnit.classList.add(state.cls);
  statusTextEl.textContent = state.text;
}

function setRecordingUI(active) {
  startBtn.disabled = active;
  stopBtn.disabled = !active;
  langSelect.disabled = active;
  isRecording = active;
}

/* ─────────────────────────────────
   ELAPSED CLOCK
───────────────────────────────── */
function startClock() {
  sessionStart = Date.now();
  clockInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    statusClockEl.textContent = `${mm}:${ss}`;
  }, 1000);
}

function stopClock() {
  clearInterval(clockInterval);
  clockInterval = null;
  statusClockEl.textContent = '00:00';
}

/* ─────────────────────────────────
   WORD / CHAR COUNTER
───────────────────────────────── */
function updateCounts(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  wordCountEl.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  charCountEl.textContent = `${text.length} chars`;
}

/* ─────────────────────────────────
   TRANSLATION
───────────────────────────────── */
async function translateText(text, fromLang) {
  const code = fromLang.split('-')[0];
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${code}|en`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.responseStatus === 200) return data.responseData.translatedText;
    return '[Translation unavailable]';
  } catch {
    return '[Translation service busy]';
  }
}

/* ─────────────────────────────────
   SESSION HISTORY
───────────────────────────────── */
function saveToHistory(text, lang) {
  if (!text.trim()) return;

  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { month: 'short', day: 'numeric' });

  sessionHistory.unshift({ text, lang, time, date });
  renderHistory();
}

function renderHistory() {
  if (sessionHistory.length === 0) {
    historyEmpty.style.display = '';
    // Remove all items
    [...historyList.querySelectorAll('.history-item')].forEach(el => el.remove());
    return;
  }

  historyEmpty.style.display = 'none';
  historyList.innerHTML = '';

  sessionHistory.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    item.setAttribute('role', 'listitem');
    item.setAttribute('tabindex', '0');
    item.setAttribute('aria-label', `Restore session from ${entry.date} ${entry.time}`);
    item.title = 'Click to restore this session';

    item.innerHTML = `
      <div class="history-preview">${escapeHtml(entry.text)}</div>
      <div class="history-info">
        <span class="history-time">${entry.date} · ${entry.time}</span>
        <span class="history-lang-tag">${entry.lang.split('-')[0].toUpperCase()}</span>
      </div>
    `;

    item.addEventListener('click', () => restoreSession(index));
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        restoreSession(index);
      }
    });

    historyList.appendChild(item);
  });
}

function restoreSession(index) {
  fullTranscript = sessionHistory[index].text;
  transcriptEl.value = fullTranscript;
  updateCounts(fullTranscript);
  showToast('Session restored ↑');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ─────────────────────────────────
   SPEECH RECOGNITION SETUP
───────────────────────────────── */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (!SpeechRecognition) {
  unsupportedOverlay.hidden = false;
} else {
  initRecognition();
}

function initRecognition() {
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;

  /* ── Result handler ── */
  recognition.onresult = async (event) => {
    let interimText = '';
    let finalSentence = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalSentence = transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalSentence) {
      let chunk = finalSentence.trim();

      // Optional timestamp prefix
      if (timestampToggle.checked && sessionStart) {
        const elapsed = Math.floor((Date.now() - sessionStart) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        chunk = `[${mm}:${ss}]  ${chunk}`;
      }

      // Optional translation
      if (translateToggle.checked && !langSelect.value.startsWith('en')) {
        setStatus(STATUS.TRANSLATING);
        const translated = await translateText(finalSentence, langSelect.value);
        fullTranscript += `\n[Original]   ${finalSentence.trim()}\n[English]    ${translated}\n\n`;
        if (isRecording) setStatus(STATUS.RECORDING);
      } else {
        fullTranscript += chunk + '\n';
      }
    }

    const display = fullTranscript + (interimText ? `\n${interimText}` : '');
    transcriptEl.value = display;
    updateCounts(display);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  };

  /* ── Error handler ── */
  const errorMessages = {
    'not-allowed': 'Microphone access denied. Click the lock icon in your address bar.',
    'no-speech': 'No speech detected. Try speaking closer to your mic.',
    'network': 'Network error. Check your connection and try again.',
    'audio-capture': 'No microphone found. Please connect a mic and try again.',
    'aborted': null, // silent
  };

  recognition.onerror = (event) => {
    const message = errorMessages[event.error];
    if (message) showToast(message, 4000);
    if (event.error !== 'aborted') stopRecording();
  };

  /* ── Auto-restart if engine cuts off mid-session ── */
  recognition.onend = () => {
    if (isRecording) {
      try { recognition.start(); } catch (_) { }
    }
  };
}

/* ─────────────────────────────────
   RECORDING CONTROLS
───────────────────────────────── */
function startRecording() {
  if (!recognition) return;

  try {
    recognition.lang = langSelect.value;
    recognition.start();
    setStatus(STATUS.RECORDING);
    setRecordingUI(true);
    startClock();
  } catch (err) {
    showToast(`Mic error: ${err.message}`, 4000);
  }
}

function stopRecording() {
  if (!recognition) return;
  isRecording = false;
  recognition.stop();
  setStatus(STATUS.IDLE);
  setRecordingUI(false);
  stopClock();

  if (fullTranscript.trim()) {
    saveToHistory(fullTranscript, langSelect.value);
  }
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

/* ─────────────────────────────────
   ACTION BUTTONS
───────────────────────────────── */

/* Clear transcript */
clearBtn.addEventListener('click', () => {
  fullTranscript = '';
  transcriptEl.value = '';
  updateCounts('');
  showToast('Transcript cleared');
});

/* Copy to clipboard */
copyBtn.addEventListener('click', () => {
  const text = transcriptEl.value.trim();
  if (!text) { showToast('Nothing to copy'); return; }

  navigator.clipboard.writeText(text)
    .then(() => showToast('Copied to clipboard!'))
    .catch(() => {
      // Fallback for older browsers
      transcriptEl.select();
      document.execCommand('copy');
      showToast('Copied!');
    });
});

/* Download as .txt */
downloadBtn.addEventListener('click', () => {
  const text = transcriptEl.value.trim();
  if (!text) { showToast('Nothing to download'); return; }

  const dateStr = new Date().toISOString().slice(0, 10);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `voice-note-${dateStr}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
  showToast('Saved as .txt!');
});

/* Clear history */
clearHistoryBtn.addEventListener('click', () => {
  sessionHistory = [];
  renderHistory();
  showToast('History cleared');
});

/* Live typing updates counts */
transcriptEl.addEventListener('input', () => {
  fullTranscript = transcriptEl.value;
  updateCounts(fullTranscript);
});
/* ─────────────────────────────────
   KEYBOARD SHORTCUT — Space to record/stop
   (only fires when not focused on an input)
───────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!startBtn.disabled) startRecording();
    else if (!stopBtn.disabled) stopRecording();
  }
});
renderHistory();
updateCounts('');