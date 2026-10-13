'use client';

/**
 * Workflows (design 1c): the automations list with enabled toggles and run
 * counts, a structured builder (trigger, condition rows, ordered action rows
 * with per-type fields) in a modal, and a run-history drawer. Manager-level
 * (`workflows.manage`); reps see a clear permission message.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type MessageTemplateDto,
  type WorkflowActionDto,
  type WorkflowConditionRow,
  type WorkflowDto,
  type WorkflowRunDto,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  Input,
  Labeled,
  Modal,
  Notice,
  Select,
  StatusMarker,
  Toggle,
} from '@/components/ui';

const TRIGGERS = [
  { value: 'call.completed', label: 'Call completed' },
  { value: 'call.missed', label: 'Missed inbound call' },
  { value: 'disposition.created', label: 'Disposition set' },
  { value: 'message.received', label: 'SMS received' },
  { value: 'lead.created', label: 'Lead created' },
  { value: 'no_contact_for_days', label: 'No contact for N days' },
];

const CONDITION_FIELDS = [
  'call.status',
  'call.direction',
  'call.duration_seconds',
  'call.answered',
  'call.failure_class',
  'disposition.slug',
  'disposition.name',
  'disposition.note',
  'message.body',
  'message.from',
  'message.to',
  'lead.status',
  'lead.source',
  'lead.assigned_user_id',
  'lead.external_item_id',
  'contact.display_name',
];

const OPS = [
  { value: 'eq', label: 'is' },
  { value: 'neq', label: 'is not' },
  { value: 'gt', label: 'greater than' },
  { value: 'lt', label: 'less than' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of' },
  { value: 'is_null', label: 'is empty' },
  { value: 'not_null', label: 'is set' },
];

const ACTION_TYPES = [
  { value: 'send_sms', label: 'Send SMS template' },
  { value: 'create_task', label: 'Create task' },
  { value: 'update_lead_status', label: 'Update lead status' },
  { value: 'assign_lead', label: 'Assign lead' },
  { value: 'emit_webhook', label: 'Emit webhook' },
];

const RUN_COLOR: Record<string, string> = {
  succeeded: 'var(--green)',
  failed: 'var(--red)',
  skipped: 'var(--amber)',
  running: 'var(--accent)',
};

function defaultAction(type: string): WorkflowActionDto {
  switch (type) {
    case 'send_sms':
      return { type, template_id: '' };
    case 'create_task':
      return { type, title: '', assign_to: 'lead_owner', due_in_hours: 24 };
    case 'update_lead_status':
      return { type, status: '' };
    case 'assign_lead':
      return { type, user_id: '' };
    default:
      return { type: 'emit_webhook' };
  }
}

function triggerLabel(w: WorkflowDto): string {
  const base = TRIGGERS.find((t) => t.value === w.trigger_type)?.label ?? w.trigger_type;
  return w.trigger_type === 'no_contact_for_days' ? `No contact for ${w.trigger_config.days ?? '?'} days` : base;
}

function actionSummary(a: WorkflowActionDto, templates: MessageTemplateDto[]): string {
  switch (a.type) {
    case 'send_sms':
      return `Text “${templates.find((t) => t.id === a.template_id)?.name ?? 'template'}”`;
    case 'create_task':
      return `Task “${String(a.title ?? '')}”`;
    case 'update_lead_status':
      return `Lead → ${String(a.status ?? '')}`;
    case 'assign_lead':
      return 'Assign lead';
    default:
      return 'Webhook';
  }
}

/** Small ghost icon button used for "remove this row". */
function IconButton({ label, onClick, name = 'x' }: { label: string; onClick: () => void; name?: 'x' | 'plus' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center"
      style={{ border: '1px solid var(--line)', borderRadius: 8, background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer' }}
    >
      <Icon name={name} size={13} />
    </button>
  );
}

export default function WorkflowsPage() {
  const { authed } = useSoftphone();
  const [workflows, setWorkflows] = useState<WorkflowDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBuilder, setShowBuilder] = useState(false);
  const [runsFor, setRunsFor] = useState<{ workflow: WorkflowDto; runs: WorkflowRunDto[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([api.listWorkflows(), api.listMessageTemplates()]);
      setWorkflows(w.workflows);
      setTemplates(t.templates);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (authed) void load();
  }, [authed, load]);

  async function toggle(w: WorkflowDto) {
    setBusy(w.id);
    try {
      await api.updateWorkflow(w.id, { enabled: !w.enabled });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function openRuns(w: WorkflowDto) {
    try {
      const res = await api.listWorkflowRuns(w.id);
      setRunsFor({ workflow: w, runs: res.runs });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const enabled = workflows.filter((w) => w.enabled).length;
  const runs24 = workflows.reduce((s, w) => s + (w.run_counts?.last_24h ?? 0), 0);
  const subtitle = forbidden
    ? 'Manager-level'
    : workflows.length === 0
      ? 'Automate follow-up after calls, texts and dispositions'
      : `${workflows.length} workflow${workflows.length === 1 ? '' : 's'} · ${enabled} on · ${runs24} run${runs24 === 1 ? '' : 's'} in 24h`;

  return (
    <>
      <TopBar title="Workflows" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}

          {forbidden ? (
            <Card padded={false}>
              <EmptyState
                title="Workflows are manager-level"
                hint="Ask an admin for the manager role to build automations."
              />
            </Card>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <Eyebrow>All workflows</Eyebrow>
                <Button tone="accent" className="ml-auto" onClick={() => setShowBuilder(true)}>
                  <Icon name="plus" size={14} />
                  New workflow
                </Button>
              </div>

              <Card padded={false}>
                {workflows.length === 0 && (
                  <EmptyState
                    title="No workflows yet"
                    hint="Start with the classic: text a seller back within a minute of a missed call."
                    action={
                      <Button tone="dark" onClick={() => setShowBuilder(true)}>
                        Build one
                      </Button>
                    }
                  />
                )}
                {workflows.map((w, i) => (
                  <div
                    key={w.id}
                    className="flex flex-wrap items-center gap-3.5 px-4 py-3.5"
                    style={{ borderBottom: i === workflows.length - 1 ? 'none' : '1px solid var(--panel-2)', opacity: busy === w.id ? 0.6 : 1 }}
                  >
                    <Toggle on={w.enabled} onChange={() => void toggle(w)} label={`${w.enabled ? 'Disable' : 'Enable'} ${w.name}`} />
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5" style={{ minWidth: 200 }}>
                      <span className="truncate" style={{ font: '600 13px/1 Inter', color: w.enabled ? 'var(--text)' : 'var(--muted)' }}>
                        {w.name}
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1" style={{ font: '500 11px/1.3 Inter', color: 'var(--muted)' }}>
                        <span>When {triggerLabel(w).toLowerCase()}</span>
                        {(w.conditions?.all?.length ?? 0) > 0 && <span>· {w.conditions!.all!.length} condition{w.conditions!.all!.length === 1 ? '' : 's'}</span>}
                        <span>·</span>
                        {w.actions.map((a, k) => (
                          <span key={k} className="inline-flex items-center gap-1.5">
                            {k > 0 && <Icon name="chevron-right" size={11} style={{ color: 'var(--muted-2)' }} />}
                            <span style={{ color: 'var(--text)' }}>{actionSummary(a, templates)}</span>
                          </span>
                        ))}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-1.5 text-right" style={{ minWidth: 72 }}>
                      <span style={{ font: '700 13px/1 Inter' }}>{w.run_counts?.total ?? 0}</span>
                      <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                        runs · {w.run_counts?.last_24h ?? 0} today
                      </span>
                    </div>
                    <Button tone="ghost" onClick={() => void openRuns(w)} style={{ padding: '8px 11px', font: '600 11.5px/1 Inter' }}>
                      <Icon name="clock" size={13} />
                      History
                    </Button>
                  </div>
                ))}
              </Card>
            </>
          )}
        </div>
      </div>

      {showBuilder && (
        <Builder
          templates={templates}
          onClose={() => setShowBuilder(false)}
          onSaved={async () => {
            setShowBuilder(false);
            await load();
          }}
        />
      )}

      {runsFor && <RunsDrawer workflow={runsFor.workflow} runs={runsFor.runs} onClose={() => setRunsFor(null)} />}
    </>
  );
}

/* ── Builder ─────────────────────────────────────────────────────────────── */

function Builder({
  templates,
  onClose,
  onSaved,
}: {
  templates: MessageTemplateDto[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [trigger, setTrigger] = useState('call.missed');
  const [days, setDays] = useState(7);
  const [conditions, setConditions] = useState<WorkflowConditionRow[]>([]);
  const [actions, setActions] = useState<WorkflowActionDto[]>([defaultAction('create_task')]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const setCondition = (i: number, patch: Partial<WorkflowConditionRow>) =>
    setConditions(conditions.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setAction = (i: number, patch: Partial<WorkflowActionDto>) =>
    setActions(actions.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await api.createWorkflow({
        name: name.trim(),
        trigger_type: trigger,
        trigger_config: trigger === 'no_contact_for_days' ? { days } : {},
        conditions: conditions.length > 0 ? { all: conditions } : null,
        actions,
      });
      await onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const step = (n: number) => (
    <span
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
      style={{ background: 'var(--dark-1)', color: '#fff', font: '700 10px/1 Inter' }}
      aria-hidden
    >
      {n}
    </span>
  );

  return (
    <Modal title="New workflow" onClose={onClose} width={640}>
      <div className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
          <Labeled label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Missed call text-back" autoFocus />
          </Labeled>
          <Labeled label="When">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Labeled>
          {trigger === 'no_contact_for_days' && (
            <Labeled label="Days without contact">
              <Input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 120 }} />
            </Labeled>
          )}
        </div>

        {/* ── Conditions ──────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <Eyebrow>Only if</Eyebrow>
            <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>all must match · empty = always</span>
          </div>
          {conditions.map((c, i) => {
            const valueless = c.op === 'is_null' || c.op === 'not_null';
            return (
              <div key={i} className="grid items-center gap-2" style={{ gridTemplateColumns: '1.3fr 1fr 1.3fr auto' }}>
                <Select value={c.field} onChange={(e) => setCondition(i, { field: e.target.value })}>
                  {CONDITION_FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
                <Select value={c.op} onChange={(e) => setCondition(i, { op: e.target.value })}>
                  {OPS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
                {valueless ? (
                  <span />
                ) : (
                  <Input
                    placeholder={c.op === 'in' ? 'a, b, c' : 'value'}
                    value={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}
                    onChange={(e) =>
                      setCondition(i, {
                        value: c.op === 'in' ? e.target.value.split(',').map((s) => s.trim()) : e.target.value,
                      })
                    }
                  />
                )}
                <IconButton label="Remove condition" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} />
              </div>
            );
          })}
          <Button
            tone="ghost"
            className="self-start"
            style={{ padding: '7px 10px', font: '600 11.5px/1 Inter' }}
            onClick={() => setConditions([...conditions, { field: 'lead.status', op: 'eq', value: '' }])}
          >
            <Icon name="plus" size={12} />
            Add condition
          </Button>
        </section>

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <Eyebrow>Then</Eyebrow>
            <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>runs in order</span>
          </div>
          {actions.map((a, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              {step(i + 1)}
              <Select value={a.type} onChange={(e) => setActions(actions.map((x, j) => (j === i ? defaultAction(e.target.value) : x)))} style={{ minWidth: 170 }}>
                {ACTION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              {a.type === 'send_sms' && (
                <Select className="flex-1" value={String(a.template_id ?? '')} onChange={(e) => setAction(i, { template_id: e.target.value })}>
                  <option value="">Choose template…</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              )}
              {a.type === 'create_task' && (
                <>
                  <Input className="flex-1" placeholder="Task title" value={String(a.title ?? '')} onChange={(e) => setAction(i, { title: e.target.value })} />
                  <span className="inline-flex items-center gap-1.5" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                    due in
                    <Input
                      type="number"
                      min={0}
                      value={Number(a.due_in_hours ?? 24)}
                      onChange={(e) => setAction(i, { due_in_hours: Number(e.target.value) })}
                      style={{ width: 64, padding: '8px 9px' }}
                    />
                    h · to lead owner
                  </span>
                </>
              )}
              {a.type === 'update_lead_status' && (
                <Input className="flex-1" placeholder="New status" value={String(a.status ?? '')} onChange={(e) => setAction(i, { status: e.target.value })} />
              )}
              {a.type === 'assign_lead' && (
                <Input className="flex-1" placeholder="User id (uuid)" value={String(a.user_id ?? '')} onChange={(e) => setAction(i, { user_id: e.target.value })} />
              )}
              {a.type === 'emit_webhook' && (
                <span className="flex-1" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                  Posts workflow.executed to the org’s webhook endpoints
                </span>
              )}
              <IconButton label="Remove action" onClick={() => setActions(actions.filter((_, j) => j !== i))} />
            </div>
          ))}
          <Button
            tone="ghost"
            className="self-start"
            style={{ padding: '7px 10px', font: '600 11.5px/1 Inter' }}
            onClick={() => setActions([...actions, defaultAction('create_task')])}
          >
            <Icon name="plus" size={12} />
            Add action
          </Button>
        </section>

        {saveError && <Notice tone="error">{saveError}</Notice>}

        <div className="flex items-center justify-end gap-2 pt-1" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" onClick={() => void save()} disabled={saving || name.trim().length === 0 || actions.length === 0}>
            {saving ? 'Saving…' : 'Create workflow'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Run history drawer ──────────────────────────────────────────────────── */

function RunsDrawer({ workflow, runs, onClose }: { workflow: WorkflowDto; runs: WorkflowRunDto[]; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-40" role="presentation" onClick={onClose} style={{ background: 'rgba(17,17,17,0.25)' }}>
      <aside
        role="dialog"
        aria-label={`${workflow.name} run history`}
        onClick={(e) => e.stopPropagation()}
        className="absolute inset-y-0 right-0 flex w-full max-w-md flex-col"
        style={{ background: 'var(--bg)', borderLeft: '1px solid var(--line)', boxShadow: 'var(--shadow-lift)' }}
      >
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate" style={{ font: '700 14px/1 Inter', letterSpacing: '-0.01em' }}>
              {workflow.name}
            </span>
            <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
              {runs.length} recent run{runs.length === 1 ? '' : 's'}
            </span>
          </div>
          <IconButton label="Close" onClick={onClose} />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
          {runs.length === 0 && (
            <Card padded={false}>
              <EmptyState title="No runs yet" hint="Runs appear here the first time the trigger fires." />
            </Card>
          )}
          {runs.map((r) => (
            <Card key={r.id} className="flex flex-col gap-2.5" style={{ padding: 13 }}>
              <div className="flex items-center gap-3">
                <StatusMarker color={RUN_COLOR[r.status] ?? 'var(--muted-2)'} label={r.status} />
                <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>{r.trigger_source}</span>
                <span className="ml-auto" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                  {new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </div>
              {r.skip_reason && (
                <span style={{ font: '500 11px/1.4 Inter', color: 'var(--amber)' }}>Skipped: {r.skip_reason.replace(/_/g, ' ')}</span>
              )}
              {r.error && <span style={{ font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{r.error}</span>}
              {r.action_results.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {r.action_results.map((a) => (
                    <li key={a.index} className="flex items-center gap-2" style={{ font: '500 11px/1.3 Inter' }}>
                      <span style={{ width: 6, height: 6, background: RUN_COLOR[a.status] ?? 'var(--muted-2)', flexShrink: 0 }} aria-hidden />
                      <span style={{ color: 'var(--muted)' }}>{a.index + 1}.</span>
                      <span>{ACTION_TYPES.find((t) => t.value === a.type)?.label ?? a.type}</span>
                      <span className="ml-auto" style={{ color: a.error ? 'var(--red)' : 'var(--muted)' }}>
                        {a.error ?? a.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </div>
      </aside>
    </div>
  );
}
