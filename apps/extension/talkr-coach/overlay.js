const suggestionEl = document.getElementById('suggestion');
const stageEl = document.getElementById('stage-pill');
const metaEl = document.getElementById('meta');
const lastUttEl = document.getElementById('last-utterance');
const closeBtn = document.getElementById('close');
const actionBtns = document.querySelectorAll('.action');

let currentSuggestionId = null;
let currentSuggestionText = '';
let currentSuggestionMeta = null;

function setSuggestion(text, klass) {
  suggestionEl.className = klass || '';
  suggestionEl.textContent = text;
}

function setStage(stage) {
  stageEl.textContent = stage || 'listening';
}

function setMeta(text) {
  metaEl.textContent = text;
}

function resetActions() {
  actionBtns.forEach((b) => b.classList.remove('acknowledged'));
}

closeBtn.addEventListener('click', () => {
  // We can't actually destroy the iframe from inside it; tell parent to hide.
  parent.postMessage({ type: 'TALKR_HIDE_OVERLAY' }, '*');
});

actionBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.classList.add('acknowledged');
    const action = btn.dataset.action;
    chrome.runtime.sendMessage({
      target: 'sw',
      type: 'OVERLAY_ACTION',
      action,
      suggestion: currentSuggestionText,
    }).catch(() => {});
    // Local UX: dim other buttons too
    actionBtns.forEach((b) => { if (b !== btn) b.classList.add('acknowledged'); });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'overlay') return false;

  switch (msg.type) {
    case 'TRANSCRIPT': {
      if (msg.speaker === 'seller' && msg.text) {
        lastUttEl.textContent = `seller: "${msg.text}"`;
      }
      return false;
    }
    case 'SUGGEST_START': {
      currentSuggestionText = '';
      resetActions();
      setSuggestion('...', 'waiting');
      setMeta('');
      return false;
    }
    case 'SUGGEST_EVENT': {
      const ev = msg.event;
      if (ev.type === 'meta') {
        currentSuggestionMeta = ev;
        setStage(ev.stage);
        setMeta(`stage=${ev.stage} | TTFT ${ev.ttft_ms}ms | ${ev.winners_count}W/${ev.losers_count}L | playbook ${ev.playbook_count}`);
      } else if (ev.type === 'delta') {
        if (currentSuggestionText === '') suggestionEl.className = '';
        currentSuggestionText += ev.text;
        suggestionEl.textContent = currentSuggestionText;
        if (currentSuggestionText.trim() === 'PASS') {
          setSuggestion('(filler — no suggestion)', 'pass');
        }
      } else if (ev.type === 'done') {
        const totalMs = ev.total_ms ?? 0;
        const prevMeta = metaEl.textContent;
        if (prevMeta) setMeta(`${prevMeta} | total ${totalMs}ms`);
      } else if (ev.type === 'error') {
        setSuggestion(`error: ${ev.message}`, 'error');
      }
      return false;
    }
    case 'SUGGEST_ERROR': {
      setSuggestion(`error: ${msg.message}`, 'error');
      return false;
    }
  }
  return false;
});

setSuggestion('Waiting for the seller to speak...', 'waiting');
