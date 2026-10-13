/**
 * Fixed-window per-key rate limiting for the public API (docs/public-api.md §3).
 *
 * In-memory by design for v1: one Map per process, keyed by api key id.
 * DOCUMENTED LIMITATION: multi-instance deployments enforce the limit per
 * process (effective limit = instances × limit). The interface below is the
 * swap point — a Postgres- or Redis-backed implementation replaces this class
 * without touching any caller.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Seconds until the current window resets (ceil; ≥ 1 when denied). */
  retryAfterSeconds: number;
  remaining: number;
}

export interface ApiRateLimiter {
  check(key: string, nowMs?: number): RateLimitDecision;
}

interface WindowState {
  windowStart: number;
  count: number;
}

export class FixedWindowRateLimiter implements ApiRateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(key: string, nowMs = Date.now()): RateLimitDecision {
    let state = this.windows.get(key);
    if (!state || nowMs - state.windowStart >= this.windowMs) {
      state = { windowStart: nowMs, count: 0 };
      this.windows.set(key, state);
      // Opportunistic sweep keeps the map from growing unboundedly.
      if (this.windows.size > 10_000) this.sweep(nowMs);
    }
    state.count += 1;
    const resetInMs = state.windowStart + this.windowMs - nowMs;
    return {
      allowed: state.count <= this.limit,
      retryAfterSeconds: Math.max(1, Math.ceil(resetInMs / 1000)),
      remaining: Math.max(0, this.limit - state.count),
    };
  }

  private sweep(nowMs: number): void {
    for (const [key, state] of this.windows) {
      if (nowMs - state.windowStart >= this.windowMs) this.windows.delete(key);
    }
  }
}
