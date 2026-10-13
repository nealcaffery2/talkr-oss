// Talkr Coach offscreen document.
//
// Owns: tab MediaStream + mic MediaStream + Deepgram WebSocket + suggest SSE.
//
// Flow per session:
//   1. getUserMedia(tab) for seller channel
//   2. getUserMedia(mic) for agent channel
//   3. Wire both into AudioContext, downsample to 16kHz mono per channel,
//      pack as multichannel PCM frames, push to Deepgram WebSocket.
//   4. On every Deepgram speech_final transcript from channel 0 (seller):
//      a. Cancel any in-flight /api/suggest call.
//      b. Fire a new POST /api/suggest with the utterance + last 4 turns.
//      c. Stream SSE deltas back, forward to overlay via runtime.sendMessage.
//   5. Maintain rolling last-4-turns buffer for stage detection + context.

const SAMPLE_RATE = 16000;

let session = null;

class StreamingPCMSource {
  constructor(label, mediaStream, channelIndex, onFrame) {
    this.label = label;
    this.mediaStream = mediaStream;
    this.channelIndex = channelIndex;
    this.onFrame = onFrame;
    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.source = this.audioCtx.createMediaStreamSource(mediaStream);
    this.processor = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.processor.onaudioprocess = (e) => {
      const f32 = e.inputBuffer.getChannelData(0);
      this.onFrame(channelIndex, f32);
    };
    this.source.connect(this.processor);
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
  }
}

// Two-channel PCM packer. Holds the latest frame per channel and emits
// interleaved Int16 frames sized to the smaller of the two buffers.
class TwoChannelPCMPacker {
  constructor(onPCM) {
    this.onPCM = onPCM;
    this.buffers = [[], []];          // queues of Float32Arrays per channel
  }
  push(channelIdx, f32) {
    this.buffers[channelIdx].push(f32);
    this.flush();
  }
  flush() {
    while (this.buffers[0].length > 0 && this.buffers[1].length > 0) {
      const a = this.buffers[0].shift();
      const b = this.buffers[1].shift();
      const n = Math.min(a.length, b.length);
      const interleaved = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) {
        let sa = Math.max(-1, Math.min(1, a[i]));
        let sb = Math.max(-1, Math.min(1, b[i]));
        interleaved[2 * i] = sa < 0 ? sa * 0x8000 : sa * 0x7fff;
        interleaved[2 * i + 1] = sb < 0 ? sb * 0x8000 : sb * 0x7fff;
      }
      this.onPCM(interleaved.buffer);
      // If one channel buffer was longer, retain the tail
      if (a.length > n) this.buffers[0].unshift(a.subarray(n));
      if (b.length > n) this.buffers[1].unshift(b.subarray(n));
    }
  }
}

class DeepgramStream {
  constructor(deepgramKey, onTranscript) {
    const url = new URL('wss://api.deepgram.com/v1/listen');
    url.searchParams.set('model', 'nova-3');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(SAMPLE_RATE));
    url.searchParams.set('channels', '2');
    url.searchParams.set('multichannel', 'true');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('endpointing', '200');
    url.searchParams.set('utterance_end_ms', '800');
    url.searchParams.set('vad_events', 'true');
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('smart_format', 'true');
    this.ws = new WebSocket(url.toString(), ['token', deepgramKey]);
    this.onTranscript = onTranscript;
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('Deepgram WS error')));
    });
    this.ws.addEventListener('message', (e) => this.handleMessage(e));
    this.ws.addEventListener('close', () => console.log('[talkr] Deepgram WS closed'));
  }
  handleMessage(e) {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'Results') return;
    const channelIdx = msg.channel_index?.[0] ?? 0;
    const speaker = channelIdx === 0 ? 'seller' : 'agent';
    const alt = msg.channel?.alternatives?.[0];
    if (!alt) return;
    const text = (alt.transcript || '').trim();
    if (!text) return;
    this.onTranscript({
      speaker,
      text,
      isFinal: !!msg.is_final,
      speechFinal: !!msg.speech_final,
    });
  }
  send(data) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }
  close() {
    try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {}
    try { this.ws.close(); } catch {}
  }
}

class TalkrSession {
  constructor(opts) {
    this.opts = opts;
    this.turns = [];                  // rolling [{ speaker, text }]
    this.startedAt = Date.now();
    this.lastSuggestController = null;
    this.previousStage = null;
  }

  async start() {
    // Tab audio (seller leg)
    const tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: this.opts.streamId,
        },
      },
      video: false,
    });
    // Re-route tab audio so user still hears the call
    this.passthroughCtx = new AudioContext();
    this.passthroughCtx.createMediaStreamSource(tabStream).connect(this.passthroughCtx.destination);

    // Mic audio (agent leg)
    let micStream = null;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    } catch (err) {
      console.warn('[talkr] mic capture failed; continuing with tab only:', err);
    }
    this.micGranted = !!micStream;

    // Open Deepgram WebSocket
    this.dg = new DeepgramStream(this.opts.deepgramKey, (t) => this.onTranscript(t));
    await this.dg.ready;

    // Set up packer that writes to Deepgram on each pair of channel frames
    const packer = new TwoChannelPCMPacker((pcm) => this.dg.send(pcm));
    this.tabSource = new StreamingPCMSource('tab', tabStream, 0, (idx, f32) => packer.push(idx, f32));
    if (micStream) {
      this.micSource = new StreamingPCMSource('mic', micStream, 1, (idx, f32) => packer.push(idx, f32));
    } else {
      // No mic: pump silence into channel 1 so the packer still emits frames
      const silenceCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
      const buf = silenceCtx.createBuffer(1, SAMPLE_RATE, SAMPLE_RATE);
      const node = silenceCtx.createBufferSource();
      node.buffer = buf;
      node.loop = true;
      const proc = silenceCtx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (e) => packer.push(1, e.inputBuffer.getChannelData(0));
      node.connect(proc);
      const muted = silenceCtx.createGain(); muted.gain.value = 0;
      proc.connect(muted); muted.connect(silenceCtx.destination);
      node.start();
      this.silenceCtx = silenceCtx;
    }
  }

  onTranscript({ speaker, text, isFinal, speechFinal }) {
    // Forward partial transcripts to overlay so the user sees what's being heard.
    chrome.runtime.sendMessage({
      target: 'overlay',
      type: 'TRANSCRIPT',
      speaker,
      text,
      isFinal,
      speechFinal,
    }).catch(() => {});

    // Only fire suggestions on speech_final from the seller
    if (!speechFinal || speaker !== 'seller') return;

    // Append to rolling turn buffer
    this.turns.push({ speaker, text });
    if (this.turns.length > 8) this.turns = this.turns.slice(-8);

    this.fireSuggest(text);
  }

  async fireSuggest(utterance) {
    // Cancel in-flight suggestion if any
    if (this.lastSuggestController) {
      this.lastSuggestController.abort();
    }
    const ctrl = new AbortController();
    this.lastSuggestController = ctrl;

    const elapsed = Math.round((Date.now() - this.startedAt) / 1000);

    let res;
    try {
      res = await fetch(`${this.opts.apiBase}/api/suggest`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          session_id: this.opts.sessionId,
          utterance,
          last_4_turns: this.turns.slice(-4),
          elapsed_seconds: elapsed,
          previous_stage: this.previousStage,
        }),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (err?.name !== 'AbortError') {
        console.warn('[talkr] suggest fetch failed:', err);
      }
      return;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      chrome.runtime.sendMessage({ target: 'overlay', type: 'SUGGEST_ERROR', message: `${res.status}: ${body}` }).catch(() => {});
      return;
    }

    chrome.runtime.sendMessage({ target: 'overlay', type: 'SUGGEST_START' }).catch(() => {});

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = event.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          if (data.type === 'meta' && data.stage) this.previousStage = data.stage;
          chrome.runtime.sendMessage({ target: 'overlay', type: 'SUGGEST_EVENT', event: data }).catch(() => {});
        } catch {}
      }
    }
  }

  async stop() {
    if (this.lastSuggestController) this.lastSuggestController.abort();
    if (this.dg) this.dg.close();
    if (this.tabSource) await this.tabSource.stop();
    if (this.micSource) await this.micSource.stop();
    if (this.silenceCtx) await this.silenceCtx.close().catch(() => {});
    if (this.passthroughCtx) await this.passthroughCtx.close().catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;

  if (msg.type === 'PING') { sendResponse({ ok: true }); return true; }

  if (msg.type === 'START_SESSION') {
    if (session) {
      sendResponse({ ok: false, error: 'session already active' });
      return true;
    }
    session = new TalkrSession(msg);
    session.start()
      .then(() => sendResponse({ ok: true, mic: session.micGranted }))
      .catch((err) => {
        sendResponse({ ok: false, error: String(err?.message || err) });
        session = null;
      });
    return true;
  }

  if (msg.type === 'STOP_SESSION') {
    if (!session) { sendResponse({ ok: true, note: 'no active session' }); return true; }
    const s = session;
    session = null;
    s.stop().then(() => sendResponse({ ok: true })).catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});
