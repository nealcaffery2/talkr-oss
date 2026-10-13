'use client';

/**
 * The coaching card under a call's transcript (docs/coaching.md §5): the
 * overall score as one big banded number, the talk ratio as a two-sided bar
 * against the 40–45% discovery target, the ten rubric categories with their
 * 0–10 score and reason, then strengths, gaps, missed opportunities, the
 * seller read-out and the next action.
 *
 * The card owns none of the fetching: the call page loads and refreshes the
 * score (SSE `score.updated`, plus polling while it is queued or running) and
 * hands the state down, exactly as it does for the transcript.
 */

import type { CallScoreDto, CallScoreResponseDto, CategoryScoreDto } from '@/lib/api';
import { Button, Card, Eyebrow, SectionTitle, StatusMarker } from '@/components/ui';
import { Icon } from '@/components/Icon';
import {
  BAND_COLOR,
  BAND_LABEL,
  COACHING_CATEGORIES,
  RECOMMENDED_PLAY_LABELS,
  SELLER_BUCKET_LABELS,
  TALK_RATIO_NOTE,
  categoryColor,
  scoreBand,
  talkRatioSplit,
  talkRatioVerdict,
} from '@/lib/coaching';

const BODY = { font: '400 12.5px/1.55 Inter' } as const;
const MUTED = { font: '400 12px/1.5 Inter', color: 'var(--muted)' } as const;

export function CoachingCard({
  data,
  waiting,
  busy,
  manage,
  transcriptReady,
  onScore,
}: {
  data: CallScoreResponseDto | null;
  /** A queue/run is in flight, including the moment just after a click. */
  waiting: boolean;
  busy: boolean;
  /** Manager+: queueing a score is the same permission as queueing a transcript. */
  manage: boolean;
  transcriptReady: boolean;
  onScore: (force: boolean) => void;
}) {
  const score = data?.score ?? null;
  const done = score?.status === 'completed';

  let body: React.ReactNode;
  if (!data) {
    body = <p style={MUTED}>Loading…</p>;
  } else if (!data.configured) {
    body = (
      <p style={MUTED}>
        Call scoring is not set up — add <code>ANTHROPIC_API_KEY</code> to the API environment and new transcripts will be
        scored automatically.
      </p>
    );
  } else if (!transcriptReady && !score) {
    // Scoring is enqueued by the transaction that finishes the transcript, so
    // while that is still running the honest state is "waiting on it".
    body = waiting ? (
      <Working>Waiting for the transcript…</Working>
    ) : (
      <p style={MUTED}>A score is read from the transcript, so this call needs one first.</p>
    );
  } else if (!score && waiting) {
    body = <Working>Scoring this call… usually under a minute.</Working>;
  } else if (!score) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p style={MUTED}>
          Not scored yet. New transcripts are scored automatically; this one finished before that existed.
        </p>
        {manage && (
          <Button tone="accent" onClick={() => onScore(false)} disabled={busy}>
            Score this call
          </Button>
        )}
      </div>
    );
  } else if (score.status === 'queued' || score.status === 'running' || waiting) {
    body = <Working>Scoring this call… usually under a minute.</Working>;
  } else if (score.status === 'failed') {
    body = (
      <div className="flex flex-col items-start gap-3">
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--red)' }}>
          Scoring failed{score.error ? `: ${score.error}` : '.'}
        </p>
        {manage && (
          <Button tone="ghost" onClick={() => onScore(true)} disabled={busy}>
            Retry
          </Button>
        )}
      </div>
    );
  } else {
    body = <ScoreBody score={score} manage={manage} busy={busy} onScore={onScore} />;
  }

  const band = done && score?.overall != null ? scoreBand(score.overall) : null;

  return (
    <Card className="flex flex-col gap-3.5">
      <SectionTitle
        icon={<Icon name="award" size={15} />}
        right={band ? <StatusMarker color={BAND_COLOR[band]} label={BAND_LABEL[band]} /> : undefined}
      >
        Coaching
      </SectionTitle>
      {body}
    </Card>
  );
}

function ScoreBody({
  score,
  manage,
  busy,
  onScore,
}: {
  score: CallScoreDto;
  manage: boolean;
  busy: boolean;
  onScore: (force: boolean) => void;
}) {
  const band = score.overall != null ? scoreBand(score.overall) : null;
  const seller = score.seller ?? {};
  // Server order, then anything a newer server added that this build predates.
  const known = COACHING_CATEGORIES.filter((c) => score.categories?.[c.id]);
  const extra = Object.keys(score.categories ?? {})
    .filter((id) => !COACHING_CATEGORIES.some((c) => c.id === id))
    .map((id) => ({ id, label: id.replace(/_/g, ' '), hint: '' }));

  return (
    <div className="flex flex-col gap-5">
      {/* ── Overall + talk ratio ─────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
        <span className="flex flex-col gap-1.5">
          <Eyebrow>Overall</Eyebrow>
          <span className="display" style={{ font: '700 40px/1 Inter', letterSpacing: '-0.03em', color: band ? BAND_COLOR[band] : 'var(--text)' }}>
            {score.overall ?? '—'}
            <span style={{ font: '600 15px/1 Inter', color: 'var(--muted-2)' }}> / 100</span>
          </span>
          <span style={{ font: '500 10.5px/1.4 Inter', color: 'var(--muted)' }}>
            Average reps land 50–60; 70+ is a strong call.
          </span>
        </span>
        <TalkRatio ratio={score.rep_talk_ratio} />
      </div>

      {/* ── The rubric ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-1">
        <Eyebrow>Rubric</Eyebrow>
        <div className="flex flex-col">
          {[...known, ...extra].map((c) => (
            <CategoryRow key={c.id} label={c.label} hint={c.hint} value={score.categories[c.id]!} />
          ))}
        </div>
      </div>

      {score.strengths?.length > 0 && (
        <Bullets label="What worked" items={score.strengths} color="var(--green)" />
      )}
      {score.gaps?.length > 0 && <Bullets label="What to fix" items={score.gaps} color="var(--amber)" />}

      {score.missed_opportunities?.length > 0 && (
        <div className="flex flex-col gap-2">
          <Eyebrow>Missed openings</Eyebrow>
          <div className="flex flex-col gap-2.5">
            {score.missed_opportunities.map((m, i) => (
              <div key={i} className="flex flex-col gap-1" style={{ borderLeft: '2px solid var(--line)', paddingLeft: 10 }}>
                <span style={{ font: '600 12px/1.4 Inter' }}>{m.moment}</span>
                {m.quote && (
                  <span style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)', fontStyle: 'italic' }}>“{m.quote}”</span>
                )}
                <span style={BODY}>{m.instead}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── The seller ───────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2.5" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Eyebrow>Seller</Eyebrow>
          {seller.bucket && (
            <span style={{ font: '600 12px/1 Inter' }}>
              {SELLER_BUCKET_LABELS[seller.bucket] ?? seller.bucket}
            </span>
          )}
          {seller.recommended_play && (
            <span style={{ font: '600 11px/1 Inter', color: 'var(--accent)' }}>
              → {RECOMMENDED_PLAY_LABELS[seller.recommended_play] ?? seller.recommended_play}
            </span>
          )}
          {seller.bucket_confidence != null && (
            <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
              {Math.round(seller.bucket_confidence * 100)}% confident
            </span>
          )}
        </div>
        {seller.bucket_rationale && <p style={BODY}>{seller.bucket_rationale}</p>}
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Mini label="Motivation" value={tenOf(seller.motivation_score)} />
          <Mini label="Price fit" value={tenOf(seller.price_alignment_score)} />
        </div>
        <div className="grid gap-x-5 gap-y-3 sm:grid-cols-2">
          <Fact label="Why they'd sell">{seller.motivation}</Fact>
          <Fact label="Timeline">{seller.timeline}</Fact>
          <Fact label="Condition">{seller.condition}</Fact>
          <Fact label="Price expectation">{seller.price_expectation}</Fact>
        </div>
        {seller.emotions && seller.emotions.length > 0 && (
          <span className="flex flex-wrap items-center gap-2">
            <Eyebrow>Read</Eyebrow>
            {seller.emotions.map((e) => (
              <span
                key={e}
                style={{ font: '500 11px/1 Inter', color: 'var(--muted)', background: 'var(--panel-2)', borderRadius: 6, padding: '4px 7px' }}
              >
                {e}
              </span>
            ))}
          </span>
        )}
      </div>

      {score.next_action && (
        <div className="flex flex-col gap-1.5" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
          <Eyebrow>Next action</Eyebrow>
          <span style={{ font: '600 13px/1.5 Inter' }}>{score.next_action}</span>
        </div>
      )}

      <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
        {score.model ? `Scored by ${score.model}` : ''}
        {manage && (
          <>
            {score.model ? ' · ' : ''}
            <button
              type="button"
              onClick={() => onScore(true)}
              disabled={busy}
              style={{ background: 'none', border: 'none', padding: 0, color: 'var(--muted)', font: 'inherit', cursor: 'pointer' }}
            >
              Re-score
            </button>
          </>
        )}
      </span>
    </div>
  );
}

function tenOf(value: number | null | undefined): string {
  return value == null ? '—' : `${value}/10`;
}

function CategoryRow({ label, hint, value }: { label: string; hint: string; value: CategoryScoreDto }) {
  const pct = value.score != null ? (value.score / 10) * 100 : 0;
  return (
    <div
      className="grid gap-x-3 gap-y-1 py-2"
      style={{ gridTemplateColumns: '132px 64px 1fr', alignItems: 'center', borderBottom: '1px solid var(--panel-2)' }}
      title={hint || undefined}
    >
      <span style={{ font: '600 12px/1.3 Inter' }}>{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="flex h-1.5 flex-1 overflow-hidden" style={{ borderRadius: 2, background: 'var(--panel-2)' }}>
          <span style={{ width: `${pct}%`, background: categoryColor(value.score) }} />
        </span>
        <span
          style={{
            font: '600 11px/1 Inter',
            fontVariantNumeric: 'tabular-nums',
            color: value.score == null ? 'var(--muted-2)' : 'var(--text)',
            minWidth: 16,
            textAlign: 'right',
          }}
        >
          {value.score ?? '—'}
        </span>
      </span>
      <span style={{ font: '400 12px/1.45 Inter', color: value.score == null ? 'var(--muted)' : 'var(--text)' }}>
        {value.reason}
      </span>
    </div>
  );
}

/** Rep against seller, with the discovery-call target called out in words. */
function TalkRatio({ ratio }: { ratio: number | null }) {
  const split = talkRatioSplit(ratio);
  const verdict = talkRatioVerdict(ratio);
  if (!split || !verdict) return null;
  return (
    <span className="flex min-w-[240px] flex-1 flex-col gap-1.5">
      <Eyebrow>Talk ratio</Eyebrow>
      <span className="flex h-2.5 overflow-hidden" style={{ borderRadius: 3, background: 'var(--panel-2)' }}>
        <span style={{ width: `${split.rep}%`, background: 'var(--accent)' }} />
        <span style={{ width: `${split.seller}%`, background: 'var(--muted-2)' }} />
      </span>
      <span className="flex justify-between" style={{ font: '600 11px/1 Inter', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: 'var(--accent)' }}>Rep {split.rep}%</span>
        <span style={{ color: 'var(--muted)' }}>Seller {split.seller}%</span>
      </span>
      <span style={{ font: '400 11px/1.4 Inter', color: verdict === 'rep_heavy' ? 'var(--amber)' : 'var(--muted)' }}>
        {TALK_RATIO_NOTE[verdict]}
      </span>
    </span>
  );
}

function Bullets({ label, items, color }: { label: string; items: string[]; color: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>{label}</Eyebrow>
      <ul className="flex flex-col gap-1.5">
        {items.map((t, i) => (
          <li key={i} className="flex gap-2.5">
            <span style={{ width: 6, height: 6, background: color, marginTop: 6, flexShrink: 0 }} aria-hidden />
            <span style={BODY}>{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <Eyebrow>{label}</Eyebrow>
      <span style={BODY}>{children || <span style={MUTED}>Not discussed</span>}</span>
    </span>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <Eyebrow>{label}</Eyebrow>
      <span style={{ font: '600 12.5px/1 Inter', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  );
}

function Working({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2" style={MUTED}>
      <span
        aria-hidden
        style={{ width: 6, height: 6, background: 'var(--accent)', animation: 'talkr-blink 1.2s ease-in-out infinite' }}
      />
      {children}
      <style>{`@keyframes talkr-blink { 0%,100% { opacity: .25 } 50% { opacity: 1 } }`}</style>
    </span>
  );
}
