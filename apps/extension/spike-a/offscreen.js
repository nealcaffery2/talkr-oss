// Spike A offscreen document.
// Captures the active tab's audio AND the system microphone in parallel,
// records both for the duration of the session, then encodes each as a
// 16 kHz mono WAV and triggers a download. The user listens to both files
// to determine: does tab audio contain the seller only, or both call legs?

const SAMPLE_RATE = 16000;

let session = null;

class Recorder {
  constructor(label, mediaStream) {
    this.label = label;
    this.mediaStream = mediaStream;
    this.chunks = [];
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.source = this.audioCtx.createMediaStreamSource(mediaStream);
    // ScriptProcessorNode is deprecated but ships and works in Chrome.
    // Production code will use AudioWorklet; spike is fine as-is.
    this.processor = this.audioCtx.createScriptProcessor(4096, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      // Copy because the buffer is reused by the audio thread.
      this.chunks.push(new Float32Array(input));
    };
    this.source.connect(this.processor);
    // Connect through a muted gain so the processor pulls samples without
    // routing audio to speakers (avoids feedback for tab capture).
    const muted = this.audioCtx.createGain();
    muted.gain.value = 0;
    this.processor.connect(muted);
    muted.connect(this.audioCtx.destination);
  }

  async stop() {
    try {
      this.processor.disconnect();
      this.source.disconnect();
    } catch {}
    this.mediaStream.getTracks().forEach((t) => t.stop());
    await this.audioCtx.close().catch(() => {});

    const totalSamples = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Float32Array(totalSamples);
    let offset = 0;
    for (const c of this.chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    return encodeWav(merged, SAMPLE_RATE);
  }
}

function encodeWav(float32, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = float32.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, 'WAVE');
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeStr(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, s, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeStr(view, offset, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

async function startCapture(streamId) {
  if (session) throw new Error('Already capturing.');

  // 1. Tab audio. This is the call's remote leg (seller) playing through the tab.
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    throw new Error(`Tab capture failed: ${err?.message || err}`);
  }

  // 2. Re-route tab audio back to speakers so the user hears the call normally.
  // Without this, tabCapture silences the tab.
  const passthroughCtx = new AudioContext();
  passthroughCtx
    .createMediaStreamSource(tabStream)
    .connect(passthroughCtx.destination);

  // 3. Microphone (the agent's voice). Request raw audio (no echoCancel/AGC)
  // so we can verify what's actually on the wire.
  let micStream = null;
  let micError = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (err) {
    micError = err?.name === 'NotAllowedError'
      ? 'mic permission denied'
      : `mic error: ${err?.message || err?.name || err}`;
    console.warn('[spike-a]', micError);
  }

  session = {
    startedAt: Date.now(),
    passthroughCtx,
    tab: new Recorder('tab', tabStream),
    mic: micStream ? new Recorder('mic', micStream) : null,
    micError,
  };
  return { ok: true, mic: !!micStream, micError };
}

async function stopCapture() {
  if (!session) throw new Error('Not capturing.');
  const { passthroughCtx, tab, mic, startedAt } = session;
  session = null;

  await passthroughCtx.close().catch(() => {});
  let tabBlob, micBlob;
  try {
    tabBlob = await tab.stop();
  } catch (err) {
    throw new Error(`Tab encoder failed: ${err?.message || err}`);
  }
  if (mic) {
    try {
      micBlob = await mic.stop();
    } catch (err) {
      console.warn('[spike-a] mic encoder failed:', err);
    }
  }

  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-');
  const downloads = [];
  downloads.push(triggerDownload(tabBlob, `talkr-spike-tab-${stamp}.wav`));
  if (micBlob) downloads.push(triggerDownload(micBlob, `talkr-spike-mic-${stamp}.wav`));
  await Promise.all(downloads);

  return {
    durationMs: Date.now() - startedAt,
    tabBytes: tabBlob.size,
    micBytes: micBlob?.size ?? 0,
  };
}

function triggerDownload(blob, filename) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      chrome.downloads.download(
        { url: reader.result, filename, saveAs: false },
        (id) => (chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(id))
      );
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.streamId)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === 'STOP_CAPTURE') {
    stopCapture()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});
