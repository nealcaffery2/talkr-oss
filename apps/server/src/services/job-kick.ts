/**
 * Run one queued job now, in the request that queued it.
 *
 * On the serverless deployment the worker is a once-a-minute tick
 * (serverless.ts), so a text a rep sent sat in the queue for up to a minute,
 * thirty seconds on average, before the carrier saw it. The serverless boot
 * registers a kicker here; the send route calls kickJob right after queueing,
 * and the tick still picks up anything a kick did not finish. With a
 * long-running worker nothing is registered and kickJob does nothing: that
 * worker polls every half second.
 */

type Kicker = (dedupeKey: string) => Promise<unknown>;

let kicker: Kicker | null = null;

export function setJobKicker(fn: Kicker | null): void {
  kicker = fn;
}

/** Run the job with this dedupe key, waiting at most `timeoutMs`. Never throws. */
export async function kickJob(dedupeKey: string, timeoutMs = 8_000): Promise<void> {
  if (!kicker) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kicker(dedupeKey),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } catch {
    // The tick retries it.
  } finally {
    if (timer) clearTimeout(timer);
  }
}
