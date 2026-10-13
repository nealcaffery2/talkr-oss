'use client';

/**
 * Tasks (design 1c): my open follow-ups grouped by urgency — overdue first,
 * then today, then later, then undated — a complete button on every row, a
 * link back to the lead, and a composer for a quick manual task. Reps see
 * their own + unassigned tasks; managers see the whole org.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api, type TaskDto } from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Button, Card, EmptyState, Eyebrow, Input, Notice } from '@/components/ui';

type Bucket = 'overdue' | 'today' | 'later' | 'undated';

const BUCKETS: Bucket[] = ['overdue', 'today', 'later', 'undated'];

const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  later: 'Later',
  undated: 'No due date',
};

const BUCKET_COLOR: Record<Bucket, string> = {
  overdue: 'var(--red)',
  today: 'var(--accent)',
  later: 'var(--muted)',
  undated: 'var(--muted-2)',
};

function bucketOf(task: TaskDto, now: number): Bucket {
  if (!task.due_at) return 'undated';
  const due = new Date(task.due_at);
  if (due.getTime() < now) return 'overdue';
  return due.toDateString() === new Date(now).toDateString() ? 'today' : 'later';
}

function dueLabel(task: TaskDto, now: number): string {
  if (!task.due_at) return '';
  const due = new Date(task.due_at);
  const diff = due.getTime() - now;
  const hours = Math.round(Math.abs(diff) / 3_600_000);
  if (diff < 0) {
    if (hours < 1) return 'just now';
    if (hours < 48) return `${hours}h overdue`;
    return `${Math.round(hours / 24)}d overdue`;
  }
  if (due.toDateString() === new Date(now).toDateString()) {
    return due.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  if (hours < 48) return `in ${hours}h`;
  return due.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function TasksPage() {
  const { authed } = useSoftphone();
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.listTasks();
      setTasks(res.tasks);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (authed) void load();
  }, [authed, load]);

  async function run(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function createQuick() {
    const text = title.trim();
    if (!text) return;
    await run('new', async () => {
      await api.createTask({ title: text, ...(due ? { due_at: new Date(due).toISOString() } : {}) });
      setTitle('');
      setDue('');
    });
  }

  const open = useMemo(() => tasks.filter((t) => t.status === 'open'), [tasks]);
  const closed = useMemo(() => tasks.filter((t) => t.status !== 'open'), [tasks]);

  const groups = useMemo(() => {
    const at = now ?? Date.now();
    const out: Record<Bucket, TaskDto[]> = { overdue: [], today: [], later: [], undated: [] };
    for (const t of open) out[bucketOf(t, at)].push(t);
    const byDue = (a: TaskDto, b: TaskDto) => (a.due_at ?? '').localeCompare(b.due_at ?? '');
    out.overdue.sort(byDue);
    out.today.sort(byDue);
    out.later.sort(byDue);
    return out;
  }, [open, now]);

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const overdue = groups.overdue.length;
  const subtitle =
    open.length === 0
      ? 'Nothing open'
      : `${open.length} open${overdue > 0 ? ` · ${overdue} overdue` : ''}${
          groups.today.length > 0 ? ` · ${groups.today.length} due today` : ''
        }`;

  return (
    <>
      <TopBar title="Tasks" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}

          {/* ── Composer ──────────────────────────────────────────────── */}
          <Card className="flex flex-wrap items-center gap-2.5" style={{ padding: 12 }}>
            <Icon name="plus" size={15} style={{ color: 'var(--muted-2)', marginLeft: 4 }} />
            <Input
              className="flex-1"
              style={{ border: 'none', background: 'transparent', padding: '8px 4px', minWidth: 180 }}
              placeholder="Add a task — call back, send comps, check title…"
              aria-label="New task"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createQuick();
              }}
            />
            <Input
              type="datetime-local"
              aria-label="Due"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              style={{ padding: '7px 10px', font: '500 11.5px/1 Inter', color: due ? 'var(--text)' : 'var(--muted)' }}
            />
            <Button tone="accent" onClick={() => void createQuick()} disabled={title.trim().length === 0 || busy === 'new'}>
              {busy === 'new' ? 'Adding…' : 'Add task'}
            </Button>
          </Card>

          {/* ── Open, by urgency ──────────────────────────────────────── */}
          {open.length === 0 && (
            <Card padded={false}>
              <EmptyState
                title="No open tasks"
                hint="Workflows add follow-ups here automatically; anything you type above lands here too."
              />
            </Card>
          )}

          {BUCKETS.map((bucket) => {
            const list = groups[bucket];
            if (list.length === 0) return null;
            return (
              <Card key={bucket} padded={false}>
                <div
                  className="flex items-center gap-2.5 px-4 py-2.5"
                  style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}
                >
                  <span style={{ width: 6, height: 6, background: BUCKET_COLOR[bucket] }} aria-hidden />
                  <Eyebrow>{BUCKET_LABEL[bucket]}</Eyebrow>
                  <span className="ml-auto" style={{ font: '600 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                    {list.length}
                  </span>
                </div>
                {list.map((t, i) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    now={now ?? Date.now()}
                    bucket={bucket}
                    busy={busy === t.id}
                    last={i === list.length - 1}
                    onComplete={() => void run(t.id, () => api.completeTask(t.id))}
                    onCancel={() => void run(t.id, () => api.cancelTask(t.id))}
                  />
                ))}
              </Card>
            );
          })}

          {/* ── Completed ─────────────────────────────────────────────── */}
          {closed.length > 0 && (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setShowDone((v) => !v)}
                className="inline-flex items-center gap-1.5 self-start"
                style={{
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  font: '600 11.5px/1 Inter',
                  color: 'var(--muted)',
                  padding: '4px 2px',
                }}
              >
                <Icon name={showDone ? 'chevron-down' : 'chevron-right'} size={13} />
                {showDone ? 'Hide' : 'Show'} completed · {closed.length}
              </button>
              {showDone && (
                <Card padded={false}>
                  {closed.map((t, i) => (
                    <div
                      key={t.id}
                      className="flex items-center gap-3 px-4 py-2.5"
                      style={{ borderBottom: i === closed.length - 1 ? 'none' : '1px solid var(--panel-2)', opacity: 0.65 }}
                    >
                      <span
                        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
                        style={{ background: t.status === 'completed' ? 'var(--green)' : 'var(--line)', color: '#fff' }}
                        aria-hidden
                      >
                        <Icon name={t.status === 'completed' ? 'check' : 'x'} size={11} />
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ font: '500 12.5px/1 Inter', textDecoration: 'line-through' }}
                      >
                        {t.title}
                      </span>
                      <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)', textTransform: 'capitalize' }}>
                        {t.status}
                      </span>
                      {t.completed_at && (
                        <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                          {new Date(t.completed_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                        </span>
                      )}
                    </div>
                  ))}
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TaskRow({
  task,
  now,
  bucket,
  busy,
  last,
  onComplete,
  onCancel,
}: {
  task: TaskDto;
  now: number;
  bucket: Bucket;
  busy: boolean;
  last: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [hover, setHover] = useState(false);
  const meta = [task.note, task.source === 'workflow' ? 'From workflow' : null].filter(Boolean).join(' · ');
  return (
    <div
      className="flex items-center gap-3 px-4 py-3"
      style={{ borderBottom: last ? 'none' : '1px solid var(--panel-2)', opacity: busy ? 0.5 : 1 }}
    >
      <button
        type="button"
        onClick={onComplete}
        disabled={busy}
        title="Mark complete"
        aria-label={`Complete ${task.title}`}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors"
        style={{
          border: `1.5px solid ${hover ? 'var(--green)' : 'var(--line)'}`,
          background: 'var(--panel)',
          color: hover ? 'var(--green)' : 'transparent',
          cursor: 'pointer',
        }}
      >
        <Icon name="check" size={11} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate" style={{ font: '600 12.5px/1 Inter' }}>
          {task.title}
        </span>
        {meta && (
          <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
            {meta}
          </span>
        )}
      </div>

      {task.due_at && (
        <span
          className="inline-flex shrink-0 items-center gap-1.5"
          style={{ font: '600 11px/1 Inter', color: BUCKET_COLOR[bucket] }}
        >
          <Icon name="clock" size={12} />
          {dueLabel(task, now)}
        </span>
      )}

      {task.lead_id && (
        <Link
          href={`/dialer?lead=${task.lead_id}`}
          className="inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5"
          style={{ border: '1px solid var(--line)', borderRadius: 8, font: '600 11px/1 Inter', color: 'var(--text)' }}
        >
          <Icon name="phone" size={12} style={{ color: 'var(--accent)' }} />
          Open lead
        </Link>
      )}

      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        title="Cancel task"
        aria-label={`Cancel ${task.title}`}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center"
        style={{ border: 'none', background: 'transparent', color: 'var(--muted-2)', cursor: 'pointer', borderRadius: 8 }}
      >
        <Icon name="x" size={13} />
      </button>
    </div>
  );
}
