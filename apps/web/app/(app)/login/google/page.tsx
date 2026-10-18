'use client';

/**
 * Where Google sends the browser back after "Continue with Google" on /login.
 * The id_token is on the URL fragment; it is checked against the attempt this
 * tab started (lib/googleSignIn), traded with the API for a session, and the
 * rep lands where they were headed. Register this path, on every origin the
 * web app is served from, as an Authorized redirect URI on the Google client.
 */

import { useEffect, useRef, useState } from 'react';
import { auth } from '@/lib/api';
import { readGoogleCallback, takeGoogleAttempt } from '@/lib/googleSignIn';

export default function GoogleCallbackPage() {
  const [error, setError] = useState<string | null>(null);
  // Strict mode runs effects twice in development; the attempt is single use.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const result = readGoogleCallback(window.location.href, takeGoogleAttempt());
    // Keep the token out of history and screenshots.
    window.history.replaceState(null, '', window.location.pathname);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    auth
      .signInWithGoogle(result.idToken, result.nonce)
      .then(() => window.location.replace(result.returnTo))
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
      <img src="/logo-wordmark.png" alt="Talkr" width={118} height={36} className="self-start" style={{ height: 36, width: 'auto' }} />
      <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
        <h1 className="text-[17px] font-bold tracking-[-0.01em]">
          {error ? "Couldn't sign in with Google" : 'Signing you in…'}
        </h1>
        {error ? (
          <>
            <p role="alert" className="mt-3 text-[13px] text-[var(--red)]">
              {error}
            </p>
            <a
              href="/login"
              className="mt-5 flex h-10 w-full items-center justify-center rounded-[10px] bg-[var(--accent)] text-[13px] font-semibold text-white"
            >
              Back to sign in
            </a>
          </>
        ) : (
          <p className="mt-3 text-[13px] text-[var(--muted)]">Checking your Google account with Talkr.</p>
        )}
      </div>
    </div>
  );
}
