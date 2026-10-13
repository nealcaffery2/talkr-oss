import { pino, type Logger } from 'pino';

/**
 * Structured JSON logs with central redaction (docs/security.md §7).
 * Phone numbers in dedicated fields are masked by callers via maskPhone();
 * these paths catch credentials that must never appear in logs at all.
 */
export function createLogger(level = 'info'): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'headers.authorization',
        'token',
        '*.token',
        '*.authToken',
        '*.apiKeySecret',
        'password',
        // Phase 10: public API keys + webhook signing secrets never hit logs.
        'secret',
        '*.secret',
        '*.signingSecret',
        '*.signing_secret',
      ],
      censor: '[redacted]',
    },
  });
}

export type { Logger };
