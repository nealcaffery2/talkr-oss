const SETTINGS_KEY = 'talkrSettings';

const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusEl = document.getElementById('status');
const timerEl = document.getElementById('timer');
const apiBaseInput = document.getElementById('api-base');
const apiKeyInput = document.getElementById('api-key');
const agentIdInput = document.getElementById('agent-id');
const saveBtn = document.getElementById('save-settings');
const settingsBlock = document.getElementById('settings-block');

let timerInterval = null;
let startedAt = null;

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#fca5a5' : '';
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

function showRecording(state) {
  startBtn.style.display = 'none';
  stopBtn.style.display = 'block';
  startedAt = state.startedAt;
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    timerEl.textContent = fmt(Date.now() - startedAt);
  }, 250);
  setStatus(state.micGranted ? 'Recording tab + mic. Suggestions in overlay.' : 'Recording tab only (mic denied).');
}
function showIdle() {
  startBtn.style.display = 'block';
  stopBtn.style.display = 'none';
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  startedAt = null;
  timerEl.textContent = '';
}

async function loadSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  const s = got[SETTINGS_KEY] || {};
  apiBaseInput.value = s.apiBase || '';
  apiKeyInput.value = s.apiKey || '';
  agentIdInput.value = s.agentId || '';
  if (!s.apiBase || !s.apiKey || !s.agentId) {
    settingsBlock.open = true;
    setStatus('Fill in settings then Save.');
    startBtn.disabled = true;
  } else {
    startBtn.disabled = false;
  }
}

saveBtn.addEventListener('click', async () => {
  const settings = {
    apiBase: apiBaseInput.value.trim().replace(/\/$/, ''),
    apiKey: apiKeyInput.value.trim(),
    agentId: agentIdInput.value.trim(),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  setStatus('Saved.');
  startBtn.disabled = !(settings.apiBase && settings.apiKey && settings.agentId);
});

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  setStatus('Requesting mic permission...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    setStatus(`Mic blocked (${err?.name || err}). Recording tab only.`);
  }
  setStatus('Starting session...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab.', true);
    startBtn.disabled = false;
    return;
  }
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'POPUP_START', tabId: tab.id });
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
  showRecording({ startedAt: Date.now(), micGranted: reply.mic });
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  setStatus('Stopping...');
  const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'POPUP_STOP' });
  stopBtn.disabled = false;
  if (!reply?.ok) {
    setStatus(`Stop failed: ${reply?.error || 'unknown'}`, true);
    return;
  }
  setStatus('Stopped.');
  showIdle();
});

async function init() {
  await loadSettings();
  showIdle();
  const reply = await chrome.runtime.sendMessage({ target: 'sw', type: 'POPUP_GET_STATE' }).catch(() => null);
  if (reply?.ok && reply.state?.status === 'recording') {
    showRecording(reply.state);
  }
}

init();
