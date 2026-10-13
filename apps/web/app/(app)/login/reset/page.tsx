'use client';

/**
 * Lands from the password-reset email. Supabase puts a short-lived recovery
 * access token in the URL hash; the new password is set with it through the
 * API, and the rep signs in normally afterwards.
 */

import { useEffect, useState } from 'react';
import { auth } from '@/lib/api';

const INPUT =
  'mt-1.5 w-full rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-[13px] outline-none focus:border-[var(--accent)]';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    setToken(h.get('access_token'));
    setLinkError(h.get('error_description'));
    // Keep the token out of history and screenshots.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const canSubmit = !!token && password.length >= 8 && password === confirm && !busy;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
      <img src="/logo-wordmark.png" alt="Talkr" width={118} height={36} className="self-start" style={{ height: 36, width: 'auto' }} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          setBusy(true);
          setError(null);
          auth
            .resetPassword(token!, password)
            .then(() => setDone(true))
            .catch((err: Error) => setError(err.message))
            .finally(() => setBusy(false));
        }}
        className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6"
      >
        <h1 className="text-[17px] font-bold tracking-[-0.01em]">Set a new password</h1>
        {done ? (
          <>
            <p className="mt-3 text-[13px]">Password updated. Sign in with it now.</p>
            <a
              href="/login"
              className="mt-5 flex h-10 w-full items-center justify-center rounded-[10px] bg-[var(--accent)] text-[13px] font-semibold text-white"
            >
              Go to sign in
            </a>
          </>
        ) : !token ? (
          <p className="mt-3 text-[13px] text-[var(--muted)]">
            {linkError ?? 'This link is missing its reset code or has already been used.'}{' '}
            <a href="/login" className="font-semibold text-[var(--accent)]">
              Request a new link
            </a>
          </p>
        ) : (
          <>
            <label className="mt-6 block">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                New password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={INPUT}
              />
            </label>
            <label className="mt-4 block">
              <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
                Confirm password
              </span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className={INPUT}
              />
            </label>
            <p className="mt-2 text-[11.5px] text-[var(--muted)]">
              {password && password.length < 8
                ? 'At least 8 characters.'
                : confirm && password !== confirm
                  ? "Passwords don't match."
                  : '\u00a0'}
            </p>
            <button
              type="submit"
              disabled={!canSubmit}
              className="mt-3 h-10 w-full rounded-[10px] bg-[var(--accent)] text-[13px] font-semibold text-white disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save password'}
            </button>
          </>
        )}
        {error && (
          <p role="alert" className="mt-3 text-[12.5px] font-medium text-[var(--red)]">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
