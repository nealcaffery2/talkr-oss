'use client';

/**
 * SMS templates: the picker a rep uses mid-thread and the manager a lead owns.
 *
 * The two used to be different things — the inbox listed templates and Settings
 * said they were read-only — which meant the person who writes the openers had
 * to ask an engineer to change one. It is one control now: the same list a rep
 * clicks to insert is the list a manager edits, so the rows always agree.
 *
 * Permission is the server's call. Managers and up can write; a rep sees the
 * picker and a plain read-only line, and a 403 from any write turns the panel
 * read-only rather than throwing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type MessagePreviewDto,
  type MessagePreviewInput,
  type MessagePreviewTarget,
  type MessageTemplateDto,
  type MessageTemplateInput,
} from '@/lib/api';
import { sampleMergeFields } from '@/lib/callContext';
import { Icon } from './Icon';
import { Button, Eyebrow, Input, Labeled, Modal, Select, Toggle } from './ui';
import { IconButton, errorMessage, firstNonGsmChar, isForbidden, smsSegments } from './contacts';
import { MergeFieldHelp, MergeTextArea, unknownFieldsIn } from './MergeField';

/* ── Merge fields ─────────────────────────────────────────────────────────── */

/**
 * Exactly what the server renders into an SMS body — a mirror of
 * `MESSAGE_MERGE_FIELDS` in packages/core/src/messaging.ts, which is also the
 * list `POST/PATCH /v1/message-templates` validates a body against (a name
 * outside it is a 400 `unknown_merge_field`). The web app does not depend on
 * @talkr/core, so the list is copied rather than imported; keep the two in
 * step.
 *
 * `contact_name` is the Phase 4 alias of `name` and renders identically. It
 * has no chip — nobody should write a new template with it — but it is here so
 * an old template that uses it is not flagged as broken.
 */
export const MESSAGE_MERGE_FIELDS = [
  'first_name',
  'name',
  'contact_name',
  'address',
  'city',
  'state',
  'postal_code',
  'company',
  'rep_name',
  'rep_first_name',
  'org_name',
  'phone',
] as const;

/**
 * One representative seller, so a template's `/` picker and preview read like
 * a real message rather than a form. The same stand-in the script and sequence
 * editors use, plus the two fields only SMS renders.
 */
export const SAMPLE_MESSAGE_VALUES: Record<string, string> = {
  ...sampleMergeFields(null),
  contact_name: 'Marisol Lopez',
  org_name: 'Your Company Acquisitions',
};

/**
 * The grammar the server renders (`{first_name}` and `{{first_name}}` both
 * work). Chips insert the single-brace form because that is what the existing
 * templates and sequences use.
 */
export const SMS_MERGE_FIELDS: Array<{ token: string; label: string }> = [
  { token: '{first_name}', label: 'First name' },
  { token: '{name}', label: 'Name' },
  { token: '{address}', label: 'Address' },
  { token: '{city}', label: 'City' },
  { token: '{state}', label: 'State' },
  { token: '{postal_code}', label: 'ZIP' },
  { token: '{company}', label: 'Company' },
  { token: '{rep_name}', label: 'Rep' },
  { token: '{rep_first_name}', label: 'Rep first' },
  { token: '{org_name}', label: 'Org' },
  { token: '{phone}', label: 'Phone' },
];

/** True when a body still has braces in it — the cue to ask for a preview. */
export function hasMergeFields(body: string): boolean {
  return /\{\{?\s*[a-z_]+\s*\}?\}/i.test(body);
}

export function MergeChips({
  onInsert,
  fields = SMS_MERGE_FIELDS,
}: {
  onInsert: (token: string) => void;
  fields?: Array<{ token: string; label: string }>;
}) {
  return (
    <span className="flex flex-wrap gap-1">
      {fields.map((f) => (
        <button
          key={f.token}
          type="button"
          title={`Insert ${f.token}`}
          // Keep the caret: a mousedown would move focus out of the field first.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(f.token)}
          style={{
            padding: '3px 7px',
            borderRadius: 6,
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            font: '600 10px/1 Inter',
            color: 'var(--accent)',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {f.label}
        </button>
      ))}
    </span>
  );
}

/* ── Preview ──────────────────────────────────────────────────────────────── */

export interface PreviewState {
  preview: MessagePreviewDto | null;
  loading: boolean;
  /** Set when the endpoint refused or is not there; the UI stays quiet about it. */
  error: string | null;
}

/**
 * "Sends as": the body with merge fields rendered by the server, debounced so
 * a rep typing an opener does not fire a request per keystroke. The input is
 * compared by value, so callers can pass a fresh object every render.
 */
export function useMessagePreview(input: MessagePreviewInput, enabled = true, delay = 350): PreviewState {
  const key = JSON.stringify(input);
  const [state, setState] = useState<PreviewState>({ preview: null, loading: false, error: null });

  useEffect(() => {
    const parsed = JSON.parse(key) as MessagePreviewInput;
    const asks = Boolean(parsed.body?.trim() ?? '') || Boolean(parsed.template_id);
    if (!enabled || !asks) {
      setState({ preview: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      api
        .previewMessage(parsed)
        .then((preview) => {
          if (!cancelled) setState({ preview, loading: false, error: null });
        })
        .catch((e: unknown) => {
          if (!cancelled) setState({ preview: null, loading: false, error: errorMessage(e) });
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, enabled, delay]);

  return state;
}

/**
 * The rendered body under a composer or an editor. Shows nothing at all when
 * there is nothing to say — an empty draft, or a body with no merge fields —
 * so it never becomes furniture the rep learns to ignore.
 */
export function MergePreview({
  state,
  raw,
  label = 'Sends as',
  showUnknown = true,
}: {
  state: PreviewState;
  /** What the rep typed, so the strip can stay quiet when nothing would change. */
  raw: string;
  label?: string;
  /**
   * Off where an unknown field is not merely cosmetic. On the composer it
   * sends literally; in the template editor it is a save-time rejection, so
   * that surface says so itself, instantly, rather than twice in two voices.
   */
  showUnknown?: boolean;
}) {
  const { preview, loading, error } = state;
  const body = preview?.body ?? '';
  const unknown = showUnknown ? (preview?.unknown_fields ?? []) : [];
  const changed = body.length > 0 && body !== raw;

  if (error && hasMergeFields(raw)) {
    return (
      <span style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
        Preview unavailable — merge fields are filled in when the message is sent.
      </span>
    );
  }
  if (!changed && unknown.length === 0) {
    return loading && hasMergeFields(raw) ? (
      <span style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>Rendering…</span>
    ) : null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {changed && (
        <>
          <Eyebrow>{label}</Eyebrow>
          <div
            style={{
              padding: '9px 13px',
              borderRadius: 14,
              background: 'var(--panel-2)',
              font: '400 12.5px/1.45 Inter',
              color: 'var(--text)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {body}
          </div>
        </>
      )}
      {unknown.length > 0 && (
        <span style={{ font: '500 10.5px/1.4 Inter', color: 'var(--amber)' }}>
          {unknown.map((f) => `{${f}}`).join(', ')} {unknown.length === 1 ? 'is not a merge field' : 'are not merge fields'} — {unknown.length === 1 ? 'it sends' : 'they send'} literally.
        </span>
      )}
    </div>
  );
}

/* ── Category ─────────────────────────────────────────────────────────────── */

/**
 * The category chip uses the temperature language the rest of the app uses for
 * a lead — a rep should not have to learn a second one. An unrecognized
 * category still renders, in neutral.
 */
const CATEGORY_COLOR: Record<string, { fg: string; bg: string }> = {
  cold: { fg: 'var(--accent)', bg: 'var(--accent-soft)' },
  warm: { fg: 'var(--amber)', bg: 'color-mix(in srgb, var(--amber) 14%, transparent)' },
  hot: { fg: 'var(--red)', bg: 'color-mix(in srgb, var(--red) 14%, transparent)' },
  compliance: { fg: 'var(--muted)', bg: 'var(--panel-2)' },
};

export const TEMPLATE_CATEGORIES = ['cold', 'warm', 'hot', 'compliance'] as const;

export function CategoryChip({ category }: { category: string }) {
  const tone = CATEGORY_COLOR[category.toLowerCase()] ?? { fg: 'var(--muted)', bg: 'var(--panel-2)' };
  return (
    <span
      style={{
        padding: '2.5px 6px',
        borderRadius: 5,
        background: tone.bg,
        color: tone.fg,
        font: '700 8.5px/1 Inter',
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}
    >
      {category}
    </span>
  );
}

/** A template with no `is_active` is one from a server without management yet. */
export function isActive(t: MessageTemplateDto): boolean {
  return t.is_active !== false;
}

/* ── Manager ──────────────────────────────────────────────────────────────── */

const MANAGER_ROLES = ['owner', 'admin', 'manager'];

/** Whether this role may write templates. Unknown roles are treated as reps. */
export function canManageTemplates(role: string | null | undefined): boolean {
  return MANAGER_ROLES.includes((role ?? '').toLowerCase());
}

export function TemplateManager({
  templates,
  loading = false,
  canManage,
  reload,
  onUse,
  selectedId,
  target,
  compact = false,
}: {
  templates: MessageTemplateDto[];
  loading?: boolean;
  /** From the viewer's role; a 403 on any write also drops the panel to read-only. */
  canManage: boolean;
  /** Re-fetch after a write. */
  reload: () => void;
  /** Present on the inbox: clicking a row loads it into the composer. */
  onUse?: (template: MessageTemplateDto) => void;
  selectedId?: string | null;
  /** Who the live preview renders against, when a thread is open. */
  target?: MessagePreviewTarget;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState<MessageTemplateDto | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MessageTemplateDto | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const writable = canManage && !refused;

  /** Every write goes through here, so one 403 turns the whole panel read-only. */
  const write = async (id: string | null, run: () => Promise<unknown>) => {
    setError(null);
    setBusyId(id ?? 'new');
    try {
      await run();
      reload();
      return true;
    } catch (e) {
      if (isForbidden(e)) setRefused(true);
      else setError(errorMessage(e));
      return false;
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = (t: MessageTemplateDto) =>
    void write(t.id, () => api.updateMessageTemplate(t.id, { is_active: !isActive(t) }));

  const remove = async (t: MessageTemplateDto) => {
    const ok = await write(t.id, () => api.deleteMessageTemplate(t.id));
    if (ok) setConfirmDelete(null);
  };

  const active = templates.filter(isActive);
  const inactive = templates.filter((t) => !isActive(t));

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>Templates</Eyebrow>
        <span className="mr-auto" style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
          {onUse ? 'Click to insert' : `${templates.length} total`}
        </span>
        {writable && (
          <Button
            tone="ghost"
            onClick={() => setEditing('new')}
            style={{ padding: '6px 9px', font: '600 11px/1 Inter' }}
          >
            <Icon name="plus" size={12} />
            New
          </Button>
        )}
      </div>

      {error && (
        <span style={{ font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{error}</span>
      )}

      {loading && templates.length === 0 && (
        <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted-2)' }}>Loading templates…</p>
      )}

      {!loading && templates.length === 0 && (
        <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          {writable ? 'No templates yet — write the opener your team uses most.' : 'No templates yet.'}
        </p>
      )}

      {active.map((t) => (
        <TemplateRow
          key={t.id}
          template={t}
          selected={t.id === selectedId}
          busy={busyId === t.id}
          writable={writable}
          compact={compact}
          onUse={onUse}
          onEdit={() => setEditing(t)}
          onToggle={() => toggleActive(t)}
          onDelete={() => setConfirmDelete(t)}
        />
      ))}

      {inactive.length > 0 && (
        <>
          <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted-2)' }}>
            Inactive
          </span>
          {inactive.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              selected={false}
              busy={busyId === t.id}
              writable={writable}
              compact={compact}
              onEdit={() => setEditing(t)}
              onToggle={() => toggleActive(t)}
              onDelete={() => setConfirmDelete(t)}
            />
          ))}
        </>
      )}

      {!canManage && templates.length > 0 && (
        <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
          Read-only — a manager or admin writes the templates. You can still send any of them.
        </p>
      )}
      {canManage && refused && (
        <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--amber)' }}>
          The server refused that change (manager access required), so this list is read-only.
        </p>
      )}

      {editing && (
        <TemplateEditor
          template={editing === 'new' ? null : editing}
          target={target}
          error={refused ? 'The server refused that change — manager access required.' : error}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            const ok = await write(editing === 'new' ? null : editing.id, () =>
              editing === 'new'
                ? api.createMessageTemplate(input)
                : api.updateMessageTemplate(editing.id, input),
            );
            if (ok) setEditing(null);
            return ok;
          }}
        />
      )}

      {confirmDelete && (
        <Modal title="Delete template" onClose={() => setConfirmDelete(null)} width={420}>
          <div className="flex flex-col gap-3">
            <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
              <strong style={{ color: 'var(--text)' }}>{confirmDelete.name}</strong> disappears from
              every picker. Texts already sent with it stay in history. Deactivate it instead if you
              might want it back.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button tone="red" disabled={busyId !== null} onClick={() => void remove(confirmDelete)}>
                {busyId !== null ? 'Deleting…' : 'Delete'}
              </Button>
              <Button tone="ghost" onClick={() => setConfirmDelete(null)} disabled={busyId !== null}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TemplateRow({
  template: t,
  selected,
  busy,
  writable,
  compact,
  onUse,
  onEdit,
  onToggle,
  onDelete,
}: {
  template: MessageTemplateDto;
  selected: boolean;
  busy: boolean;
  writable: boolean;
  compact: boolean;
  onUse?: (t: MessageTemplateDto) => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const dim = !isActive(t);
  const excerpt = t.body.length > 92 ? `${t.body.slice(0, 92)}…` : t.body;
  // The row is not a button when it also carries buttons — the text is.
  const body = (
    <span className="flex min-w-0 flex-col gap-1.5 text-left">
      <span className="flex flex-wrap items-center gap-2">
        <span className="mr-auto truncate" style={{ font: '700 11.5px/1 Inter' }}>
          {t.name}
        </span>
        {t.category && <CategoryChip category={t.category} />}
      </span>
      <span style={{ font: '400 11px/1.4 Inter', color: 'var(--muted)' }}>{excerpt}</span>
      {t.use_count > 0 && !compact && (
        <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
          Used {t.use_count} {t.use_count === 1 ? 'time' : 'times'}
        </span>
      )}
    </span>
  );

  return (
    <div
      className="flex items-start gap-2 p-2.5"
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
        borderRadius: 11,
        background: 'var(--panel)',
        boxShadow: selected ? 'var(--shadow-pop)' : 'none',
        opacity: dim ? 0.6 : 1,
      }}
    >
      {onUse && !dim ? (
        <button
          type="button"
          onClick={() => onUse(t)}
          className="min-w-0 flex-1"
          style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {body}
        </button>
      ) : (
        <span className="min-w-0 flex-1">{body}</span>
      )}
      {writable && (
        <span className="flex shrink-0 items-center gap-1">
          <IconButton label={`Edit ${t.name}`} icon="edit" onClick={onEdit} disabled={busy} />
          <IconButton
            label={dim ? `Activate ${t.name}` : `Deactivate ${t.name}`}
            title={dim ? 'Activate' : 'Deactivate'}
            icon={dim ? 'check' : 'pause'}
            onClick={onToggle}
            disabled={busy}
          />
          <IconButton label={`Delete ${t.name}`} icon="trash" danger onClick={onDelete} disabled={busy} />
        </span>
      )}
    </div>
  );
}

/* ── Editor ───────────────────────────────────────────────────────────────── */

function TemplateEditor({
  template,
  target,
  error,
  onClose,
  onSave,
}: {
  template: MessageTemplateDto | null;
  target?: MessagePreviewTarget;
  /**
   * Whatever the last save was refused with — the manager catches it, but the
   * modal is what the rep is looking at, so the 400 has to render in here.
   */
  error?: string | null;
  onClose: () => void;
  onSave: (input: MessageTemplateInput) => Promise<boolean>;
}) {
  const [name, setName] = useState(template?.name ?? '');
  const [category, setCategory] = useState(template?.category ?? '');
  const [body, setBody] = useState(template?.body ?? '');
  const [active, setActive] = useState(template ? isActive(template) : true);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const previewInput = useMemo<MessagePreviewInput>(() => ({ body, ...(target ?? {}) }), [body, target]);
  const preview = useMessagePreview(previewInput, body.trim().length > 0);
  const local = smsSegments(body);
  const culprit = firstNonGsmChar(body);
  const culpritLabel =
    culprit === null ? '' : /\p{Extended_Pictographic}/u.test(culprit) ? 'An emoji' : `“${culprit}”`;
  const shown = preview.preview ?? null;
  const chars = shown?.characters ?? local.chars;
  const segments = shown?.segments ?? local.segments;
  const ready = name.trim().length > 0 && body.trim().length > 0;
  // The same check the server makes on write, run on every keystroke. Saving
  // stays possible — the server is still the authority on what it accepts —
  // but a typo is named the moment it is typed, not after a round trip.
  const unknown = useMemo(() => unknownFieldsIn(body, MESSAGE_MERGE_FIELDS), [body]);

  const insert = (token: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(`${body.slice(0, start)}${token}${body.slice(end)}`);
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    await onSave({
      name: name.trim(),
      body,
      category: category.trim() ? category.trim() : null,
      is_active: active,
    });
    setBusy(false);
  };

  return (
    <Modal title={template ? 'Edit template' : 'New template'} onClose={onClose} width={620}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Labeled label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Cold opener"
              autoFocus
              autoComplete="off"
            />
          </Labeled>
          <Labeled label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">No category</option>
              {TEMPLATE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c[0]!.toUpperCase() + c.slice(1)}
                </option>
              ))}
              {category && !TEMPLATE_CATEGORIES.includes(category as (typeof TEMPLATE_CATEGORIES)[number]) && (
                <option value={category}>{category}</option>
              )}
            </Select>
          </Labeled>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Eyebrow>Message</Eyebrow>
            <span style={{ font: '400 10.5px/1 Inter', color: 'var(--muted-2)' }}>
              type <code style={{ font: '600 10.5px/1 ui-monospace, monospace' }}>/</code> to insert a field
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              <MergeChips onInsert={insert} />
              <MergeFieldHelp fields={MESSAGE_MERGE_FIELDS} values={SAMPLE_MESSAGE_VALUES} />
            </span>
          </div>
          {/* MergeTextArea (not ui.TextArea): the `/` picker and the chips
              above both insert at the caret, through the same element. */}
          <MergeTextArea
            textareaRef={area}
            value={body}
            onChange={setBody}
            values={SAMPLE_MESSAGE_VALUES}
            fields={MESSAGE_MERGE_FIELDS}
            rows={4}
            placeholder="Hi {first_name}, this is {rep_first_name} with {org_name} — are you still open to an offer on {address}?"
            aria-label="Template body"
          />
          <span
            style={{
              font: '500 10.5px/1.4 Inter',
              color: segments > 2 ? 'var(--amber)' : 'var(--muted-2)',
            }}
          >
            {chars} chars · {segments} segment{segments === 1 ? '' : 's'}
            {local.encoding === 'ucs2' ? ` · ${culpritLabel} makes it UCS-2 — 70 per segment` : ''}
          </span>
          {unknown.length > 0 && (
            <span style={{ font: '500 10.5px/1.4 Inter', color: 'var(--amber)' }}>
              {unknown.map((f) => `{${f}}`).join(', ')}{' '}
              {unknown.length === 1 ? 'is not a merge field' : 'are not merge fields'} — saving will be
              refused.
            </span>
          )}
        </div>

        <MergePreview state={preview} raw={body} showUnknown={false} />

        <label className="flex items-center gap-2.5">
          <Toggle on={active} onChange={setActive} label="Active" />
          <span className="flex flex-col gap-0.5">
            <span style={{ font: '600 12px/1 Inter' }}>{active ? 'Active' : 'Inactive'}</span>
            <span style={{ font: '400 10.5px/1.3 Inter', color: 'var(--muted-2)' }}>
              Inactive templates stay on file but leave the reps&apos; picker.
            </span>
          </span>
        </label>

        {error && (
          <span style={{ font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{error}</span>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={!ready || busy}>
            {busy ? 'Saving…' : template ? 'Save template' : 'Create template'}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
