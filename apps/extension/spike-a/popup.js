const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const status = document.getElementById('status');
const timer = document.getElementById('timer');
const micState = document.getElementById('mic-state');

let timerInterval = null;
let sessionStartedAt = null;

function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.style.color = isError ? '#fca5a5' : '';
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function showTimer(startedAt) {
  sessionStartedAt = startedAt;
  timer.textContent = fmtElapsed(Date.now() - startedAt);
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timer.textContent = fmtElapsed(Date.now() - sessionStartedAt);
  }, 250);
}

function hideTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  sessionStartedAt = null;
  timer.textContent = '';
}

function showRecordingUI(state) {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  stopBtn.disabled = false;
  micState.textContent = state.micGranted ? 'mic: granted' : 'mic: NOT granted';
  micState.style.color = state.micGranted ? '#86efac' : '#fca5a5';
  showTimer(state.startedAt);
  setStatus(state.micGranted
    ? 'Recording tab + mic. Talk normally.'
    : 'Recording tab only (mic was denied or unavailable).');
}

function showIdleUI() {
  startBtn.style.display = 'block';
  startBtn.disabled = false;
  stopBtn.style.display = 'none';
  micState.textContent = '';
  hideTimer();
}

// On popup load, ask the service worker if a session is already in progress.
// This is what fixes the "timer kept going / stop didn't work" bug from v0.1:
// the popup is ephemeral, so all state lives in chrome.storage.session.
async function init() {
  showIdleUI();
  setStatus('Ready.');
  try {
    const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'POPUP_GET_STATE' });
    if (reply?.ok && reply.state?.status === 'recording') {
      showRecordingUI(reply.state);
    }
  } catch (err) {
    setStatus(`Init failed: ${err?.message || err}`, true);
  }
}

// Pre-warm mic permission from the popup's user-gesture context.
// Once granted to the extension origin, the offscreen document inherits it.
async function prewarmMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.name || String(err) };
  }
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('Requesting mic permission...');

  const mic = await prewarmMic();
  if (!mic.ok) {
    setStatus(`Mic blocked (${mic.error}). Recording tab only.`);
    micState.textContent = 'mic: NOT granted';
    micState.style.color = '#fca5a5';
  } else {
    setStatus('Mic granted. Starting capture...');
    micState.textContent = 'mic: granted';
    micState.style.color = '#86efac';
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab.', true);
    startBtn.disabled = false;
    return;
  }

  let reply;
  try {
    reply = await chrome.runtime.sendMessage({
      target: 'sw',
      type: 'POPUP_START',
      tabId: tab.id,
    });
  } catch (err) {
    setStatus(`Start failed: ${err?.message || err}`, true);
    startBtn.disabled = false;
    return;
  }

  if (!reply?.ok) {
    setStatus(`Failed: ${reply?.error || 'unknown'}`, true);
    startBtn.disabled = false;
    return;
  }

  showRecordingUI({
    startedAt: Date.now(),
    micGranted: !!reply.mic,
  });
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  setStatus('Encoding WAV files...');
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'POPUP_STOP' });
  } catch (err) {
    setStatus(`Stop failed: ${err?.message || err}`, true);
    stopBtn.disabled = false;
    return;
  }
  hideTimer();
  if (!reply?.ok) {
    setStatus(`Failed: ${reply?.error || 'unknown'}`, true);
    stopBtn.disabled = false;
    return;
  }
  const tabKB = Math.round(reply.tabBytes / 1024);
  const micKB = Math.round(reply.micBytes / 1024);
  const durSec = Math.round(reply.durationMs / 1000);
  setStatus(`Saved (${durSec}s). tab=${tabKB}KB mic=${micKB}KB. Check Downloads.`);
  showIdleUI();
  setStatus(`Saved (${durSec}s). tab=${tabKB}KB mic=${micKB}KB. Check Downloads.`);
});

init();
