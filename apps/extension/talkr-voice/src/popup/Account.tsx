/**
 * Sign-in and account screens for the popup.
 *
 * Sign-in is email + password against the rep's Talkr workspace. Pasting an
 * access token is kept behind "Advanced" for two real cases — a developer
 * against a local API, and a server that has not enabled password sign-in —
 * and is never the first thing a rep sees.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from '@/shared/Icon';
import { Avatar, Button, Eyebrow, StatusMarker } from '@/shared/ui';
import { ApiError, auth, type MeDto } from '@/shared/api';
import { session as sessionStore, type Session } from '@/shared/session';
import type { CallSnapshot } from '@/shared/messages';
import { formatPhone, tzAbbr } from '@/shared/time';

const INPUT: CSSProperties = {
  width: '100%',
  border: '1px solid var(--line)',
  borderRadius: 10,
  padding: '10px 12px',
  font: '500 13px/1.2 Inter',
  background: 'var(--panel)',
  color: 'var(--text)',
  outline: 'none',
};

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <Eyebrow>{label}</Eyebrow>
      {children}
    </label>
  );
}

function Brand({ subtitle }: { subtitle: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <img src="icons/48.png" alt="" width={34} height={34} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ font: '700 15px/1 Inter', letterSpacing: '-0.01em' }}>Talkr</div>
        <div style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>{subtitle}</div>
      </div>
    </div>
  );
}

/** Google's mark, drawn inline: MV3 forbids remote code, and that includes theirs. */
function GoogleMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5.1-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.3z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.5-3.8-12.2-9H4.5v5.7C8.1 41.3 15.5 46 24 46z" />
      <path fill="#FBBC05" d="M11.8 28.4c-.4-1.3-.7-2.7-.7-4.4s.3-3.1.7-4.4v-5.7H4.5A22 22 0 0 0 2 24c0 3.6.9 6.9 2.5 9.9l7.3-5.5z" />
      <path fill="#EA4335" d="M24 10.6c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4 29.9 2 24 2 15.5 2 8.1 6.7 4.5 13.9l7.3 5.7c1.7-5.2 6.5-9 12.2-9z" />
    </svg>
  );
}

/** "or" with a rule either side, so the two ways in read as alternatives. */
function OrDivider() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
      <span style={{ font: '600 10px/1 Inter', color: 'var(--muted-2)' }}>OR</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
    </div>
  );
}

export function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [apiUrl, setApiUrl] = useState('');
  const [token, setToken] = useState('');
  /** null until the server says which methods it offers. */
  const [passwordEnabled, setPasswordEnabled] = useState<boolean | null>(null);
  /** Non-null only when the server has Google configured. */
  const [googleClientId, setGoogleClientId] = useState<string | null>(null);

  useEffect(() => {
    void sessionStore.apiUrl().then(setApiUrl);
    auth
      .config()
      .then((c) => {
        setPasswordEnabled(c.password_signin);
        setGoogleClientId(c.google_signin ? c.google_client_id : null);
        if (!c.password_signin && !c.google_signin) setAdvanced(true);
      })
      // Unreachable server: show the full form, the error will explain itself
      // when they press the button.
      .catch(() => setPasswordEnabled(true));
  }, []);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = email.trim().length > 3 && password.length > 0 && !busy;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void run(() => auth.signIn(email.trim(), password));
      }}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        height: '100%',
        padding: '22px 20px 18px',
        background: 'var(--panel)',
        overflowY: 'auto',
      }}
    >
      <Brand subtitle="Sign in to your Talkr workspace" />

      {/*
        The quickest way in is not this form. A rep with CLOZR open is already
        signed in to the same workspace, and the bridge hands that session over
        — so say so before they go looking for a second password.
      */}
      <div
        style={{
          display: 'flex',
          gap: 9,
          alignItems: 'flex-start',
          padding: '10px 12px',
          borderRadius: 10,
          background: 'var(--panel-2)',
          border: '1px solid var(--line-soft)',
        }}
      >
        <span style={{ color: 'var(--accent)', display: 'inline-flex', paddingTop: 1 }}>
          <Icon name="check" size={13} />
        </span>
        <p style={{ font: '500 11.5px/1.45 Inter', color: 'var(--muted)', margin: 0 }}>
          Already in CLOZR? Open a CLOZR tab and Talkr signs itself in with the same account.
        </p>
      </div>

      {googleClientId && (
        <>
          <Button
            tone="ghost"
            disabled={busy}
            onClick={() => void run(() => auth.signInWithGoogle(googleClientId))}
            style={{ height: 40, gap: 9 }}
          >
            <GoogleMark />
            Continue with Google
          </Button>
          {passwordEnabled !== false && <OrDivider />}
        </>
      )}

      {passwordEnabled !== false && (
        <>
          <Field label="Email">
            <input
              type="email"
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={INPUT}
            />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={INPUT}
            />
          </Field>
          <Button type="submit" tone="accent" disabled={!canSubmit} style={{ height: 40 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <a
            href="https://talkr.example.com/login"
            target="_blank"
            rel="noreferrer"
            style={{ font: '600 12px/1 Inter', color: 'var(--accent)', textDecoration: 'none' }}
          >
            Forgot password?
          </a>
        </>
      )}

      {passwordEnabled === false && (
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)', margin: 0 }}>
          This server signs reps in with an access token. Paste the one your admin gave you.
        </p>
      )}

      {error && (
        <p role="alert" style={{ font: '500 12px/1.45 Inter', color: 'var(--red)', margin: 0 }}>
          {error}
        </p>
      )}

      <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {passwordEnabled !== false && (
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              border: 0,
              background: 'transparent',
              padding: 0,
              font: '600 11px/1 Inter',
              color: 'var(--muted)',
            }}
          >
            <Icon name="settings" size={12} />
            {advanced ? 'Hide advanced' : 'Advanced'}
          </button>
        )}
        {advanced && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'var(--bg)',
            }}
          >
            <Field label="API URL">
              <input
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                onBlur={() => void sessionStore.setApiUrl(apiUrl.trim())}
                spellCheck={false}
                style={INPUT}
              />
            </Field>
            <Field label="Access token">
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="eyJhbGciOi…"
                style={INPUT}
              />
            </Field>
            <Button
              tone="ghost"
              disabled={!token.trim() || busy}
              onClick={() =>
                void run(async () => {
                  await sessionStore.setApiUrl(apiUrl.trim());
                  await auth.signInWithToken(token.trim());
                })
              }
            >
              Use this token
            </Button>
            <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)', margin: 0 }}>
              The API origin must also be listed in the extension&apos;s host permissions.
            </p>
          </div>
        )}
      </div>
    </form>
  );
}

const DEVICE_LABEL: Record<CallSnapshot['device'], { label: string; color: string }> = {
  ready: { label: 'Ready', color: 'var(--green)' },
  initializing: { label: 'Connecting', color: 'var(--amber)' },
  uninitialized: { label: 'Not enabled', color: 'var(--muted-2)' },
  error: { label: 'Error', color: 'var(--red)' },
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--line-soft)',
      }}
    >
      <span style={{ font: '500 12px/1 Inter', color: 'var(--muted)', width: 96, flexShrink: 0 }}>
        {label}
      </span>
      <span
        style={{
          font: '500 12.5px/1.3 Inter',
          marginLeft: 'auto',
          textAlign: 'right',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** The one switch shape this screen uses. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: 38,
        height: 22,
        borderRadius: 999,
        border: '1px solid var(--line)',
        background: checked ? 'var(--accent)' : 'var(--panel-2)',
        borderColor: checked ? 'transparent' : 'var(--line)',
        position: 'relative',
        cursor: 'pointer',
        flex: 'none',
        transition: 'background .12s ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: checked ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          transition: 'left .12s ease',
        }}
      />
    </button>
  );
}

const CTC_STORAGE = { enabled: 'talkr_ctc_enabled', offHosts: 'talkr_ctc_off_hosts' } as const;

/**
 * Click-to-call's own settings. A rep who hits a site where marking numbers up
 * fights the page needs a way out that is not "uninstall the extension", so
 * there is a switch for this site and a switch for all of them. Both are read
 * by the content script live — no reload.
 */
function ClickToCallSettings() {
  const [enabled, setEnabled] = useState(true);
  const [offHosts, setOffHosts] = useState<string[]>([]);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    void chrome.storage.local.get([CTC_STORAGE.enabled, CTC_STORAGE.offHosts]).then((stored) => {
      setEnabled((stored[CTC_STORAGE.enabled] as boolean | undefined) ?? true);
      setOffHosts((stored[CTC_STORAGE.offHosts] as string[] | undefined) ?? []);
    });
    void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      const url = tab?.url;
      if (!url) return;
      try {
        const parsed = new URL(url);
        // chrome:// and the web store are pages no extension may touch, so
        // offering a switch for them would be a lie.
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') setHost(parsed.hostname);
      } catch {
        /* a tab with no readable URL */
      }
    });
  }, []);

  const onHere = host !== null && !offHosts.includes(host);

  return (
    <>
      <Eyebrow>Click to call</Eyebrow>
      <div style={{ paddingBottom: 18 }}>
        <Row label="On every site">
          <Toggle
            checked={enabled}
            label="Click to call on every site"
            onChange={(next) => {
              setEnabled(next);
              void chrome.storage.local.set({ [CTC_STORAGE.enabled]: next });
            }}
          />
        </Row>
        {host && (
          <Row label={host}>
            <Toggle
              checked={enabled && onHere}
              label={`Click to call on ${host}`}
              onChange={(next) => {
                const nextHosts = next ? offHosts.filter((h) => h !== host) : [...offHosts, host];
                setOffHosts(nextHosts);
                void chrome.storage.local.set({ [CTC_STORAGE.offHosts]: nextHosts });
              }}
            />
          </Row>
        )}
        <p style={{ font: '500 11px/1.45 Inter', color: 'var(--muted)', margin: '8px 0 0' }}>
          Phone numbers on any page become clickable. Select a number anywhere — a form field
          included — for a Call button, or right-click it.
        </p>
      </div>
    </>
  );
}

export function Account({
  session,
  me,
  snapshot,
  onBack,
  onEnableSoftphone,
}: {
  session: Session;
  me: MeDto | null;
  snapshot: CallSnapshot;
  onBack: () => void;
  onEnableSoftphone: () => void;
}) {
  const [apiUrl, setApiUrl] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  useEffect(() => {
    void sessionStore.apiUrl().then(setApiUrl);
  }, []);

  const user = me ?? session.user;
  const name = user?.display_name ?? user?.email ?? 'Signed in';
  const device = DEVICE_LABEL[snapshot.device];
  const number = me?.numbers?.[0] ?? null;
  const zone = me?.timezone ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--panel)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          aria-label="Close"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 30,
            height: 30,
            borderRadius: 9,
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--muted)',
          }}
        >
          <Icon name="x" size={15} />
        </button>
        <div style={{ font: '700 13px/1 Inter' }}>Account</div>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 14 }}>
          <Avatar name={name} size={44} dark />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <div style={{ font: '700 15px/1.1 Inter', letterSpacing: '-0.01em' }}>{name}</div>
            <div
              style={{
                font: '500 12px/1 Inter',
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user?.email ?? '—'}
            </div>
          </div>
        </div>

        <Eyebrow>Workspace</Eyebrow>
        <div style={{ paddingBottom: 14 }}>
          <Row label="Organization">{user?.org?.name ?? '—'}</Row>
          <Row label="Role">
            <span style={{ textTransform: 'capitalize' }}>{user?.role ?? '—'}</span>
          </Row>
          <Row label="Your number">
            {number ? (
              <span>
                {formatPhone(number.phone_e164)}
                {number.label ? (
                  <span style={{ color: 'var(--muted)' }}> · {number.label}</span>
                ) : null}
              </span>
            ) : (
              <span style={{ color: 'var(--muted)' }}>No number assigned</span>
            )}
          </Row>
          <Row label="Local zone">
            {zone ? (
              <span>
                {me?.city ? `${me.city} · ` : ''}
                {tzAbbr(zone)}
              </span>
            ) : (
              <span style={{ color: 'var(--muted)' }}>Set in the web app</span>
            )}
          </Row>
        </div>

        <Eyebrow>Softphone</Eyebrow>
        <div style={{ paddingBottom: 14 }}>
          <Row label="Status">
            <StatusMarker color={device.color} label={device.label} />
          </Row>
          <Row label="Carrier">
            <span style={{ textTransform: 'capitalize', color: snapshot.provider ? undefined : 'var(--muted)' }}>
              {snapshot.provider ?? 'Not connected yet'}
            </span>
          </Row>
          {snapshot.device !== 'ready' && (
            <Button tone="accent" onClick={onEnableSoftphone} style={{ marginTop: 10, width: '100%' }}>
              Enable softphone
            </Button>
          )}
          {snapshot.deviceError && (
            <p style={{ font: '500 11px/1.4 Inter', color: 'var(--red)', margin: '8px 0 0' }}>
              {snapshot.deviceError}
            </p>
          )}
        </div>

        <Eyebrow>Connection</Eyebrow>
        <div style={{ paddingBottom: 18 }}>
          <Row label="API">
            <span style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)', wordBreak: 'break-all' }}>
              {apiUrl}
            </span>
          </Row>
          <Row label="Session">
            <span style={{ color: 'var(--muted)' }}>
              {session.origin === 'clozr'
                ? 'Signed in through CLOZR'
                : session.refreshToken
                  ? 'Renews automatically'
                  : 'Access token'}
            </span>
          </Row>
        </div>

        <ClickToCallSettings />

        <Button
          tone="ghost"
          disabled={signingOut}
          onClick={() => {
            setSigningOut(true);
            void auth.signOut().finally(() => setSigningOut(false));
          }}
          style={{ width: '100%', color: 'var(--red)' }}
        >
          {signingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </div>
  );
}
