'use client';

/**
 * Scripts manager: the talk tracks and objection rebuttals the dialer's
 * in-call panel serves. Two lists — scripts, then rebuttals — ordered the
 * way the panel offers them; up/down reorders, a switch enables, a modal
 * edits with a live preview. Managers change things; reps read.
 *
 * Bodies are light markdown (`## `, `- `, `**bold**`, `> `) with merge
 * fields. "Preview as" renders the primary script the panel would pick for a
 * real number, through the same call-context endpoint the dialer uses.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  CONTACT_TYPES,
  getSessionUser,
  type CallContextDto,
  type CampaignDto,
  type ScriptDto,
  type ScriptInput,
  type ScriptKind,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Button, Card, EmptyState, Eyebrow, GridHead, GridRow, Input, Labeled, Modal, Notice, SectionTitle, Segmented, Select, Toggle } from '@/components/ui';
import { FilterChip, IconButton, TYPE_LABEL, TagChip, TagsField, errorMessage, isForbidden } from '@/components/contacts';
import { ScriptBody } from '@/components/CallContext';
import { MergeFieldHelp, MergeTextArea } from '@/components/MergeField';
import { SCRIPT_MERGE_FIELDS, fetchCallContext, renderScriptMerge, sampleMergeFields } from '@/lib/callContext';
import { formatPhone, toE164 } from '@/lib/time';

const KIND_LABEL: Record<ScriptKind, string> = { script: 'Script', rebuttal: 'Rebuttal' };
const COLS = '60px minmax(220px, 2fr) minmax(180px, 1.6fr) minmax(120px, 1fr) 64px 76px';
const MIN_WIDTH = 760;

function byOrder(a: ScriptDto, b: ScriptDto): number {
  return a.sort_order - b.sort_order || a.title.localeCompare(b.title);
}

/** How long a body reads, in the lines a rep actually says. */
function lineCount(body: string): string {
  const n = body.split(/\r?\n/).filter((l) => l.trim()).length;
  return `${n} ${n === 1 ? 'line' : 'lines'}`;
}

/** Managers and above edit; reps read. Unknown (no session yet) is treated as manager until the server says otherwise. */
function roleCanManage(): boolean {
  const role = getSessionUser()?.role;
  return role == null || ['owner', 'admin', 'manager'].includes(role);
}

type Confirm = { kind: 'delete'; script: ScriptDto } | { kind: 'import' };
type Editing = { script: ScriptDto } | { kind: ScriptKind };

export default function ScriptsPage() {
  const { authed } = useSoftphone();
  const [scripts, setScripts] = useState<ScriptDto[] | null>(null);
  // Null until the endpoint answers; stays null when it does not exist, and the campaign field is omitted.
  const [campaigns, setCampaigns] = useState<CampaignDto[] | null>(null);
  const [canManage, setCanManage] = useState<boolean | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sample, setSample] = useState<Record<string, string>>(() => sampleMergeFields(null));

  // Session and role live in localStorage: read after mount so the server
  // and the first client paint agree.
  useEffect(() => {
    setCanManage(roleCanManage());
    setSample(sampleMergeFields(getSessionUser()?.display_name ?? null));
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.listScripts({ include_disabled: true });
      setScripts(r.scripts);
      setError(null);
    } catch (e) {
      if (isForbidden(e)) setForbidden(true);
      else setError(errorMessage(e));
      setScripts([]);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load();
    api
      .listCampaigns()
      .then((r) => setCampaigns(r.campaigns))
      .catch(() => setCampaigns(null));
  }, [authed, load]);

  /** One write, with the 403 rule applied everywhere: a refusal turns the page read-only. */
  const write = useCallback(async <T,>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (done) setFlash(done);
      return r;
    } catch (e) {
      if (isForbidden(e)) {
        setReadOnly(true);
        setError('Only managers can change scripts. Your view is read-only.');
      } else {
        setError(errorMessage(e));
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const editable = canManage !== false && !readOnly && !forbidden;

  const ofKind = useCallback((kind: ScriptKind) => (scripts ?? []).filter((s) => s.kind === kind).sort(byOrder), [scripts]);

  const move = async (s: ScriptDto, dir: -1 | 1) => {
    const list = ofKind(s.kind);
    const i = list.findIndex((x) => x.id === s.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    // Optimistic: the row moves now, sort_order renumbered by position; a refusal re-reads.
    const renumbered = new Map(next.map((x, idx) => [x.id, idx] as const));
    setScripts((prev) => prev?.map((x) => (renumbered.has(x.id) ? { ...x, sort_order: renumbered.get(x.id)! } : x)) ?? prev);
    const r = await write(() => api.reorderScripts(next.map((x) => x.id)));
    if (r === null) await load();
  };

  const setEnabled = async (s: ScriptDto, enabled: boolean) => {
    setScripts((prev) => prev?.map((x) => (x.id === s.id ? { ...x, enabled } : x)) ?? prev);
    const r = await write(() => api.updateScript(s.id, { enabled }));
    if (r) setScripts((prev) => prev?.map((x) => (x.id === s.id ? r.script : x)) ?? prev);
    else await load();
  };

  const remove = async (s: ScriptDto) => {
    const r = await write(async () => {
      await api.deleteScript(s.id);
      return true;
    }, `Deleted “${s.title}”.`);
    setConfirm(null);
    if (r) setScripts((prev) => prev?.filter((x) => x.id !== s.id) ?? prev);
  };

  const importPlaybook = async () => {
    const r = await write(() => api.importScripts({ preset: 'example' }));
    setConfirm(null);
    if (r) {
      setFlash(`Example playbook imported: ${r.created} created, ${r.updated} updated, ${r.skipped} skipped.`);
      await load();
    }
  };

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const campaignName = (id: string | null) => (id ? (campaigns?.find((c) => c.id === id)?.name ?? 'Campaign') : null);

  const section = (kind: ScriptKind, title: string, hint: string) => {
    const rows = ofKind(kind);
    return (
      <Card padded={false} className="overflow-x-auto">
        <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
          <SectionTitle
            icon={<Icon name={kind === 'script' ? 'mic' : 'transfer'} size={15} />}
            right={
              editable ? (
                <Button tone="ghost" onClick={() => setEditing({ kind })} disabled={busy}>
                  <Icon name="plus" size={13} />
                  New {KIND_LABEL[kind].toLowerCase()}
                </Button>
              ) : undefined
            }
          >
            {title}
            <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}> · {rows.length}</span>
          </SectionTitle>
        </div>
        <p className="px-4 pb-3 pt-1" style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          {hint}
        </p>
        <GridHead cols={COLS} minWidth={MIN_WIDTH}>
          <Eyebrow>Order</Eyebrow>
          <Eyebrow>Title</Eyebrow>
          <Eyebrow>Tags · contact types</Eyebrow>
          <Eyebrow>Campaign</Eyebrow>
          <Eyebrow>On</Eyebrow>
          <span />
        </GridHead>
        {scripts === null && <p className="px-4 py-3" style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Loading…</p>}
        {scripts !== null && rows.length === 0 && (
          <EmptyState
            title={kind === 'script' ? 'No scripts yet' : 'No rebuttals yet'}
            hint={
              kind === 'script'
                ? 'The in-call panel shows the first enabled script whose contact types and campaign match.'
                : 'Rebuttals are searchable on the Objections tab during a call.'
            }
            action={
              editable ? (
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  <Button tone="accent" onClick={() => setEditing({ kind })}>
                    <Icon name="plus" size={13} />
                    Write one
                  </Button>
                  <Button tone="ghost" onClick={() => setConfirm({ kind: 'import' })}>
                    Import example playbook
                  </Button>
                </div>
              ) : undefined
            }
          />
        )}
        {rows.map((s, i) => (
          <GridRow key={s.id} cols={COLS} minWidth={MIN_WIDTH} style={{ opacity: s.enabled ? 1 : 0.6 }}>
            <span className="flex items-center gap-1">
              <ArrowButton label="Move up" disabled={!editable || busy || i === 0} onClick={() => void move(s, -1)}>
                ↑
              </ArrowButton>
              <ArrowButton label="Move down" disabled={!editable || busy || i === rows.length - 1} onClick={() => void move(s, 1)}>
                ↓
              </ArrowButton>
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <button
                type="button"
                onClick={() => setEditing({ script: s })}
                className="truncate text-left"
                title={editable ? 'Edit' : 'View'}
                style={{ font: '600 12.5px/1.2 Inter', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
              >
                {s.title}
              </button>
              <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                {[s.category, lineCount(s.body)].filter(Boolean).join(' · ')}
              </span>
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {s.tags.map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
              {s.contact_types.length === 0 ? (
                <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>all types</span>
              ) : (
                s.contact_types.map((t) => (
                  <span
                    key={t}
                    style={{ padding: '2.5px 6px', borderRadius: 5, background: 'var(--accent-soft)', color: 'var(--accent)', font: '700 8.5px/1 Inter', letterSpacing: '0.07em', textTransform: 'uppercase' }}
                  >
                    {TYPE_LABEL[t as keyof typeof TYPE_LABEL] ?? t}
                  </span>
                ))
              )}
            </span>
            <span className="truncate" style={{ font: '500 11.5px/1 Inter', color: s.campaign_id ? 'var(--text)' : 'var(--muted-2)' }}>
              {campaignName(s.campaign_id) ?? 'any'}
            </span>
            <span>
              {editable ? (
                <Toggle on={s.enabled} onChange={(v) => void setEnabled(s, v)} label={`${s.title} enabled`} />
              ) : (
                <span style={{ font: '600 10px/1 Inter', letterSpacing: '0.08em', textTransform: 'uppercase', color: s.enabled ? 'var(--green)' : 'var(--muted-2)' }}>
                  {s.enabled ? 'On' : 'Off'}
                </span>
              )}
            </span>
            <span className="flex items-center justify-end gap-1">
              <IconButton label={editable ? 'Edit' : 'View'} icon="template" onClick={() => setEditing({ script: s })} />
              {editable && <IconButton label="Delete" icon="x" danger disabled={busy} onClick={() => setConfirm({ kind: 'delete', script: s })} />}
            </span>
          </GridRow>
        ))}
      </Card>
    );
  };

  return (
    <>
      <TopBar title="Scripts" subtitle="What the dialer puts in front of a rep on every call" />

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-3 md:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="mr-auto" style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
            Scripts open on the in-call panel&apos;s Script tab; rebuttals are what the Objections tab searches. Bodies are
            light markdown: <code style={{ font: '500 11px/1 ui-monospace, monospace' }}>## </code> sections,{' '}
            <code style={{ font: '500 11px/1 ui-monospace, monospace' }}>- </code> bullets, **bold** and{' '}
            <code style={{ font: '500 11px/1 ui-monospace, monospace' }}>&gt; </code> notes to the rep.
          </p>
          {editable && (
            <>
              <Button tone="ghost" onClick={() => setConfirm({ kind: 'import' })} disabled={busy}>
                <Icon name="forward" size={13} />
                Import example playbook
              </Button>
              <Button tone="accent" onClick={() => setEditing({ kind: 'script' })} disabled={busy}>
                <Icon name="plus" size={13} />
                New script
              </Button>
            </>
          )}
        </div>

        {forbidden && <Notice tone="warn">Scripts are not available for this account. Ask an admin for the rep role or higher.</Notice>}
        {!forbidden && canManage === false && !readOnly && (
          <Notice>You can read every script here; changing them is manager-level. Ask an admin for the manager role.</Notice>
        )}
        {readOnly && <Notice tone="warn">Read-only: the server refused a change. Ask an admin for the manager role.</Notice>}
        {flash && (
          <Notice
            action={
              <Button tone="quiet" onClick={() => setFlash(null)}>
                Dismiss
              </Button>
            }
          >
            {flash}
          </Notice>
        )}
        {error && (
          <Notice
            tone="error"
            action={
              <Button tone="quiet" onClick={() => setError(null)}>
                Dismiss
              </Button>
            }
          >
            {error}
          </Notice>
        )}

        {!forbidden && (
          <>
            {section('script', 'Scripts', 'The panel picks the first enabled script whose contact types and campaign fit the person on the line; the rest are offered as alternatives.')}
            {section('rebuttal', 'Objection rebuttals', 'Short, searchable answers. Tags and categories become the filter chips on the Objections tab.')}
            <PreviewAs />
          </>
        )}
      </div>

      {editing && (
        <ScriptEditor
          initial={'script' in editing ? editing.script : null}
          kind={'script' in editing ? editing.script.kind : editing.kind}
          campaigns={campaigns}
          sample={sample}
          readOnly={!editable}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            setFlash(created ? `Added “${saved.title}”.` : `Saved “${saved.title}”.`);
            setScripts((prev) => {
              if (!prev) return [saved];
              return created ? [...prev, saved] : prev.map((x) => (x.id === saved.id ? saved : x));
            });
          }}
          onForbidden={() => {
            setReadOnly(true);
            setError('Only managers can change scripts. Your view is read-only.');
          }}
        />
      )}

      {confirm?.kind === 'delete' && (
        <Modal title={`Delete ${KIND_LABEL[confirm.script.kind].toLowerCase()}`} onClose={() => setConfirm(null)} width={440}>
          <div className="flex flex-col gap-3">
            <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
              “{confirm.script.title}” disappears from the in-call panel for everyone. There is no undo — turn it off instead if you might want it back.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button tone="red" disabled={busy} onClick={() => void remove(confirm.script)}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
              <Button tone="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirm?.kind === 'import' && (
        <Modal title="Import the example playbook" onClose={() => setConfirm(null)} width={480}>
          <div className="flex flex-col gap-3">
            <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
              Adds the standard seller scripts and objection rebuttals. Anything you already have with the same title is kept as
              it is (skipped), so it is safe to run again.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button tone="accent" disabled={busy} onClick={() => void importPlaybook()}>
                {busy ? 'Importing…' : 'Import'}
              </Button>
              <Button tone="ghost" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** The reorder control: a 28px square with a text arrow, as the sequence builder draws it. */
function ArrowButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-35"
      style={{ borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer', font: '600 12px/1 Inter' }}
    >
      {children}
    </button>
  );
}

/* ── Editor ───────────────────────────────────────────────────────────────── */

interface Form {
  kind: ScriptKind;
  title: string;
  category: string;
  tags: string[];
  contact_types: string[];
  campaign_id: string;
  body: string;
  enabled: boolean;
}

function ScriptEditor({
  initial,
  kind,
  campaigns,
  sample,
  readOnly,
  onClose,
  onSaved,
  onForbidden,
}: {
  initial: ScriptDto | null;
  kind: ScriptKind;
  campaigns: CampaignDto[] | null;
  sample: Record<string, string>;
  readOnly: boolean;
  onClose: () => void;
  onSaved: (script: ScriptDto, created: boolean) => void;
  onForbidden: () => void;
}) {
  const [form, setForm] = useState<Form>({
    kind,
    title: initial?.title ?? '',
    category: initial?.category ?? '',
    tags: initial?.tags ?? [],
    contact_types: initial?.contact_types ?? [],
    campaign_id: initial?.campaign_id ?? '',
    body: initial?.body ?? '',
    enabled: initial?.enabled ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));

  const insertField = (field: string) => {
    const el = bodyRef.current;
    const token = `{${field}}`;
    if (!el) {
      set('body', form.body + token);
      return;
    }
    const start = el.selectionStart ?? form.body.length;
    const end = el.selectionEnd ?? form.body.length;
    set('body', form.body.slice(0, start) + token + form.body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const preview = useMemo(() => renderScriptMerge(form.body, sample), [form.body, sample]);
  const canSave = form.title.trim().length > 0 && form.body.trim().length > 0 && !saving && !readOnly;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setErr(null);
    const input: ScriptInput = {
      kind: form.kind,
      title: form.title.trim(),
      category: form.category.trim() || null,
      tags: form.tags,
      contact_types: form.contact_types,
      campaign_id: form.campaign_id || null,
      body: form.body,
      enabled: form.enabled,
    };
    try {
      if (initial) {
        const r = await api.updateScript(initial.id, input);
        onSaved(r.script, false);
      } else {
        const r = await api.createScript(input);
        onSaved(r.script, true);
      }
    } catch (e) {
      if (isForbidden(e)) {
        onForbidden();
        onClose();
      } else {
        setErr(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? (readOnly ? initial.title : `Edit ${KIND_LABEL[initial.kind].toLowerCase()}`) : `New ${KIND_LABEL[kind].toLowerCase()}`} onClose={onClose} width={960}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))' }}>
          {/* ── Definition ─────────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-end gap-3">
              <Labeled label="Kind">
                <Segmented
                  value={form.kind}
                  onChange={(v) => !readOnly && set('kind', v)}
                  options={[
                    { value: 'script', label: 'Script' },
                    { value: 'rebuttal', label: 'Rebuttal' },
                  ]}
                />
              </Labeled>
              <label className="flex items-center gap-2 pb-1" style={{ font: '600 12px/1 Inter', color: 'var(--muted)' }}>
                {form.enabled ? 'On' : 'Off'}
                <Toggle on={form.enabled} onChange={(v) => !readOnly && set('enabled', v)} label="Enabled" />
              </label>
            </div>
            <Labeled label="Title">
              <Input
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder={form.kind === 'script' ? 'Seller opener' : '“I’m not interested”'}
                autoFocus={!initial}
                readOnly={readOnly}
              />
            </Labeled>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              <Labeled label="Category">
                <Input value={form.category} onChange={(e) => set('category', e.target.value)} placeholder={form.kind === 'script' ? 'cold, follow-up…' : 'price, timing…'} readOnly={readOnly} />
              </Labeled>
              {campaigns !== null && (
                <Labeled label="Campaign">
                  <Select value={form.campaign_id} onChange={(e) => set('campaign_id', e.target.value)} disabled={readOnly}>
                    <option value="">Any campaign</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Labeled>
              )}
            </div>
            <Labeled label="Tags">
              <TagsField tags={form.tags} onChange={(tags) => set('tags', tags)} disabled={readOnly} placeholder="objection words, situations…" />
            </Labeled>
            <div className="flex flex-col gap-1.5">
              <Eyebrow>Contact types · none means every type</Eyebrow>
              <div className="flex flex-wrap gap-1.5">
                {CONTACT_TYPES.map((t) => {
                  const on = form.contact_types.includes(t);
                  return (
                    <FilterChip
                      key={t}
                      active={on}
                      onClick={() => {
                        if (readOnly) return;
                        set('contact_types', on ? form.contact_types.filter((x) => x !== t) : [...form.contact_types, t]);
                      }}
                    >
                      {TYPE_LABEL[t]}
                    </FilterChip>
                  );
                })}
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="flex items-center gap-2">
                <Eyebrow>Body</Eyebrow>
                <span style={{ font: '400 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                  type <code style={{ font: '600 10.5px/1 ui-monospace, monospace' }}>/</code> to insert a field
                </span>
                <span className="ml-auto">
                  <MergeFieldHelp fields={SCRIPT_MERGE_FIELDS} values={sample} />
                </span>
              </span>
              {/* MergeTextArea (not ui.TextArea): the `/` picker and the chips
                  below both insert at the caret, through the same element. */}
              <MergeTextArea
                textareaRef={bodyRef}
                value={form.body}
                onChange={(body) => set('body', body)}
                values={sample}
                fields={SCRIPT_MERGE_FIELDS}
                readOnly={readOnly}
                rows={14}
                aria-label="Script body"
                placeholder={'## Opening\nHi {first_name}, this is {rep_first_name} with {company}. I’m calling about {address} — still the owner?\n\n> Pause. Let them answer.\n\n## Why we called\n- We buy houses in {city} as-is, cash, on your timeline.\n- **No fees**, no repairs, no showings.'}
                style={{ lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
              />
            </div>
            {!readOnly && (
              <div className="flex flex-wrap items-center gap-1.5">
                {SCRIPT_MERGE_FIELDS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => insertField(f)}
                    title={`Insert {${f}}`}
                    style={{
                      padding: '4px 8px',
                      borderRadius: 6,
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--text)',
                      font: '600 10.5px/1 Inter',
                      cursor: 'pointer',
                    }}
                  >
                    {`{${f}}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── Live preview ───────────────────────────────────────────── */}
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between">
              <Eyebrow>Preview · sample values</Eyebrow>
              <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>as the panel renders it</span>
            </div>
            <div className="flex flex-col gap-3 p-4" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-card)', background: 'var(--bg)', minHeight: 200 }}>
              {form.title.trim() && <span style={{ font: '700 13px/1 Inter' }}>{form.title.trim()}</span>}
              {form.body.trim() ? <ScriptBody body={preview} collapsible /> : <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Start typing on the left.</p>}
            </div>
          </div>
        </div>

        {err && <Notice tone="error">{err}</Notice>}

        <div className="flex flex-wrap items-center gap-1.5">
          {!readOnly && (
            <Button type="submit" tone="accent" disabled={!canSave}>
              <Icon name="check" size={13} />
              {saving ? 'Saving…' : initial ? 'Save changes' : `Add ${KIND_LABEL[form.kind].toLowerCase()}`}
            </Button>
          )}
          <Button tone="ghost" onClick={onClose} disabled={saving}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Preview as a real lead ───────────────────────────────────────────────── */

function PreviewAs() {
  const [phone, setPhone] = useState('');
  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const digits = phone.replace(/\D/g, '');
  const ok = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));

  const run = async () => {
    if (!ok || busy) return;
    setBusy(true);
    setErr(null);
    try {
      setCtx(await fetchCallContext({ phone: toE164(phone) }, true));
    } catch (e) {
      setCtx(null);
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const primary = ctx?.scripts.primary ?? null;

  return (
    <Card className="flex flex-col gap-3">
      <SectionTitle icon={<Icon name="search" size={15} />}>Preview as a real lead</SectionTitle>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Labeled label="Phone number" className="flex-1" >
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(210) 555-0134" inputMode="tel" autoComplete="off" style={{ minWidth: 160 }} />
        </Labeled>
        <Button type="submit" tone="dark" disabled={!ok || busy}>
          {busy ? 'Loading…' : 'Preview'}
        </Button>
      </form>
      <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
        Exactly what the in-call panel would open for this number: the primary script with that contact&apos;s merge fields filled in.
      </p>
      {err && <Notice tone="error">{err}</Notice>}
      {ctx && (
        <div className="flex flex-col gap-2 p-4" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-card)', background: 'var(--bg)' }}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)' }}>
            <span style={{ font: '700 13px/1 Inter', color: 'var(--text)' }}>{ctx.contact?.display_name ?? 'Unknown number'}</span>
            {ctx.contact && <span>{TYPE_LABEL[ctx.contact.type]}</span>}
            <span>{formatPhone(ctx.phone_e164 ?? phone)}</span>
            {ctx.campaign && <span>· {ctx.campaign.name}</span>}
            {primary && (
              <span className="ml-auto">
                {primary.title}
                {primary.category ? ` · ${primary.category}` : ''}
                {ctx.scripts.alternatives.length > 0 ? ` · +${ctx.scripts.alternatives.length} alternative${ctx.scripts.alternatives.length === 1 ? '' : 's'}` : ''}
              </span>
            )}
          </div>
          {primary ? (
            <ScriptBody body={primary.rendered_body} collapsible />
          ) : (
            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              No script matches this contact. Check the contact types and campaign on your scripts, or{' '}
              <Link href="/contacts" style={{ color: 'var(--accent)' }}>
                the contact&apos;s type
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
