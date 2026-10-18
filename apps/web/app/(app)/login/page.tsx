'use client';

/**
 * Account: sign in, see who you are signed in as, sign out.
 *
 * Sign-in is email + password against the rep's Talkr workspace (Supabase
 * Auth, proxied by the API), or "Continue with Google" when the server has a
 * Google client id (lib/googleSignIn, finished on /login/google). Pasting an access token stays available behind
 * "Advanced" for a developer against a local API, or a server that has not
 * enabled password sign-in — it is never the first thing a rep sees.
 *
 * Not a gate: the app is browsable without a session — nothing redirects
 * here — and every endpoint is authenticated server-side.
 */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@/components/Icon';
import {
  api,
  apiUrl,
  auth,
  getSessionUser,
  getToken,
  openAccess,
  setApiUrl,
  type MeDto,
  type SessionUser,
} from '@/lib/api';
import { PhoneText } from '@/components/CopyPhone';
import { tzAbbr } from '@/lib/time';
import { buildGoogleAuthorize, saveGoogleAttempt } from '@/lib/googleSignIn';

const INPUT =
  'mt-1.5 w-full rounded-[10px] border border-[var(--line)] bg-[var(--panel)] px-3 py-2.5 text-[13px] outline-none focus:border-[var(--accent)]';
const EYEBROW = 'block text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]';

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <LoginScreen />
    </Suspense>
  );
}

function LoginScreen() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [ready, setReady] = useState(false);
  // The server runs without sign-in (product testing): nothing to sign in to.
  const [open, setOpen] = useState(false);
  const params = useSearchParams();
  // Where the gate sent us from; only ever an in-app path.
  const next = params.get('next');
  const returnTo = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dialer';

  useEffect(() => {
    if (window.location.hash.includes('type=recovery')) {
      window.location.replace(`/login/reset${window.location.hash}`);
      return;
    }
    setUser(getSessionUser());
    if (getToken()) {
      setReady(true);
      api.getMe().then(setMe).catch(() => undefined);
      return;
    }
    // Decide before painting, so a rep on an open server never sees the
    // sign-in form flash past on the way to the account card.
    void openAccess().then((o) => {
      setOpen(o);
      setReady(true);
      if (o) api.getMe().then(setMe).catch(() => undefined);
    });
  }, []);

  if (!ready) return null;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 px-4 py-6">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
      <img src="/logo-wordmark.png" alt="Talkr" width={118} height={36} className="self-start" style={{ height: 36, width: 'auto' }} />
      {user ? (
        <AccountCard
          user={user}
          me={me}
          onSignedOut={() => {
            setUser(null);
            setMe(null);
          }}
        />
      ) : open ? (
        <OpenAccessCard me={me} />
      ) : (
        <SignInForm
          returnTo={returnTo}
          onSignedIn={(u) => {
            setUser(u);
            api.getMe().then(setMe).catch(() => undefined);
            setTimeout(() => window.location.assign(returnTo), 250);
          }}
        />
      )}
    </div>
  );
}

function SignInForm({ returnTo, onSignedIn }: { returnTo: string; onSignedIn: (u: SessionUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [forgot, setForgot] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [apiInput, setApiInput] = useState('');
  const [token, setToken] = useState('');
  const [passwordEnabled, setPasswordEnabled] = useState<boolean | null>(null);
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    setApiInput(apiUrl());
    auth
      .config()
      .then((c) => {
        setPasswordEnabled(c.password_signin);
        setGoogleClientId(c.google_signin ? c.google_client_id : null);
        if (!c.password_signin) setAdvanced(true);
      })
      .catch(() => setPasswordEnabled(true));
  }, []);

  async function run(work: () => Promise<SessionUser>) {
    setBusy(true);
    setError(null);
    try {
      onSignedIn(await work());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = email.trim().length > 3 && password.length > 0 && !busy;

  async function continueWithGoogle(clientId: string) {
    setLeaving(true);
    setError(null);
    try {
      const { url, attempt } = await buildGoogleAuthorize(clientId, window.location.origin, returnTo);
      saveGoogleAttempt(attempt);
      window.location.assign(url);
    } catch (err) {
      setLeaving(false);
      setError((err as Error).message);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void run(() => auth.signIn(email.trim(), password));
      }}
      className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6"
    >
      <div>
        <h1 className="text-[17px] font-bold tracking-[-0.01em]">Sign in</h1>
        <p className="text-[12px] text-[var(--muted)]">Your Talkr workspace</p>
      </div>

      {googleClientId && (
        <>
          <button
            type="button"
            disabled={leaving || busy}
            onClick={() => void continueWithGoogle(googleClientId)}
            className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-[10px] border border-[var(--line)] bg-[var(--panel)] text-[13px] font-semibold disabled:opacity-40"
          >
            <GoogleMark />
            {leaving ? 'Opening Google…' : 'Continue with Google'}
          </button>
          {passwordEnabled !== false && (
            <div className="mt-5 flex items-center gap-3 text-[11px] text-[var(--muted)]" aria-hidden="true">
              <span className="h-px flex-1 bg-[var(--line)]" />
              or with email
              <span className="h-px flex-1 bg-[var(--line)]" />
            </div>
          )}
        </>
      )}

      {passwordEnabled !== false && (
        <>
          <label className={googleClientId ? 'mt-4 block' : 'mt-6 block'}>
            <span className={EYEBROW}>Email</span>
            <input
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className={INPUT}
            />
          </label>
          <label className="mt-4 block">
            <span className={EYEBROW}>Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={INPUT}
            />
          </label>
          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-5 h-10 w-full rounded-[10px] bg-[var(--accent)] text-[13px] font-semibold text-white disabled:opacity-40"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button
            type="button"
            disabled={forgot === 'sending'}
            onClick={() => {
              if (!/.+@.+\..+/.test(email.trim())) {
                setError('Enter your email above, then click Forgot password.');
                return;
              }
              setError(null);
              setForgot('sending');
              auth
                .recover(email.trim())
                .then(() => setForgot('sent'))
                .catch((err: Error) => {
                  setForgot('idle');
                  setError(err.message);
                });
            }}
            className="mt-3 block text-[12px] font-semibold text-[var(--accent)] disabled:opacity-40"
          >
            {forgot === 'sending' ? 'Sending…' : 'Forgot password?'}
          </button>
          {forgot === 'sent' && (
            <p className="mt-2 text-[12.5px] text-[var(--muted)]">
              If {email.trim()} has a Talkr account, a reset link is on its way. Check your inbox.
            </p>
          )}
        </>
      )}

      {passwordEnabled === false && (
        <p className="mt-5 text-[13px] text-[var(--muted)]">
          This server signs reps in with an access token. Paste the one your admin gave you.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 text-[12.5px] font-medium text-[var(--red)]">
          {error}
        </p>
      )}

      <div className="mt-6">
        {passwordEnabled !== false && (
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[var(--muted)]"
          >
            <Icon name="settings" size={12} />
            {advanced ? 'Hide advanced' : 'Advanced'}
          </button>
        )}
        {advanced && (
          <div className="mt-3 rounded-[10px] border border-[var(--line)] bg-[var(--bg)] p-3">
            <label className="block">
              <span className={EYEBROW}>API URL</span>
              <input
                value={apiInput}
                onChange={(e) => setApiInput(e.target.value)}
                onBlur={() => setApiUrl(apiInput.trim().replace(/\/$/, ''))}
                spellCheck={false}
                className={INPUT}
              />
            </label>
            <label className="mt-3 block">
              <span className={EYEBROW}>Access token</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJhbGciOi…"
                className={INPUT}
              />
            </label>
            <button
              type="button"
              disabled={!token.trim() || busy}
              onClick={() =>
                void run(async () => {
                  setApiUrl(apiInput.trim().replace(/\/$/, ''));
                  return auth.signInWithToken(token.trim());
                })
              }
              className="mt-3 h-9 w-full rounded-[10px] border border-[var(--line)] bg-[var(--panel)] text-[12.5px] font-semibold disabled:opacity-40"
            >
              Use this token
            </button>
          </div>
        )}
      </div>
    </form>
  );
}

/** Google's "G", as its brand guidelines ask for on a sign-in button. */
function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 border-b border-[var(--line-soft)] py-2.5 text-[13px]">
      <span className="w-28 shrink-0 text-[var(--muted)]">{label}</span>
      <span className="ml-auto text-right font-medium">{children}</span>
    </div>
  );
}

/** What the account screen shows while the server runs without sign-in. */
function OpenAccessCard({ me }: { me: MeDto | null }) {
  const [apiInput, setApiInput] = useState('');
  useEffect(() => setApiInput(apiUrl()), []);
  // Repointing at another server is a different session entirely, so reload
  // rather than reconcile every cached answer about the old one.
  const commitApiUrl = () => {
    const next = apiInput.trim().replace(/\/$/, '');
    if (!next || next === apiUrl()) return;
    setApiUrl(next);
    window.location.reload();
  };
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
      <h1 className="text-[17px] font-bold tracking-[-0.01em]">Sign-in is off</h1>
      <p className="mt-2 text-[13px] text-[var(--muted)]">
        This server is in product-testing mode: every request runs as the user below, no password
        needed. Unset <code>AUTH_BYPASS_USER_EMAIL</code> on the server to turn sign-in back on.
      </p>

      <div className="mt-5">
        <span className={EYEBROW}>Acting as</span>
        <div className="mt-1">
          <Row label="Name">{me?.display_name ?? '—'}</Row>
          <Row label="Email">{me?.email ?? '—'}</Row>
          <Row label="Organization">{me?.org?.name ?? '—'}</Row>
          <Row label="Role">
            <span className="capitalize">{me?.role ?? '—'}</span>
          </Row>
        </div>
      </div>

      <label className="mt-5 block">
        <span className={EYEBROW}>API URL</span>
        <input
          value={apiInput}
          onChange={(e) => setApiInput(e.target.value)}
          onBlur={commitApiUrl}
          onKeyDown={(e) => e.key === 'Enter' && commitApiUrl()}
          spellCheck={false}
          className={INPUT}
        />
      </label>
    </div>
  );
}

function AccountCard({
  user,
  me,
  onSignedOut,
}: {
  user: SessionUser;
  me: MeDto | null;
  onSignedOut: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const name = user.display_name ?? user.email ?? 'Signed in';
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  const number = me?.numbers?.[0] ?? null;

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6">
      <div className="flex items-center gap-3.5">
        <span
          className="inline-flex h-12 w-12 items-center justify-center rounded-full text-white"
          style={{ background: 'var(--dark-2)', font: '600 16px/1 Inter' }}
        >
          {initials}
        </span>
        <div className="min-w-0">
          <div className="truncate text-[17px] font-bold tracking-[-0.01em]">{name}</div>
          <div className="truncate text-[12.5px] text-[var(--muted)]">{user.email ?? '—'}</div>
        </div>
      </div>

      <div className="mt-6">
        <span className={EYEBROW}>Workspace</span>
        <div className="mt-1">
          <Row label="Organization">{user.org?.name ?? '—'}</Row>
          <Row label="Role">
            <span className="capitalize">{user.role ?? '—'}</span>
          </Row>
          <Row label="Your number">
            {number ? (
              <span className="inline-flex items-center gap-1.5">
                <PhoneText e164={number.phone_e164} size={20} />
                {number.label ? <span className="text-[var(--muted)]">· {number.label}</span> : null}
              </span>
            ) : (
              <span className="text-[var(--muted)]">No number assigned</span>
            )}
          </Row>
          <Row label="Local zone">
            {me?.timezone ? (
              <>
                {me.city ? `${me.city} · ` : ''}
                {tzAbbr(me.timezone)}
              </>
            ) : (
              <span className="text-[var(--muted)]">Set under Settings</span>
            )}
          </Row>
        </div>
      </div>

      <div className="mt-5">
        <span className={EYEBROW}>Connection</span>
        <div className="mt-1">
          <Row label="API">
            <span className="break-all text-[12px] text-[var(--muted)]">{apiUrl()}</span>
          </Row>
        </div>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void auth.signOut().finally(() => {
            setBusy(false);
            onSignedOut();
          });
        }}
        className="mt-6 h-9 w-full rounded-[10px] border border-[var(--line)] text-[12.5px] font-semibold text-[var(--red)] disabled:opacity-40"
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
