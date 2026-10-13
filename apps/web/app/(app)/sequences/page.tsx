'use client';

/**
 * Sequences (docs/sequences.md): the list of drip follow-ups with their
 * enrollment numbers and an enabled switch, plus the two ways to start one —
 * an empty builder, or "Draft with AI", which asks the server for a
 * TCPA-safe draft and hands it to the builder for editing before anything is
 * saved. Manager-level (`workflows.manage`); reps see a clear message.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type SequenceDraftInput, type SequenceDto } from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  GridHead,
  GridRow,
  Input,
  Labeled,
  Modal,
  Notice,
  Select,
  TextArea,
  Toggle,
} from '@/components/ui';
import { DRAFT_STORAGE_KEY, formatMinutes } from '@/lib/sequences';

const COLS = 'minmax(220px, 2fr) 120px 90px repeat(4, 80px) 70px 60px';
const MIN_WIDTH = 900;

export default function SequencesPage() {
  const { authed } = useSoftphone();
  const router = useRouter();
  const [sequences, setSequences] = useState<SequenceDto[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await api.listSequences();
      setSequences(r.sequences);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (authed) void load();
  }, [authed, load]);

  const toggle = async (s: SequenceDto) => {
    // Optimistic: the switch answers immediately, the list re-reads after.
    setSequences((prev) => prev?.map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x)) ?? prev);
    try {
      await api.updateSequence(s.id, { enabled: !s.enabled });
    } catch (err) {
      setError((err as Error).message);
    }
    await load();
  };

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const inFlight = sequences?.reduce((n, s) => n + s.stats.active, 0) ?? 0;

  return (
    <>
      <TopBar
        title="Sequences"
        subtitle={
          sequences === null
            ? 'Drip follow-up by text'
            : `${sequences.length} ${sequences.length === 1 ? 'sequence' : 'sequences'} · ${inFlight} ${inFlight === 1 ? 'lead' : 'leads'} in flight`
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {forbidden ? (
          <Notice tone="warn">Sequences are manager-level. Ask an admin for the manager role to build follow-up.</Notice>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-end gap-2 pb-3">
              <Button tone="ghost" onClick={() => setDrafting(true)}>
                <Icon name="template" size={14} />
                Draft with AI
              </Button>
              <Button tone="dark" onClick={() => router.push('/sequences/new')}>
                <Icon name="plus" size={14} />
                New sequence
              </Button>
            </div>

            {error && (
              <Notice tone="error" className="mb-3" action={<Button tone="quiet" onClick={() => setError(null)}>Dismiss</Button>}>
                {error}
              </Notice>
            )}

            <Card padded={false} className="overflow-x-auto">
              <GridHead cols={COLS} minWidth={MIN_WIDTH}>
                <Eyebrow>Sequence</Eyebrow>
                <Eyebrow>Steps</Eyebrow>
                <Eyebrow>Span</Eyebrow>
                <Eyebrow>Enrolled</Eyebrow>
                <Eyebrow>Active</Eyebrow>
                <Eyebrow>Replied</Eyebrow>
                <Eyebrow>Done</Eyebrow>
                <Eyebrow>On</Eyebrow>
                <span />
              </GridHead>
              {sequences === null && (
                <p className="px-4 py-6" style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>Loading…</p>
              )}
              {sequences?.length === 0 && (
                <EmptyState
                  title="No sequences yet"
                  hint="A sequence texts a lead a few times over a couple of weeks and stops the moment they reply. Draft one with AI or build it by hand."
                  action={
                    <Button tone="accent" onClick={() => setDrafting(true)}>
                      <Icon name="template" size={14} />
                      Draft with AI
                    </Button>
                  }
                />
              )}
              {sequences?.map((s) => (
                <GridRow key={s.id} cols={COLS} minWidth={MIN_WIDTH}>
                  <Link href={`/sequences/${s.id}`} className="flex min-w-0 flex-col gap-1">
                    <span className="truncate" style={{ font: '600 13px/1 Inter' }}>{s.name}</span>
                    <span className="truncate" style={{ font: '400 11.5px/1.3 Inter', color: 'var(--muted)' }}>
                      {s.description || timelineLabel(s)}
                    </span>
                  </Link>
                  <span style={{ font: '500 12px/1.3 Inter' }}>
                    {s.sms_count} {s.sms_count === 1 ? 'text' : 'texts'}
                    <span style={{ color: 'var(--muted-2)' }}> · {s.steps.length} steps</span>
                  </span>
                  <span style={{ font: '500 12px/1 Inter' }}>{formatMinutes(s.duration_minutes)}</span>
                  <Num n={s.stats.enrolled} />
                  <Num n={s.stats.active} tone={s.stats.active > 0 ? 'var(--amber)' : undefined} />
                  <Num n={s.stats.replied} tone={s.stats.replied > 0 ? 'var(--green)' : undefined} />
                  <Num n={s.stats.completed} />
                  <Toggle on={s.enabled} onChange={() => void toggle(s)} label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`} />
                  <Link href={`/sequences/${s.id}`} style={{ font: '600 12px/1 Inter', color: 'var(--accent)' }}>
                    Open
                  </Link>
                </GridRow>
              ))}
            </Card>
          </>
        )}
      </div>

      {drafting && <DraftWithAiModal onClose={() => setDrafting(false)} />}
    </>
  );
}

function Num({ n, tone }: { n: number; tone?: string }) {
  return (
    <span className="tabular-nums" style={{ font: '600 13px/1 Inter', color: tone ?? (n === 0 ? 'var(--muted-2)' : 'var(--text)') }}>
      {n}
    </span>
  );
}

function timelineLabel(s: SequenceDto): string {
  const days = [...new Set(s.timeline.filter((t) => t.type === 'sms').map((t) => t.day))];
  return days.length ? `Texts on day ${days.join(', ')}` : 'No texts';
}

/**
 * The brief for the AI builder. On success the draft is parked in
 * sessionStorage and the builder opens with it loaded — nothing is saved
 * until the person reviewing it says so.
 */
function DraftWithAiModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState<NonNullable<SequenceDraftInput['tone']>>('friendly');
  const [steps, setSteps] = useState(4);
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = goal.trim().length >= 10 && steps >= 2 && steps <= 8 && days >= 1 && days <= 60;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.draftSequenceWithAi({
        goal: goal.trim(),
        audience: audience.trim() || null,
        tone,
        channel: 'sms',
        steps,
        days,
      });
      try {
        window.sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(r));
      } catch {
        /* private mode: the builder falls back to an empty sequence */
      }
      router.push('/sequences/new?draft=1');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'ai_not_configured') {
        setErr(`AI drafting is not set up on this server yet. ${e.message || 'Add ANTHROPIC_API_KEY to enable it.'}`);
      } else if (e instanceof ApiError && e.status === 502) {
        setErr(e.message || 'The AI could not produce a compliant draft. Try a more specific goal.');
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Draft a sequence with AI" onClose={onClose} width={600}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Labeled label="Goal">
          <TextArea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Re-engage sellers who said 'not right now' on the first call and book a second conversation."
          />
        </Labeled>
        <Labeled label="Audience (optional)">
          <Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Absentee owners of single-family rentals in DFW" />
        </Labeled>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
          <Labeled label="Tone">
            <Select value={tone} onChange={(e) => setTone(e.target.value as typeof tone)}>
              <option value="friendly">Friendly</option>
              <option value="direct">Direct</option>
              <option value="professional">Professional</option>
            </Select>
          </Labeled>
          <Labeled label="Texts (2–8)">
            <Input type="number" min={2} max={8} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
          </Labeled>
          <Labeled label="Over how many days (1–60)">
            <Input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </Labeled>
        </div>
        <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          The draft identifies the sender, puts opt-out language in the first text, keeps every message under 320
          characters and avoids pressure tactics. You review and edit it before anything is saved or sent.
        </p>
        {err && <Notice tone="error">{err}</Notice>}
        <div className="flex items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={!ready || busy}>
            {busy ? 'Drafting…' : 'Draft sequence'}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
