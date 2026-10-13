'use client';

/**
 * Sequence builder (docs/sequences.md §2, §8): one page for a new sequence
 * (`/sequences/new`, optionally pre-filled by "Draft with AI") and for an
 * existing one. Left: the vertical step list (SMS with merge-field chips and
 * a segment counter, waits, tasks, status), exit rules, save/enable. Right:
 * the timeline preview and, once saved, enrollment and the run table.
 *
 * Steps cannot change while leads are mid-sequence — runs remember where
 * they are by step index — so the server answers 409 and the page says so.
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  type ContactDto,
  type MessageTemplateDto,
  type SequenceDraftResultDto,
  type SequenceDto,
  type SequenceExitRulesDto,
  type SequenceOnCompleteDto,
  type SequenceRunDto,
  type SequenceStepDto,
} from '@/lib/api';
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
  SectionTitle,
  Select,
  StatusMarker,
  TextArea,
  Toggle,
} from '@/components/ui';
import { AddContactButton } from '@/components/AddContact';
import { PhoneText } from '@/components/CopyPhone';
import { MergeFieldHelp, MergeTextArea } from '@/components/MergeField';
import { sampleMergeFields } from '@/lib/callContext';
import {
  AGENT_CAPABILITIES,
  AI_SMS_MAX_CHARS,
  COMMON_STOP_STATUSES,
  DRAFT_STORAGE_KEY,
  MERGE_FIELDS,
  RUN_STATUS_COLOR,
  SMS_MAX_CHARS,
  STEP_LABEL,
  describeStep,
  durationMinutes,
  formatMinutes,
  relativeTime,
  smsSegments,
  timeline,
  unknownMergeFields,
} from '@/lib/sequences';

const NO_RULES: SequenceExitRulesDto = { stop_on_reply: true, stop_on_statuses: [], stop_on_call_answered: false };
const ACTIVE = new Set(['pending', 'running', 'waiting']);
/** A representative seller, so the `/` picker previews read like a real send. */
const SAMPLE_MERGE_VALUES = sampleMergeFields(null);

function blankStep(type: SequenceStepDto['type']): SequenceStepDto {
  switch (type) {
    case 'sms':
      return { type: 'sms', body: '' };
    case 'wait':
      return { type: 'wait', days: 2, hours: 0 };
    case 'task':
      return { type: 'task', title: '', due_in_days: 1 };
    case 'status':
      return { type: 'status', status: '' };
    case 'agent':
      return { type: 'agent', goal: '', allowed: ['send_sms', 'create_task'] };
  }
}

const NO_ROUTING: SequenceOnCompleteDto = { mode: 'none', sequence_id: null, candidate_ids: [], also_when_stopped: false };

/** Something the server would reject; shown inline so Save is never a surprise. */
function stepProblem(step: SequenceStepDto): string | null {
  switch (step.type) {
    case 'sms': {
      const body = step.body?.trim() ?? '';
      if (!body && !step.template_id) return 'Write the message or pick a template.';
      if ([...body].length > SMS_MAX_CHARS) return `Over ${SMS_MAX_CHARS} characters.`;
      const unknown = unknownMergeFields(body);
      return unknown.length ? `Unknown merge field {${unknown[0]}}.` : null;
    }
    case 'wait':
      return (step.days ?? 0) * 1440 + (step.hours ?? 0) * 60 + (step.minutes ?? 0) < 1 ? 'A wait needs a duration.' : null;
    case 'task':
      return step.title.trim() ? null : 'Give the task a title.';
    case 'status':
      return step.status.trim() ? null : 'Which status?';
    case 'agent':
      if (step.goal.trim().length < 10) return 'Tell the agent what this step is for (at least 10 characters).';
      return step.allowed.length ? null : 'Allow the agent at least one thing to do.';
  }
}

export default function SequenceBuilderPage() {
  const { authed } = useSoftphone();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? 'new';
  const isNew = id === 'new';

  const [sequence, setSequence] = useState<SequenceDto | null>(null);
  const [runs, setRuns] = useState<SequenceRunDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [loaded, setLoaded] = useState(isNew);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [aiNote, setAiNote] = useState<{ model: string; warnings: string[] } | null>(null);

  // Builder state — the draft being edited, independent of what is saved.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<SequenceStepDto[]>([blankStep('sms')]);
  const [rules, setRules] = useState<SequenceExitRulesDto>(NO_RULES);
  const [routing, setRouting] = useState<SequenceOnCompleteDto>(NO_ROUTING);
  /** The other live sequences, for the routing picker. */
  const [others, setOthers] = useState<SequenceDto[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const applySequence = useCallback((s: SequenceDto) => {
    setSequence(s);
    setName(s.name);
    setDescription(s.description ?? '');
    setSteps(s.steps.length ? s.steps : [blankStep('sms')]);
    setRules(s.exit_rules ?? { ...NO_RULES, stop_on_reply: false });
    setRouting(s.on_complete ?? NO_ROUTING);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.getSequence(id);
      applySequence(r.sequence);
      setRuns(r.runs);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError((err as Error).message);
    } finally {
      setLoaded(true);
    }
  }, [id, applySequence]);

  useEffect(() => {
    if (!authed) return;
    api
      .listMessageTemplates()
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined);
    api
      .listSequences()
      .then((r) => setOthers(r.sequences.filter((s) => s.id !== id)))
      .catch(() => undefined);
    if (!isNew) void load();
  }, [authed, isNew, load]);

  // A draft parked by "Draft with AI" pre-fills a new sequence, once.
  useEffect(() => {
    if (!isNew) return;
    try {
      const raw = window.sessionStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return;
      window.sessionStorage.removeItem(DRAFT_STORAGE_KEY);
      const r = JSON.parse(raw) as SequenceDraftResultDto;
      setName(r.draft.name);
      setDescription(r.draft.description);
      setSteps(r.draft.steps);
      setRules(r.draft.exit_rules);
      setAiNote({ model: r.model, warnings: r.warnings });
      setDirty(true);
    } catch {
      /* no draft, or an unreadable one: start empty */
    }
  }, [isNew]);

  // Refresh the run table while leads are moving through the sequence.
  useEffect(() => {
    if (!authed || isNew || !runs.some((r) => ACTIVE.has(r.status))) return;
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [authed, isNew, runs, load]);

  const problems = useMemo(() => steps.map(stepProblem), [steps]);
  const endsWithWait = steps.length > 0 && steps[steps.length - 1]!.type === 'wait';
  const hasAction = steps.some((s) => s.type !== 'wait');
  const routingProblem =
    routing.mode === 'fixed' && !routing.sequence_id ? 'Pick the sequence to continue in.' : null;
  const canSave =
    name.trim().length > 0 &&
    steps.length > 0 &&
    hasAction &&
    !endsWithWait &&
    problems.every((p) => p === null) &&
    !routingProblem &&
    !saving;
  const activeRuns = runs.filter((r) => ACTIVE.has(r.status)).length;

  const update = (i: number, next: SequenceStepDto) => {
    setSteps((prev) => prev.map((s, j) => (j === i ? next : s)));
    setDirty(true);
  };
  const move = (i: number, dir: -1 | 1) => {
    setSteps((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
    setDirty(true);
  };
  const remove = (i: number) => {
    setSteps((prev) => prev.filter((_, j) => j !== i));
    setDirty(true);
  };
  const add = (type: SequenceStepDto['type']) => {
    setSteps((prev) => {
      // A message after a message reads better with a wait between them.
      const last = prev[prev.length - 1];
      const spacer = type === 'sms' && last && last.type !== 'wait' && prev.length > 0 ? [blankStep('wait')] : [];
      return [...prev, ...spacer, blankStep(type)];
    });
    setDirty(true);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        description: description.trim() || null,
        steps: steps.map(cleanStep),
        exit_rules: rules,
        on_complete: routing.mode === 'none' ? null : routing,
      };
      if (isNew) {
        const r = await api.createSequence({ ...input, enabled: true });
        setFlash('Sequence saved. Enroll leads to start it.');
        router.replace(`/sequences/${r.sequence.id}`);
      } else {
        const r = await api.updateSequence(id, input);
        applySequence(r.sequence);
        setFlash('Saved.');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'runs_active') {
        setError(err.message || 'Leads are still in this sequence; unenroll them before changing the steps.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    if (!sequence) return;
    try {
      const r = await api.updateSequence(sequence.id, { enabled });
      setSequence(r.sequence);
      setFlash(enabled ? 'Sequence on. Parked leads continue at their next step.' : 'Sequence paused. Nothing sends until it is back on.');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /**
   * A number enrolled as a bare phone just became somebody: name every run on
   * that number rather than re-reading the whole sequence.
   */
  const nameRunLead = (phone: string | null, contact: ContactDto) => {
    if (!phone) return;
    const key = phone.replace(/\D/g, '');
    setRuns((prev) =>
      prev.map((r) => (r.phone?.replace(/\D/g, '') === key ? { ...r, lead_name: contact.display_name } : r)),
    );
  };

  const stopRun = async (run: SequenceRunDto) => {
    if (!sequence || !run.lead_id) return;
    try {
      await api.unenrollFromSequence(sequence.id, [run.lead_id]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const archive = async () => {
    if (!sequence) return;
    const ok = window.confirm(
      `Archive "${sequence.name}"? ${activeRuns > 0 ? `${activeRuns} lead${activeRuns === 1 ? '' : 's'} still in it will be stopped.` : 'It disappears from the list; history is kept.'}`,
    );
    if (!ok) return;
    try {
      await api.archiveSequence(sequence.id);
      router.push('/sequences');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const tl = timeline(steps);
  const span = durationMinutes(steps);

  return (
    <>
      <TopBar
        title={isNew ? 'New sequence' : sequence?.name || 'Sequence'}
        subtitle={
          isNew
            ? 'Build it, then enroll leads'
            : sequence
              ? `${sequence.stats.active} in flight · ${sequence.stats.replied} replied · ${sequence.stats.completed} finished`
              : 'Loading…'
        }
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <Link href="/sequences" style={{ font: '600 12px/1 Inter', color: 'var(--muted)' }}>
            ← All sequences
          </Link>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {sequence && (
              <span className="flex items-center gap-2" style={{ font: '600 12px/1 Inter', color: 'var(--muted)' }}>
                {sequence.enabled ? 'On' : 'Paused'}
                <Toggle on={sequence.enabled} onChange={(v) => void setEnabled(v)} label="Enabled" />
              </span>
            )}
            {sequence && (
              <Button tone="dark" onClick={() => setEnrolling(true)} disabled={!sequence.enabled} title={sequence.enabled ? undefined : 'Turn the sequence on first'}>
                <Icon name="users" size={14} />
                Enroll leads
              </Button>
            )}
            <Button tone="accent" onClick={() => void save()} disabled={!canSave || (!dirty && !isNew)}>
              <Icon name="check" size={14} />
              {saving ? 'Saving…' : isNew ? 'Save sequence' : 'Save changes'}
            </Button>
          </span>
        </div>

        {forbidden && <Notice tone="warn">Sequences are manager-level. Ask an admin for the manager role.</Notice>}
        {flash && (
          <Notice className="mb-3" action={<Button tone="quiet" onClick={() => setFlash(null)}>Dismiss</Button>}>
            {flash}
          </Notice>
        )}
        {error && (
          <Notice tone="error" className="mb-3" action={<Button tone="quiet" onClick={() => setError(null)}>Dismiss</Button>}>
            {error}
          </Notice>
        )}
        {aiNote && (
          <Notice className="mb-3" tone={aiNote.warnings.length ? 'warn' : 'info'} action={<Button tone="quiet" onClick={() => setAiNote(null)}>Got it</Button>}>
            Drafted by {aiNote.model}. Read every message before saving — you are the sender.
            {aiNote.warnings.length > 0 && ` Heads-up: ${aiNote.warnings.join('; ')}.`}
          </Notice>
        )}
        {!isNew && activeRuns > 0 && (
          <Notice className="mb-3">
            {activeRuns} {activeRuns === 1 ? 'lead is' : 'leads are'} moving through this sequence. Name, description and exit rules can
            change any time; the steps are locked until they finish or are unenrolled.
          </Notice>
        )}

        {!loaded ? (
          <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>Loading…</p>
        ) : (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))' }}>
            {/* ── Left: definition ─────────────────────────────────────── */}
            <div className="flex min-w-0 flex-col gap-4">
              <Card className="flex flex-col gap-3">
                <SectionTitle icon={<Icon name="template" size={15} />}>Sequence</SectionTitle>
                <Labeled label="Name">
                  <Input
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Post-call follow-up"
                    autoFocus={isNew}
                  />
                </Labeled>
                <Labeled label="Description (optional)">
                  <Input
                    value={description}
                    onChange={(e) => {
                      setDescription(e.target.value);
                      setDirty(true);
                    }}
                    placeholder="Who this is for and what it does"
                  />
                </Labeled>
              </Card>

              <Card className="flex flex-col gap-3">
                <SectionTitle icon={<Icon name="forward" size={15} />}>Steps</SectionTitle>
                {steps.length === 0 && (
                  <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>Add a first message below.</p>
                )}
                {steps.map((step, i) => (
                  <StepEditor
                    key={i}
                    index={i}
                    step={step}
                    problem={problems[i] ?? null}
                    templates={templates}
                    locked={activeRuns > 0}
                    isFirst={i === 0}
                    isLast={i === steps.length - 1}
                    onChange={(next) => update(i, next)}
                    onMove={(dir) => move(i, dir)}
                    onRemove={() => remove(i)}
                  />
                ))}
                {endsWithWait && <Notice tone="warn">A sequence cannot end with a wait — add a step after it or remove it.</Notice>}
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button tone="ghost" onClick={() => add('sms')} disabled={activeRuns > 0}>
                    <Icon name="msg" size={13} />
                    Text
                  </Button>
                  <Button tone="ghost" onClick={() => add('wait')} disabled={activeRuns > 0}>
                    <Icon name="clock" size={13} />
                    Wait
                  </Button>
                  <Button tone="ghost" onClick={() => add('task')} disabled={activeRuns > 0}>
                    <Icon name="check" size={13} />
                    Task
                  </Button>
                  <Button tone="ghost" onClick={() => add('status')} disabled={activeRuns > 0}>
                    <Icon name="pin" size={13} />
                    Status
                  </Button>
                  <Button tone="ghost" onClick={() => add('agent')} disabled={activeRuns > 0}>
                    <Icon name="sparkle" size={13} />
                    AI agent
                  </Button>
                </div>
              </Card>

              <Card className="flex flex-col gap-3">
                <SectionTitle icon={<Icon name="forward" size={15} />}>When finished…</SectionTitle>
                <Select
                  value={routing.mode}
                  onChange={(e) => {
                    setRouting({ ...routing, mode: e.target.value as SequenceOnCompleteDto['mode'] });
                    setDirty(true);
                  }}
                >
                  <option value="none">The lead leaves the plan</option>
                  <option value="fixed">Continue in one specific sequence</option>
                  <option value="smart">Let AI pick the next sequence from the lead&apos;s history</option>
                </Select>
                {routing.mode === 'fixed' && (
                  <Labeled label="Next sequence">
                    <Select
                      value={routing.sequence_id ?? ''}
                      onChange={(e) => {
                        setRouting({ ...routing, sequence_id: e.target.value || null });
                        setDirty(true);
                      }}
                    >
                      <option value="">Pick a sequence…</option>
                      {others.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.enabled ? '' : ' (paused)'}
                        </option>
                      ))}
                    </Select>
                  </Labeled>
                )}
                {routing.mode === 'smart' && (
                  <div className="flex flex-col gap-1.5">
                    <Eyebrow>Candidates (none ticked = any enabled sequence)</Eyebrow>
                    {others.length === 0 && (
                      <p style={{ font: '400 12px/1.5 var(--font-sans)', color: 'var(--muted)' }}>No other sequences yet.</p>
                    )}
                    {others.map((s) => {
                      const on = routing.candidate_ids.includes(s.id);
                      return (
                        <label key={s.id} className="flex items-start gap-2" style={{ font: '500 12.5px/1.3 var(--font-sans)' }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={(e) => {
                              setRouting({
                                ...routing,
                                candidate_ids: e.target.checked
                                  ? [...routing.candidate_ids, s.id]
                                  : routing.candidate_ids.filter((x) => x !== s.id),
                              });
                              setDirty(true);
                            }}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span>{s.name}</span>
                            {s.description && (
                              <span className="truncate" style={{ font: '400 11.5px/1.4 var(--font-sans)', color: 'var(--muted)' }}>{s.description}</span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                    <p style={{ font: '400 11.5px/1.5 var(--font-sans)', color: 'var(--muted)' }}>
                      The router reads the lead&apos;s texts, calls and the plans they have been through, then picks the best fit
                      or leaves them out. A sequence&apos;s description is what it matches on, so write one. A lead is never sent
                      back into a plan they already ran.
                    </p>
                  </div>
                )}
                {routing.mode !== 'none' && (
                  <label className="flex items-center gap-2" style={{ font: '500 12.5px/1.3 var(--font-sans)' }}>
                    <input
                      type="checkbox"
                      checked={routing.also_when_stopped}
                      onChange={(e) => {
                        setRouting({ ...routing, also_when_stopped: e.target.checked });
                        setDirty(true);
                      }}
                    />
                    Also route a lead whose run was stopped by a rule (a reply, a status). Off: a lead who answered waits for a person.
                  </label>
                )}
                {routingProblem && <Notice tone="warn">{routingProblem}</Notice>}
              </Card>

              <Card className="flex flex-col gap-3">
                <SectionTitle icon={<Icon name="x" size={15} />}>Stop when…</SectionTitle>
                <label className="flex items-center gap-2" style={{ font: '500 12.5px/1.3 Inter' }}>
                  <input
                    type="checkbox"
                    checked={rules.stop_on_reply}
                    onChange={(e) => {
                      setRules({ ...rules, stop_on_reply: e.target.checked });
                      setDirty(true);
                    }}
                  />
                  The lead replies (any inbound text after enrollment)
                </label>
                <label className="flex items-center gap-2" style={{ font: '500 12.5px/1.3 Inter' }}>
                  <input
                    type="checkbox"
                    checked={rules.stop_on_call_answered}
                    onChange={(e) => {
                      setRules({ ...rules, stop_on_call_answered: e.target.checked });
                      setDirty(true);
                    }}
                  />
                  A call with the lead is answered
                </label>
                <div className="flex flex-col gap-1.5">
                  <Eyebrow>The lead status becomes one of</Eyebrow>
                  <div className="flex flex-wrap gap-1.5">
                    {[...new Set([...COMMON_STOP_STATUSES, ...rules.stop_on_statuses])].map((s) => {
                      const on = rules.stop_on_statuses.includes(s);
                      return (
                        <button
                          key={s}
                          type="button"
                          onClick={() => {
                            setRules({
                              ...rules,
                              stop_on_statuses: on ? rules.stop_on_statuses.filter((x) => x !== s) : [...rules.stop_on_statuses, s],
                            });
                            setDirty(true);
                          }}
                          style={{
                            padding: '6px 10px',
                            borderRadius: 8,
                            border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
                            background: on ? 'var(--accent-soft)' : 'var(--panel)',
                            color: on ? 'var(--accent)' : 'var(--muted)',
                            font: '600 11px/1 Inter',
                            cursor: 'pointer',
                          }}
                        >
                          {s}
                        </button>
                      );
                    })}
                  </div>
                  <StatusAdder
                    onAdd={(s) => {
                      if (!rules.stop_on_statuses.includes(s)) {
                        setRules({ ...rules, stop_on_statuses: [...rules.stop_on_statuses, s] });
                        setDirty(true);
                      }
                    }}
                  />
                </div>
                <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
                  Rules are checked before every step, on fresh data. Opt-outs (STOP) always end the sequence; quiet hours
                  delay a text to the next allowed window instead of skipping it.
                </p>
              </Card>

              {sequence && (
                <div className="flex justify-end">
                  <Button tone="quiet" style={{ color: 'var(--red)' }} onClick={() => void archive()}>
                    <Icon name="x" size={13} />
                    Archive sequence
                  </Button>
                </div>
              )}
            </div>

            {/* ── Right: preview + runs ────────────────────────────────── */}
            <div className="flex min-w-0 flex-col gap-4">
              <Card className="flex flex-col gap-3">
                <SectionTitle icon={<Icon name="clock" size={15} />} right={<span style={{ font: '500 11.5px/1 Inter', color: 'var(--muted)' }}>{formatMinutes(span)} end to end</span>}>
                  Timeline
                </SectionTitle>
                {tl.length === 0 ? (
                  <EmptyState
                    compact
                    icon="clock"
                    title="Nothing scheduled yet"
                    hint="Add a step and the timeline lays out day by day, exactly as a lead will receive it."
                  />
                ) : (
                  <ol className="flex flex-col gap-2">
                    {tl.map((row) => (
                      <li key={row.index} className="flex items-start gap-3">
                        <span className="shrink-0 tabular-nums" style={{ font: '700 11px/1.4 Inter', color: 'var(--accent)', minWidth: 48 }}>
                          Day {row.day}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span style={{ font: '600 11px/1.4 Inter', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            {STEP_LABEL[row.step.type]}
                          </span>
                          <span className="block truncate" style={{ font: '400 12px/1.4 Inter' }}>
                            {describeStep(row.step)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>

              {sequence && (
                <Card padded={false} className="overflow-x-auto">
                  <div className="px-4 pt-4">
                    <SectionTitle icon={<Icon name="users" size={15} />} right={<span style={{ font: '500 11.5px/1 Inter', color: 'var(--muted)' }}>last {runs.length}</span>}>
                      Leads in this sequence
                    </SectionTitle>
                  </div>
                  <div className="pt-3">
                    <GridHead cols="minmax(160px, 1.5fr) 110px 70px 120px 90px" minWidth={600}>
                      <Eyebrow>Lead</Eyebrow>
                      <Eyebrow>Status</Eyebrow>
                      <Eyebrow>Step</Eyebrow>
                      <Eyebrow>Next / ended</Eyebrow>
                      <span />
                    </GridHead>
                    {runs.length === 0 && (
                      <EmptyState title="Nobody enrolled yet" hint="Enroll leads by phone number and the first text goes out right away (inside the send window)." />
                    )}
                    {runs.map((r) => (
                      <GridRow key={r.id} cols="minmax(160px, 1.5fr) 110px 70px 120px 90px" minWidth={600}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="flex min-w-0 flex-col gap-1">
                            <span className="truncate" style={{ font: '600 12.5px/1 Inter' }}>{r.lead_name || 'Unnamed lead'}</span>
                            <span className="flex min-w-0 items-center gap-1.5" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                              {r.phone ? <PhoneText e164={r.phone} size={18} /> : <span>—</span>}
                              {r.lead_status && <span className="truncate">· {r.lead_status}</span>}
                            </span>
                          </span>
                          {/* Enrolled by bare phone number: nobody has named them yet. */}
                          {!r.lead_name && r.phone && (
                            <AddContactButton
                              size="icon"
                              phone={r.phone}
                              onCreated={(contact) => nameRunLead(r.phone, contact)}
                            />
                          )}
                        </span>
                        <span className="flex flex-col gap-1">
                          <StatusMarker color={RUN_STATUS_COLOR[r.status] ?? 'var(--muted-2)'} label={r.status} />
                          {r.stopped_reason && (
                            <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>{r.stopped_reason}</span>
                          )}
                          {r.routed_reason && (
                            <span
                              className="truncate"
                              title={r.routed_reason}
                              style={{ font: '500 10.5px/1 var(--font-sans)', color: r.routed_run_id ? 'var(--accent)' : 'var(--muted-2)' }}
                            >
                              {r.routed_run_id ? 'routed on' : 'not routed'} · {r.routed_reason}
                            </span>
                          )}
                          {r.error && (
                            <span className="truncate" title={r.error} style={{ font: '500 10.5px/1 Inter', color: 'var(--red)' }}>{r.error}</span>
                          )}
                        </span>
                        <span className="tabular-nums" style={{ font: '500 12px/1 Inter' }}>
                          {r.step}/{r.step_count}
                        </span>
                        <span style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)' }} suppressHydrationWarning>
                          {r.status === 'waiting' && r.resume_at
                            ? relativeTime(r.resume_at, now ?? Date.now())
                            : r.finished_at
                              ? relativeTime(r.finished_at, now ?? Date.now())
                              : '—'}
                        </span>
                        {ACTIVE.has(r.status) ? (
                          <Button tone="quiet" style={{ color: 'var(--red)' }} onClick={() => void stopRun(r)}>
                            Stop
                          </Button>
                        ) : (
                          <span />
                        )}
                      </GridRow>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          </div>
        )}
      </div>

      {enrolling && sequence && (
        <EnrollModal
          sequence={sequence}
          onClose={() => setEnrolling(false)}
          onEnrolled={(msg) => {
            setFlash(msg);
            setEnrolling(false);
            void load();
          }}
        />
      )}
    </>
  );
}

/** Drop UI-only noise (empty template ids, zero waits) before sending. */
function cleanStep(step: SequenceStepDto): SequenceStepDto {
  switch (step.type) {
    case 'sms': {
      const body = step.body?.trim();
      return body ? { type: 'sms', body } : { type: 'sms', ...(step.template_id ? { template_id: step.template_id } : {}) };
    }
    case 'wait':
      return { type: 'wait', days: step.days || 0, hours: step.hours || 0, ...(step.minutes ? { minutes: step.minutes } : {}) };
    case 'task':
      return { type: 'task', title: step.title.trim(), due_in_days: step.due_in_days };
    case 'status':
      return { type: 'status', status: step.status.trim() };
    case 'agent':
      return { type: 'agent', goal: step.goal.trim(), allowed: [...new Set(step.allowed)] };
  }
}

function StepEditor({
  index,
  step,
  problem,
  templates,
  locked,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  step: SequenceStepDto;
  problem: string | null;
  templates: MessageTemplateDto[];
  locked: boolean;
  isFirst: boolean;
  isLast: boolean;
  onChange: (next: SequenceStepDto) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const insertField = (field: string) => {
    if (step.type !== 'sms') return;
    const el = bodyRef.current;
    const body = step.body ?? '';
    const token = `{${field}}`;
    if (!el) {
      onChange({ ...step, body: body + token });
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    onChange({ ...step, body: next });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const seg = step.type === 'sms' ? smsSegments(step.body ?? '') : null;

  return (
    <div className="flex flex-col gap-2 p-3" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--bg)' }}>
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-5 min-w-5 items-center justify-center px-1.5"
          style={{ borderRadius: 6, background: 'var(--dark-1)', color: '#fff', font: '700 10px/1 Inter' }}
        >
          {index + 1}
        </span>
        <span style={{ font: '700 12px/1 Inter', letterSpacing: '0.04em', textTransform: 'uppercase' }}>{STEP_LABEL[step.type]}</span>
        <span className="ml-auto flex items-center gap-1">
          <IconButton label="Move up" disabled={locked || isFirst} onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label="Move down" disabled={locked || isLast} onClick={() => onMove(1)}>
            ↓
          </IconButton>
          <IconButton label="Remove step" disabled={locked} onClick={onRemove}>
            <Icon name="x" size={12} />
          </IconButton>
        </span>
      </div>

      {step.type === 'sms' && (
        <>
          {/* MergeTextArea (not ui.TextArea) because the `/` picker and the
              merge-field chips both insert at the caret; same FIELD look. */}
          <MergeTextArea
            textareaRef={bodyRef}
            value={step.body ?? ''}
            onChange={(body) => onChange({ ...step, body })}
            values={SAMPLE_MERGE_VALUES}
            fields={MERGE_FIELDS}
            disabled={locked}
            rows={3}
            aria-label={`Step ${index + 1} message`}
            placeholder="Hi {first_name}, this is {rep_name} with {company} about {address}. Still open to an offer? Reply STOP to opt out."
          />
          <div className="flex flex-wrap items-center gap-1.5">
            <MergeFieldHelp fields={MERGE_FIELDS} values={SAMPLE_MERGE_VALUES} />
            {MERGE_FIELDS.map((f) => (
              <button
                key={f}
                type="button"
                disabled={locked}
                onClick={() => insertField(f)}
                title={`Insert {${f}}`}
                style={{
                  padding: '4px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--line)',
                  background: 'var(--panel)',
                  color: 'var(--text)',
                  font: '600 10.5px/1 Inter',
                  cursor: locked ? 'not-allowed' : 'pointer',
                }}
              >
                {`{${f}}`}
              </button>
            ))}
            <span className="ml-auto tabular-nums" style={{ font: '500 11px/1 Inter', color: seg && seg.chars > AI_SMS_MAX_CHARS ? 'var(--amber)' : 'var(--muted)' }}>
              {seg?.chars ?? 0} chars · {seg?.segments ?? 0} {seg?.segments === 1 ? 'segment' : 'segments'}
              {seg?.encoding === 'ucs2' ? ' · unicode' : ''}
            </span>
          </div>
          {templates.length > 0 && (
            <Select
              value=""
              disabled={locked}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value);
                if (t) onChange({ type: 'sms', body: t.body, template_id: t.id });
              }}
            >
              <option value="">Start from a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.category ? ` · ${t.category}` : ''}
                </option>
              ))}
            </Select>
          )}
        </>
      )}

      {step.type === 'wait' && (
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Days">
            <Input
              type="number"
              min={0}
              max={90}
              disabled={locked}
              value={step.days ?? 0}
              onChange={(e) => onChange({ ...step, days: Math.max(0, Number(e.target.value) || 0) })}
              style={{ width: 90 }}
            />
          </Labeled>
          <Labeled label="Hours">
            <Input
              type="number"
              min={0}
              max={23}
              disabled={locked}
              value={step.hours ?? 0}
              onChange={(e) => onChange({ ...step, hours: Math.max(0, Number(e.target.value) || 0) })}
              style={{ width: 90 }}
            />
          </Labeled>
          <span className="pb-2.5" style={{ font: '400 11.5px/1.3 Inter', color: 'var(--muted)' }}>
            then continue. A text that lands in quiet hours waits for the next window.
          </span>
        </div>
      )}

      {step.type === 'task' && (
        <div className="flex flex-wrap items-end gap-2">
          <Labeled label="Task for the lead's rep" className="flex-1">
            <Input
              disabled={locked}
              value={step.title}
              placeholder="Call {first_name} about {address}"
              onChange={(e) => onChange({ ...step, title: e.target.value })}
            />
          </Labeled>
          <Labeled label="Due in days">
            <Input
              type="number"
              min={0}
              max={365}
              disabled={locked}
              value={step.due_in_days}
              onChange={(e) => onChange({ ...step, due_in_days: Math.max(0, Number(e.target.value) || 0) })}
              style={{ width: 90 }}
            />
          </Labeled>
        </div>
      )}

      {step.type === 'status' && (
        <Labeled label="Set the lead status to">
          <Input disabled={locked} value={step.status} placeholder="nurture" onChange={(e) => onChange({ ...step, status: e.target.value })} />
        </Labeled>
      )}

      {step.type === 'agent' && (
        <div className="flex flex-col gap-2">
          <Labeled label="What this step is for">
            <TextArea
              disabled={locked}
              rows={2}
              value={step.goal}
              placeholder="Re-engage a seller who went quiet after the first call. If they already answered or said no, do nothing and leave it to the rep."
              onChange={(e) => onChange({ ...step, goal: e.target.value })}
            />
          </Labeled>
          <div className="flex flex-col gap-1.5">
            <Eyebrow>The agent may</Eyebrow>
            {AGENT_CAPABILITIES.map((c) => {
              const on = step.allowed.includes(c.key);
              return (
                <label key={c.key} className="flex items-start gap-2" style={{ font: '500 12.5px/1.3 var(--font-sans)' }}>
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={on}
                    onChange={(e) =>
                      onChange({
                        ...step,
                        allowed: e.target.checked ? [...step.allowed, c.key] : step.allowed.filter((k) => k !== c.key),
                      })
                    }
                  />
                  <span>
                    {c.label}
                    <span style={{ font: '400 11.5px/1.4 var(--font-sans)', color: 'var(--muted)' }}> · {c.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <p style={{ font: '400 11.5px/1.5 var(--font-sans)', color: 'var(--muted)' }}>
            When the lead reaches this step the agent reads their texts, calls and the plans they have been through, then
            does at most one of each thing you allow, or nothing. Every text obeys the same opt-out, quiet-hours and
            length rules as a written step. The decision and its reason land in the run history.
          </p>
        </div>
      )}

      {problem && <span style={{ font: '500 11.5px/1.3 Inter', color: 'var(--amber)' }}>{problem}</span>}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-6 w-6 items-center justify-center disabled:cursor-not-allowed disabled:opacity-35"
      style={{ borderRadius: 6, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer', font: '600 12px/1 Inter' }}
    >
      {children}
    </button>
  );
}

function StatusAdder({ onAdd }: { onAdd: (status: string) => void }) {
  const [value, setValue] = useState('');
  const commit = () => {
    const s = value.trim().toLowerCase().replace(/\s+/g, '_');
    if (!s) return;
    onAdd(s);
    setValue('');
  };
  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={value}
        placeholder="another status…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
        style={{ maxWidth: 220 }}
      />
      <Button tone="ghost" onClick={commit} disabled={!value.trim()}>
        Add
      </Button>
    </div>
  );
}

/**
 * Enrollment by phone number: the numbers are resolved to contacts and leads
 * on the server, so the person enrolling does not need ids. Unknown numbers
 * are reported back rather than silently creating contacts.
 */
function EnrollModal({
  sequence,
  onClose,
  onEnrolled,
}: {
  sequence: SequenceDto;
  onClose: () => void;
  onEnrolled: (message: string) => void;
}) {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ enrolled: number; already: number; skipped: Array<{ ref: string; reason: string }> } | null>(null);

  const phones = useMemo(
    () => [...new Set(raw.split(/[\n,;]+/).map((s) => s.trim()).filter((s) => s.length >= 3))],
    [raw],
  );

  const submit = async () => {
    if (phones.length === 0 || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.enrollInSequence(sequence.id, { phones: phones.slice(0, 500) });
      setResult({ enrolled: r.enrolled, already: r.already_enrolled, skipped: r.skipped_details });
      if (r.skipped === 0) {
        onEnrolled(`${r.enrolled} enrolled${r.already_enrolled ? `, ${r.already_enrolled} already in the sequence` : ''}.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reasonText: Record<string, string> = {
    unknown_phone: 'no contact with this number',
    invalid_phone: 'not a valid number',
    lead_not_found: 'lead not found',
    contact_not_found: 'contact not found',
  };

  return (
    <Modal title={`Enroll leads in “${sequence.name}”`} onClose={onClose} width={560}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Labeled label="Phone numbers — one per line or comma-separated">
          <TextArea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            autoFocus
            placeholder={'(214) 555-0142\n+1 469 555 0199'}
          />
        </Labeled>
        <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          {phones.length} {phones.length === 1 ? 'number' : 'numbers'}
          {phones.length > 500 ? ' — only the first 500 are sent' : ''}. Each must already be a contact; the newest
          lead for that contact is enrolled (or a lead is created for the contact). The first text goes out now,
          inside the send window, and a lead is never enrolled in the same sequence twice.
        </p>
        {err && <Notice tone="error">{err}</Notice>}
        {result && result.skipped.length > 0 && (
          <Notice tone="warn">
            {result.enrolled} enrolled{result.already ? `, ${result.already} already in` : ''}, {result.skipped.length} skipped:
            <ul className="mt-1 list-disc pl-4">
              {result.skipped.slice(0, 20).map((s) => (
                <li key={`${s.ref}:${s.reason}`}>
                  {s.ref} — {reasonText[s.reason] ?? s.reason}
                </li>
              ))}
              {result.skipped.length > 20 && <li>…and {result.skipped.length - 20} more</li>}
            </ul>
          </Notice>
        )}
        <div className="flex items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={phones.length === 0 || busy}>
            {busy ? 'Enrolling…' : `Enroll ${phones.length || ''}`.trim()}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            {result ? 'Done' : 'Cancel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
