/**
 * The incoming-call ring, synthesized so there is no audio file to ship.
 *
 * The carrier SDK plays nothing for an invite (engine.ts has no ringtone
 * routing), so before this a call only "rang" if the popup happened to be
 * open. The offscreen document is created with AUDIO_PLAYBACK and outlives the
 * popup, so it is the one place a ring can play from. A North American ring:
 * 440 + 480 Hz, two seconds on, four off.
 */

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function burst(): void {
  if (!ctx || !gain) return;
  const t = ctx.currentTime;
  for (const freq of [440, 480]) {
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(t);
    osc.stop(t + 2);
  }
}

export function startRingtone(): void {
  if (timer) return;
  try {
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    void ctx.resume().catch(() => undefined);
    burst();
    timer = setInterval(burst, 6_000);
  } catch {
    stopRingtone();
  }
}

export function stopRingtone(): void {
  if (timer) clearInterval(timer);
  timer = null;
  void ctx?.close().catch(() => undefined);
  ctx = null;
  gain = null;
}
