'use client';

/**
 * Call detail (design 1c): the recording you can actually play, the
 * transcript beside it, and the AI call notes a manager reads instead of the
 * audio — the "AI call notes" surface (docs/transcription.md).
 *
 * The <audio> tag cannot send a bearer header, so the MP3 comes through the
 * authenticated client as a Blob and plays from an object URL that is
 * revoked when the page goes away.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ApiError,
  api,
  eventStreamUrl,
  getSessionUser,
  type CallDto,
  type CallNotesDto,
  type CallScoreResponseDto,
  type CallTranscriptDto,
  type TranscriptSegmentDto,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Avatar, Button, Card, Eyebrow, StatusMarker } from '@/components/ui';
import { AddContactButton } from '@/components/AddContact';
import { CoachingCard } from '@/components/CoachingCard';
import { duration, formatPhone } from '@/lib/time';

const POLL_MS = 5_000;
const POLL_LIMIT_MS = 3 * 60_000;
/**
 * How long to keep asking for a recording the carrier has not posted yet.
 * Measured on Telnyx: the recording row appears about half a minute after
 * hang-up. Shorter than POLL_LIMIT_MS because this one also runs on old calls
 * that were never recorded at all, where there is nothing to wait for.
 */
const CARRIER_POLL_LIMIT_MS = 2 * 60_000;

const STATUS_COLOR: Record<string, string> = {
  completed: 'var(--green)',
  in_progress: 'var(--accent)',
  no_answer: 'var(--amber)',
  busy: 'var(--amber)',
  failed: 'var(--red)',
  canceled: 'var(--muted)',
};

const SENTIMENT: Record<string, { color: string; label: string }> = {
  positive: { color: 'var(--green)', label: 'Positive' },
  neutral: { color: 'var(--muted)', label: 'Neutral' },
  negative: { color: 'var(--red)', label: 'Negative' },
  mixed: { color: 'var(--amber)', label: 'Mixed' },
};

const SPEAKER: Record<TranscriptSegmentDto['speaker'], { label: string; color: string }> = {
  rep: { label: 'Rep', color: 'var(--accent)' },
  contact: { label: 'Owner', color: 'var(--text)' },
  unknown: { label: '—', color: 'var(--muted-2)' },
};

function whenLabel(iso: string): string {
  return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * Managers and up can queue transcription (recordings.listen.org). With no
 * session user (an open-access server) the button shows and the API decides.
 */
function canManage(): boolean {
  const role = getSessionUser()?.role;
  return role == null || ['owner', 'admin', 'manager'].includes(role);
}

const BODY = { font: '400 12.5px/1.55 Inter' } as const;
const MUTED = { font: '400 12px/1.5 Inter', color: 'var(--muted)' } as const;

export default function CallDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { authed } = useSoftphone();
  const [call, setCall] = useState<CallDto | null>(null);
  const [tx, setTx] = useState<CallTranscriptDto | null>(null);
  const [scoreData, setScoreData] = useState<CallScoreResponseDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Status at the moment "Transcribe" was clicked; cleared once the server moves off it. */
  const [requestedFrom, setRequestedFrom] = useState<string | null | undefined>(undefined);
  /** The same trick for the coaching score, which has its own job and its own wait. */
  const [scoreRequestedFrom, setScoreRequestedFrom] = useState<string | null | undefined>(undefined);

  const loadTranscript = useCallback(async () => {
    try {
      setTx(await api.getCallTranscript(id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);

  const loadScore = useCallback(async () => {
    try {
      setScoreData(await api.getCallScore(id));
    } catch (e) {
      // A missing score never breaks the page the recording is on.
      if (!(e instanceof ApiError && e.status === 403)) setError((e as Error).message);
    }
  }, [id]);

  useEffect(() => {
    if (!authed || !id) return;
    api
      .getCall(id)
      .then((r) => setCall(r.call))
      .catch((e) =>
        setError(e instanceof ApiError && e.status === 404 ? 'This call does not exist.' : (e as Error).message),
      );
    void loadTranscript();
    void loadScore();
  }, [authed, id, loadTranscript, loadScore]);

  const transcript = tx?.transcript ?? null;
  const recording = tx?.recording ?? null;
  const status = transcript?.status ?? null;
  useEffect(() => {
    // The click is "done" once the server reports anything other than what
    // the page showed when it was clicked.
    if (requestedFrom !== undefined && status !== requestedFrom) setRequestedFrom(undefined);
  }, [status, requestedFrom]);
  const waiting = status === 'queued' || status === 'processing' || requestedFrom !== undefined;

  const scoreStatus = scoreData?.score?.status ?? null;
  useEffect(() => {
    if (scoreRequestedFrom !== undefined && scoreStatus !== scoreRequestedFrom) setScoreRequestedFrom(undefined);
  }, [scoreStatus, scoreRequestedFrom]);
  // A completing transcript enqueues scoring, so the card is "working" for
  // the whole chain rather than flashing "not scored yet" in between.
  const scoreWaiting =
    scoreStatus === 'queued' || scoreStatus === 'running' || scoreRequestedFrom !== undefined || waiting;

  /**
   * Opened straight off a hang-up there is no transcript row yet — the carrier
   * has not even posted the recording — so `status` is null and none of the
   * states above are "waiting". That was the whole bug: the one moment a rep
   * actually watches this page was the one moment it never refreshed, and the
   * card sat on "Waiting for the transcript…" until they reloaded by hand.
   * A recording that has not arrived, or is still processing at the carrier,
   * is just as much a reason to keep asking as a transcript that is queued.
   */
  const carrierPending =
    tx != null && (recording == null || (recording.status !== 'completed' && recording.status !== 'failed'));

  // Polling covers a stream that never connected; the bus event below makes
  // the common case instant. Bounded, so a dead job does not spin forever.
  useEffect(() => {
    if (!authed || !(waiting || scoreWaiting || carrierPending)) return;
    const started = Date.now();
    const t = setInterval(() => {
      const elapsed = Date.now() - started;
      const stillChasingCarrier = carrierPending && elapsed <= CARRIER_POLL_LIMIT_MS;
      if (elapsed > POLL_LIMIT_MS || (!waiting && !scoreWaiting && !stillChasingCarrier)) {
        clearInterval(t);
        setRequestedFrom(undefined);
        setScoreRequestedFrom(undefined);
        return;
      }
      if (waiting || stillChasingCarrier) void loadTranscript();
      if (scoreWaiting) void loadScore();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [authed, waiting, scoreWaiting, carrierPending, loadTranscript, loadScore]);

  useEffect(() => {
    if (!authed) return;
    const source = new EventSource(eventStreamUrl());
    const forThisCall = (raw: MessageEvent): boolean => {
      try {
        return (JSON.parse(raw.data) as { callId?: string }).callId === id;
      } catch {
        return false; // ignore malformed
      }
    };
    const onTranscript = (raw: MessageEvent) => {
      if (!forThisCall(raw)) return;
      void loadTranscript();
      // The scoring job is enqueued by the same transaction that completes
      // the transcript, so the card should start waiting immediately.
      void loadScore();
    };
    const onScore = (raw: MessageEvent) => {
      if (forThisCall(raw)) void loadScore();
    };
    source.addEventListener('transcript.updated', onTranscript);
    source.addEventListener('score.updated', onScore);
    return () => source.close();
  }, [authed, id, loadTranscript, loadScore]);

  // ── Audio ────────────────────────────────────────────────────────────────
  const recordingId = recording?.status === 'completed' ? recording.id : null;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [time, setTime] = useState(0);

  useEffect(() => {
    if (!authed || !recordingId) return;
    let url: string | null = null;
    let cancelled = false;
    setAudioUrl(null);
    setAudioError(null);
    api
      .getRecordingAudio(recordingId)
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setAudioUrl(url);
      })
      .catch((e) => {
        if (cancelled) return;
        setAudioError(
          e instanceof ApiError && e.code === 'media_unavailable'
            ? 'The carrier could not serve this recording right now. Try again in a minute.'
            : (e as Error).message,
        );
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [authed, recordingId]);

  const segments = useMemo(() => transcript?.segments ?? [], [transcript]);
  const activeIndex = useMemo(() => {
    let idx = -1;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i]!.start <= time) idx = i;
      else break;
    }
    return idx;
  }, [segments, time]);

  const seek = (seconds: number) => {
    const a = audioRef.current;
    if (!a) return;
    a.currentTime = seconds;
    void a.play().catch(() => undefined);
  };

  const requestTranscript = async (force: boolean) => {
    if (!recordingId) return;
    setBusy(true);
    setError(null);
    try {
      await api.requestTranscript(recordingId, force);
      setRequestedFrom(status);
      await loadTranscript();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestScore = async (force: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.requestCallScore(id, force);
      setScoreRequestedFrom(scoreStatus);
      await loadScore();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === 'transcript_not_ready'
          ? 'This call needs a finished transcript before it can be scored.'
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const other = call ? (call.direction === 'outbound' ? call.to_number : call.from_number) : '';
  const name = call?.contact_name ?? (other ? formatPhone(other) : 'Call');
  const manage = canManage();

  return (
    <>
      <TopBar title={name} subtitle={call ? `${call.direction} · ${whenLabel(call.created_at)}` : 'Loading call…'} />

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-5">
        <a
          href="/calls"
          className="inline-flex items-center gap-1.5 self-start"
          style={{ font: '600 12px/1 Inter', color: 'var(--muted)' }}
        >
          <Icon name="chevron-left" size={13} />
          Call history
        </a>

        {error && <p style={{ font: '400 12px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}

        {call && (
          <Card className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <span className="flex min-w-0 items-center gap-3">
              <Avatar name={name} size={40} />
              <span className="flex min-w-0 flex-col gap-1.5">
                {call.contact_id ? (
                  <Link
                    href={`/contacts/${call.contact_id}`}
                    className="truncate"
                    style={{ font: '700 15px/1 Inter', letterSpacing: '-0.01em', color: 'var(--text)' }}
                  >
                    {name}
                  </Link>
                ) : (
                  <span className="truncate" style={{ font: '700 15px/1 Inter', letterSpacing: '-0.01em' }}>
                    {name}
                  </span>
                )}
                <span style={{ font: '500 11.5px/1 Inter', color: 'var(--muted)' }}>
                  {call.contact_name ? `${formatPhone(other)} · ` : ''}
                  {call.direction === 'outbound' ? `from ${formatPhone(call.from_number)}` : `to ${formatPhone(call.to_number)}`}
                </span>
              </span>
              {!call.contact_id && (
                <AddContactButton
                  phone={other}
                  onCreated={(contact) =>
                    setCall((c) => (c ? { ...c, contact_id: contact.id, contact_name: contact.display_name } : c))
                  }
                />
              )}
            </span>

            <Fact label="Status">
              <StatusMarker color={STATUS_COLOR[call.status] ?? 'var(--muted)'} label={call.status.replace(/_/g, ' ')} />
            </Fact>
            <Fact label="When">{whenLabel(call.created_at)}</Fact>
            <Fact label="Duration">{call.duration_seconds != null ? duration(call.duration_seconds) : '—'}</Fact>
            <Fact label="Disposition">{tx?.call.disposition ?? (call.disposition_id ? '…' : 'None')}</Fact>
            {tx?.call.disposition_note && (
              <span className="flex w-full flex-col gap-1.5" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                <Eyebrow>Rep note</Eyebrow>
                <span style={BODY}>{tx.call.disposition_note}</span>
              </span>
            )}
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-[1.25fr_1fr]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card className="flex flex-col gap-3">
              <span className="flex items-center gap-2.5">
                <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
                  <Icon name="speaker" size={15} />
                </span>
                <span className="mr-auto" style={{ font: '700 13.5px/1 Inter', letterSpacing: '-0.01em' }}>
                  Recording
                </span>
                {recording?.duration_seconds != null && (
                  <span style={{ font: '600 11px/1 Inter', color: 'var(--muted)' }}>
                    {duration(recording.duration_seconds)}
                    {recording.channels === 2 ? ' · dual channel' : ''}
                  </span>
                )}
              </span>

              {!tx && <p style={MUTED}>Loading…</p>}
              {tx && !recording && (
                <p style={MUTED}>
                  No recording for this call. Only calls that connected are recorded, and the carrier posts the file about a
                  minute after hang-up.
                </p>
              )}
              {recording && recording.status !== 'completed' && (
                <p style={MUTED}>The carrier is still processing this recording ({recording.status}).</p>
              )}
              {recordingId && audioError && <p style={{ font: '400 12px/1.5 Inter', color: 'var(--red)' }}>{audioError}</p>}
              {recordingId && !audioError && !audioUrl && <p style={MUTED}>Fetching audio…</p>}
              {audioUrl && (
                <audio
                  ref={audioRef}
                  controls
                  preload="metadata"
                  src={audioUrl}
                  className="w-full"
                  onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                  style={{ height: 40 }}
                />
              )}
            </Card>

            <TranscriptCard
              tx={tx}
              recordingReady={recordingId != null}
              waiting={waiting}
              busy={busy}
              manage={manage}
              activeIndex={activeIndex}
              onSeek={seek}
              onTranscribe={() => void requestTranscript(false)}
            />

            {/* The coaching card reads the transcript above it (docs/coaching.md). */}
            <CoachingCard
              data={scoreData}
              waiting={scoreWaiting}
              busy={busy}
              manage={manage}
              transcriptReady={transcript?.status === 'completed'}
              onScore={(force) => void requestScore(force)}
            />
          </div>

          <NotesCard
            tx={tx}
            waiting={waiting}
            busy={busy}
            manage={manage}
            recordingReady={recordingId != null}
            onRetry={() => void requestTranscript(true)}
          />
        </div>
      </div>
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      <span style={{ font: '600 12.5px/1 Inter' }}>{children}</span>
    </span>
  );
}

function fmtClock(seconds: number): string {
  return duration(Math.floor(seconds));
}

function TranscriptCard({
  tx,
  recordingReady,
  waiting,
  busy,
  manage,
  activeIndex,
  onSeek,
  onTranscribe,
}: {
  tx: CallTranscriptDto | null;
  recordingReady: boolean;
  waiting: boolean;
  busy: boolean;
  manage: boolean;
  activeIndex: number;
  onSeek: (seconds: number) => void;
  onTranscribe: () => void;
}) {
  const transcript = tx?.transcript ?? null;
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the spoken line in view while the audio plays.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  let body: React.ReactNode;
  if (!tx) {
    body = <p style={MUTED}>Loading…</p>;
  } else if (!recordingReady) {
    body = <p style={MUTED}>A transcript needs a completed recording.</p>;
  } else if (!transcript && !tx.configured) {
    body = <NotConfigured />;
  } else if (!transcript && waiting) {
    body = <Working />;
  } else if (!transcript) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p style={MUTED}>Not transcribed yet. New recordings are transcribed automatically; this one predates that.</p>
        {manage && (
          <Button tone="accent" onClick={onTranscribe} disabled={busy}>
            Transcribe now
          </Button>
        )}
      </div>
    );
  } else if (transcript.status === 'not_configured') {
    body = <NotConfigured />;
  } else if (transcript.status === 'queued' || transcript.status === 'processing') {
    body = <Working />;
  } else if (transcript.status === 'failed') {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--red)' }}>
          Transcription failed{transcript.error ? `: ${transcript.error}` : '.'}
        </p>
        {manage && (
          <Button tone="ghost" onClick={onTranscribe} disabled={busy}>
            Retry
          </Button>
        )}
      </div>
    );
  } else if (transcript.segments.length === 0) {
    body = <p style={MUTED}>No speech was detected in this recording.</p>;
  } else {
    body = (
      <div ref={listRef} className="flex max-h-[520px] flex-col overflow-y-auto" style={{ margin: '0 -8px' }}>
        {transcript.segments.map((s, i) => {
          const who = SPEAKER[s.speaker] ?? SPEAKER.unknown;
          const active = i === activeIndex;
          return (
            <button
              key={`${s.start}-${i}`}
              type="button"
              onClick={() => onSeek(s.start)}
              className="grid gap-x-3 px-2 py-1.5 text-left"
              style={{
                gridTemplateColumns: '44px 52px 1fr',
                alignItems: 'baseline',
                border: 'none',
                borderRadius: 8,
                background: active ? 'var(--accent-soft)' : 'transparent',
                cursor: 'pointer',
              }}
              title="Play from here"
            >
              <span style={{ font: '500 10.5px/1.5 Inter', color: 'var(--muted-2)', fontVariantNumeric: 'tabular-nums' }}>
                {fmtClock(s.start)}
              </span>
              <span style={{ font: '700 10px/1.6 Inter', letterSpacing: '0.08em', textTransform: 'uppercase', color: who.color }}>
                {who.label}
              </span>
              <span style={{ ...BODY, color: s.speaker === 'unknown' ? 'var(--muted)' : 'var(--text)' }}>{s.text}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-3">
      <span className="flex items-center gap-2.5">
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="template" size={15} />
        </span>
        <span className="mr-auto" style={{ font: '700 13.5px/1 Inter', letterSpacing: '-0.01em' }}>
          Transcript
        </span>
        {transcript?.status === 'completed' && (
          <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
            {transcript.model ?? transcript.provider}
            {transcript.language ? ` · ${transcript.language}` : ''}
          </span>
        )}
      </span>
      {body}
    </Card>
  );
}

function NotesCard({
  tx,
  waiting,
  busy,
  manage,
  recordingReady,
  onRetry,
}: {
  tx: CallTranscriptDto | null;
  waiting: boolean;
  busy: boolean;
  manage: boolean;
  recordingReady: boolean;
  onRetry: () => void;
}) {
  const transcript = tx?.transcript ?? null;
  const ai: CallNotesDto = transcript?.ai ?? {};
  const sentiment = ai.sentiment ? SENTIMENT[ai.sentiment] : undefined;
  const ratio = typeof ai.rep_talk_ratio === 'number' ? ai.rep_talk_ratio : null;
  const done = transcript?.status === 'completed';

  let body: React.ReactNode;
  if (!tx || !recordingReady) {
    body = <p style={MUTED}>{tx ? 'Notes appear once there is a recording.' : 'Loading…'}</p>;
  } else if (!done) {
    body = waiting ? <Working /> : <p style={MUTED}>Notes are written from the transcript once it exists.</p>;
  } else if (!transcript.summary && !tx.summary_configured) {
    body = (
      <p style={MUTED}>
        AI call notes are not set up — add <code>ANTHROPIC_API_KEY</code> to the API environment. The transcript still works.
      </p>
    );
  } else if (!transcript.summary) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--red)' }}>
          {transcript.error ?? 'The summary was not written for this call.'}
        </p>
        {manage && (
          <Button tone="ghost" onClick={onRetry} disabled={busy}>
            Retry
          </Button>
        )}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        <p style={{ font: '400 13px/1.6 Inter' }}>{transcript.summary}</p>

        {ai.key_points && ai.key_points.length > 0 && (
          <Section label="Key points">
            <ul className="flex flex-col gap-1.5 pl-4" style={{ ...BODY, listStyle: 'disc' }}>
              {ai.key_points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Section>
        )}

        <div className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
          <Section label="Seller motivation">{ai.seller_motivation || <Unsaid />}</Section>
          <Section label="Timeline">{ai.timeline || <Unsaid />}</Section>
          <Section label="Asking price">{ai.asking_price || <Unsaid />}</Section>
          <Section label="Property condition">{ai.property_condition || <Unsaid />}</Section>
        </div>

        <Section label="Objections">
          {ai.objections && ai.objections.length > 0 ? (
            <ul className="flex flex-col gap-1.5 pl-4" style={{ ...BODY, listStyle: 'disc' }}>
              {ai.objections.map((o, i) => (
                <li key={i}>{o}</li>
              ))}
            </ul>
          ) : (
            <span style={MUTED}>None raised</span>
          )}
        </Section>

        <Section label="Next step">{ai.next_step || <span style={MUTED}>Nothing agreed</span>}</Section>

        {ratio != null && (
          <Section label="Talk ratio">
            <span className="flex items-center gap-3">
              <span className="flex h-1.5 flex-1 overflow-hidden" style={{ borderRadius: 2, background: 'var(--panel-2)' }}>
                <span style={{ width: `${Math.round(ratio * 100)}%`, background: 'var(--accent)' }} />
              </span>
              <span style={{ font: '600 11.5px/1 Inter', fontVariantNumeric: 'tabular-nums' }}>
                Rep {Math.round(ratio * 100)}%
              </span>
            </span>
          </Section>
        )}

        <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
          {transcript.ai_model ? `Written by ${transcript.ai_model}` : ''}
          {manage && (
            <>
              {transcript.ai_model ? ' · ' : ''}
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                style={{ background: 'none', border: 'none', padding: 0, color: 'var(--muted)', font: 'inherit', cursor: 'pointer' }}
              >
                Regenerate
              </button>
            </>
          )}
        </span>
      </div>
    );
  }

  return (
    <Card className="flex flex-col gap-3 self-start">
      <span className="flex items-center gap-2.5">
        <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
          <Icon name="check" size={15} />
        </span>
        <span className="mr-auto" style={{ font: '700 13.5px/1 Inter', letterSpacing: '-0.01em' }}>
          AI call notes
        </span>
        {done && sentiment && <StatusMarker color={sentiment.color} label={sentiment.label} />}
      </span>
      {body}
    </Card>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      <span style={BODY}>{children}</span>
    </span>
  );
}

function Unsaid() {
  return <span style={MUTED}>Not discussed</span>;
}

function Working() {
  return (
    <span className="inline-flex items-center gap-2" style={MUTED}>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          background: 'var(--accent)',
          animation: 'talkr-blink 1.2s ease-in-out infinite',
        }}
      />
      Transcribing… usually under a minute.
      <style>{`@keyframes talkr-blink { 0%,100% { opacity: .25 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}

function NotConfigured() {
  return (
    <p style={MUTED}>
      Transcription is not set up — add <code>DEEPGRAM_API_KEY</code> to the API environment and new recordings will be
      transcribed automatically.
    </p>
  );
}
