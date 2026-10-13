/**
 * Lead tab of the side panel's context view: who is on the line and what has
 * happened with them. Reads from one call-context fetch; the three writes it
 * makes (notes, status, temperature) go straight to the contact and are
 * applied to the cached context, so the popup sees them too.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from '@/shared/Icon';
import { Avatar, Button, Card, Eyebrow } from '@/shared/ui';
import {
  ApiError,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  api,
  type CallContextActivityDto,
  type CallContextDto,
  type ContactStatus,
  type ContactType,
  type Temperature,
} from '@/shared/api';
import type { CallContextState } from '@/shared/callContext';
import {
  STATUS_LABEL,
  TEMP_LABEL,
  TYPE_LABEL,
  StatusMark,
  TagChip,
  TemperatureBadge,
  TypeBadge,
  humanize,
  oneLineAddress,
} from '@/shared/contacts';
import { duration, formatPhone, stamp } from '@/shared/time';

const FIELD: CSSProperties = {
  height: 30,
  minWidth: 0,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  padding: '0 8px',
  font: '500 11.5px/1 Inter',
  color: 'var(--text)',
  outline: 'none',
};

function errorText(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : 'Something went wrong';
}

/* ── Activity rows ────────────────────────────────────────────────────────── */

function activityIcon(a: CallContextActivityDto): IconName {
  if (a.kind === 'call') return a.status === 'voicemail' ? 'voicemail' : 'phone';
  if (a.kind === 'sms') return 'msg';
  return 'check';
}

function activityColor(a: CallContextActivityDto): string {
  if (a.kind === 'call') {
    if (a.status === 'voicemail') return 'var(--amber)';
    return (a.duration_seconds ?? 0) > 0 ? 'var(--green)' : 'var(--red)';
  }
  if (a.kind === 'sms') return 'var(--accent)';
  return 'var(--amber)';
}

function activityTitle(a: CallContextActivityDto): string {
  const dir = a.direction === 'inbound' ? 'Inbound' : a.direction === 'outbound' ? 'Outbound' : '';
  if (a.kind === 'call') {
    const head = `${dir} call`.trim();
    if ((a.duration_seconds ?? 0) > 0) return `${head} · ${duration(a.duration_seconds!)}`;
    return a.status ? `${head} · ${humanize(a.status).toLowerCase()}` : head;
  }
  if (a.kind === 'sms') return `${dir} text`.trim();
  return a.body ?? 'Task';
}

function activityDetail(a: CallContextActivityDto): string | null {
  const parts: string[] = [];
  if (a.kind === 'call') {
    if (a.disposition_label) parts.push(a.disposition_label);
    if (a.note) parts.push(a.note);
  } else if (a.kind === 'sms') {
    if (a.body) parts.push(a.body);
  } else {
    if (a.note) parts.push(a.note);
    if (a.status) parts.push(humanize(a.status));
  }
  if (a.user_name) parts.push(a.user_name);
  return parts.length ? parts.join(' · ') : null;
}

/* ── Pieces ───────────────────────────────────────────────────────────────── */

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', minWidth: 0 }}>
      <span style={{ flexShrink: 0, width: 62, font: '600 9px/1.4 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted-2)' }}>
        {label}
      </span>
      <span style={{ flex: 1, minWidth: 0, font: '500 11.5px/1.4 Inter', color: 'var(--text)', overflowWrap: 'anywhere' }}>
        {children}
      </span>
    </div>
  );
}

/** Nothing on file for this number: name it and it becomes a contact. */
function QuickAdd({ phone, onCreated }: { phone: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ContactType>('seller');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const display_name = name.trim();
    if (!display_name || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createContact({ display_name, type, phone });
      onCreated();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>Add contact</Eyebrow>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="Name"
          aria-label="Contact name"
          style={{ ...FIELD, flex: 1 }}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as ContactType)}
          aria-label="Contact type"
          style={{ ...FIELD, width: 96 }}
        >
          {CONTACT_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </div>
      <Button tone="accent" disabled={!name.trim() || busy} onClick={() => void submit()}>
        <Icon name="plus" size={13} />
        {busy ? 'Adding…' : `Add ${formatPhone(phone)}`}
      </Button>
      {error && <p style={{ margin: 0, font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
    </Card>
  );
}

/** The contact's notes, saved when the rep clicks away. */
function Notes({ contactId, value, onSaved }: { contactId: string; value: string; onSaved: (notes: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState<string>(value);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // A different contact means different notes; never carry a draft across.
  useEffect(() => {
    setDraft(value);
    setSaved(value);
    setState('idle');
  }, [contactId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (draft === saved) return;
    setState('saving');
    setError(null);
    try {
      const { contact } = await api.updateContact(contactId, { notes: draft });
      setSaved(contact.notes ?? draft);
      setState('saved');
      onSaved(contact.notes ?? draft);
    } catch (err) {
      setState('error');
      setError(errorText(err));
    }
  }

  return (
    <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Eyebrow>Contact notes</Eyebrow>
        <span style={{ font: '500 10px/1 Inter', color: state === 'error' ? 'var(--red)' : 'var(--muted-2)' }}>
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : draft !== saved ? 'Unsaved' : ''}
        </span>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        placeholder="Motivation, timeline, condition, price…"
        style={{
          minHeight: 72,
          resize: 'vertical',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '9px 10px',
          font: '400 12px/1.45 Inter',
          outline: 'none',
        }}
      />
      {error && <p style={{ margin: 0, font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
    </Card>
  );
}

/* ── The tab ──────────────────────────────────────────────────────────────── */

export function LeadTab({ state, now }: { state: CallContextState; now: number }) {
  const { context: ctx, loading, error, update, refresh } = state;
  const [patchError, setPatchError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);

  if (!ctx) {
    return (
      <p style={{ margin: 0, padding: 4, font: '400 12px/1.5 Inter', color: error ? 'var(--red)' : 'var(--muted)' }}>
        {loading ? 'Looking up this number…' : error ? `Could not load the lead: ${error}` : 'No number to look up.'}
      </p>
    );
  }

  const contact = ctx.contact;
  const lead = ctx.lead;
  const address = oneLineAddress(contact?.address) || oneLineAddress(ctx.property);
  const rep = contact?.assigned_user_name ?? lead?.assigned_user_name ?? null;
  const leadStatus = lead?.status ?? contact?.lead_status ?? null;
  const phone = contact?.primary_phone ?? ctx.phone_e164;

  async function patch(input: { status?: ContactStatus; temperature?: Temperature }) {
    if (!contact || patching) return;
    setPatching(true);
    setPatchError(null);
    try {
      const r = await api.updateContact(contact.id, input);
      update({ contact: r.contact });
    } catch (err) {
      setPatchError(errorText(err));
    } finally {
      setPatching(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* ── Who ──────────────────────────────────────────────────────── */}
      <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={contact?.display_name ?? '?'} size={40} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
              <span
                style={{
                  font: '700 15px/1.1 Inter',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: contact ? 'var(--text)' : 'var(--muted)',
                }}
              >
                {contact?.display_name ?? 'Unknown number'}
              </span>
              {contact && <TypeBadge type={contact.type} />}
            </div>
            <span style={{ font: '500 11.5px/1 Inter', color: 'var(--muted)' }}>
              {formatPhone(phone)}
              {contact?.company ? ` · ${contact.company}` : ''}
            </span>
          </div>
          {lead?.crm_url && (
            <a
              href={lead.crm_url}
              target="_blank"
              rel="noreferrer"
              title="Open in the CRM"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                height: 28,
                padding: '0 9px',
                borderRadius: 8,
                border: '1px solid var(--line)',
                background: 'var(--panel)',
                font: '600 10.5px/1 Inter',
                color: 'var(--text)',
                textDecoration: 'none',
                flexShrink: 0,
              }}
            >
              CRM
              <Icon name="external-link" size={12} />
            </a>
          )}
        </div>

        {contact && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <StatusMark status={contact.status} />
            <TemperatureBadge
              temperature={contact.temperature}
              score={contact.temperature_score}
              locked={contact.temperature_locked}
            />
            {contact.last_activity_at && (
              <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)', marginLeft: 'auto' }}>
                Last touch {stamp(contact.last_activity_at, now)}
              </span>
            )}
          </div>
        )}

        {contact && contact.tags.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {contact.tags.map((t) => (
              <TagChip key={t}>{t}</TagChip>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {address && (
            <Fact label="Address">
              {address}
              {leadStatus && (
                <span style={{ color: 'var(--muted)' }}> · {humanize(leadStatus)}</span>
              )}
            </Fact>
          )}
          {!address && leadStatus && <Fact label="Lead">{humanize(leadStatus)}</Fact>}
          {(lead?.source ?? contact?.source) && (
            <Fact label="Source">{lead?.source ?? contact?.source}</Fact>
          )}
          {rep && <Fact label="Rep">{rep}</Fact>}
          {ctx.campaign && <Fact label="Campaign">{ctx.campaign.name}</Fact>}
          {contact?.email && <Fact label="Email">{contact.email}</Fact>}
        </div>

        {ctx.sequences.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {ctx.sequences.map((s) => (
              <TagChip key={s.id}>
                <span
                  aria-hidden
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: s.run_status === 'running' || s.run_status === 'active' ? 'var(--green)' : 'var(--muted-2)',
                  }}
                />
                {s.name} · {s.step}/{s.step_count}
                {s.resume_at ? ` · next ${stamp(s.resume_at, now)}` : ''}
              </TagChip>
            ))}
          </div>
        )}
      </Card>

      {!contact && (
        <QuickAdd phone={ctx.suggest_create?.phone_e164 ?? ctx.phone_e164} onCreated={refresh} />
      )}

      {/* ── Last call ───────────────────────────────────────────────── */}
      {ctx.last_call_summary && (
        <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Eyebrow>Last call</Eyebrow>
            <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
              {stamp(ctx.last_call_summary.at, now)}
            </span>
          </div>
          <p style={{ margin: 0, font: '400 12px/1.5 Inter' }}>{ctx.last_call_summary.summary}</p>
          {ctx.last_call_summary.next_steps.length > 0 && (
            <div>
              <span style={{ font: '600 10px/1.6 Inter', color: 'var(--muted)' }}>Next steps</span>
              <ul style={{ margin: 0, paddingLeft: 16, font: '400 11.5px/1.5 Inter' }}>
                {ctx.last_call_summary.next_steps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {ctx.last_call_summary.objections.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
              <span style={{ font: '600 10px/1 Inter', color: 'var(--muted)' }}>Objected:</span>
              {ctx.last_call_summary.objections.map((o) => (
                <TagChip key={o}>{o}</TagChip>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* ── Status, temperature, notes ─────────────────────────────── */}
      {contact && (
        <>
          <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <Eyebrow>Status</Eyebrow>
                <select
                  value={contact.status}
                  disabled={patching}
                  onChange={(e) => void patch({ status: e.target.value as ContactStatus })}
                  style={FIELD}
                >
                  {CONTACT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <Eyebrow>Temperature</Eyebrow>
                <select
                  value={contact.temperature}
                  disabled={patching}
                  onChange={(e) => void patch({ temperature: e.target.value as Temperature })}
                  style={FIELD}
                >
                  {TEMPERATURES.map((t) => (
                    <option key={t} value={t}>
                      {TEMP_LABEL[t]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {patchError && <p style={{ margin: 0, font: '500 11px/1.4 Inter', color: 'var(--red)' }}>{patchError}</p>}
          </Card>

          <Notes
            contactId={contact.id}
            value={contact.notes ?? ''}
            onSaved={(notes) => update({ contact: { ...contact, notes } })}
          />
        </>
      )}

      {/* ── Open tasks ──────────────────────────────────────────────── */}
      {ctx.open_tasks.length > 0 && (
        <Card>
          <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--line-soft)' }}>
            <Eyebrow>Open tasks · {ctx.open_tasks.length}</Eyebrow>
          </div>
          {ctx.open_tasks.map((t) => (
            <div
              key={t.id}
              style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderBottom: '1px solid var(--line-soft)' }}
            >
              <Icon name="check" size={13} style={{ color: 'var(--amber)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0, font: '500 11.5px/1.3 Inter', overflowWrap: 'anywhere' }}>
                {t.title}
                {t.assigned_user_name && <span style={{ color: 'var(--muted)' }}> · {t.assigned_user_name}</span>}
              </span>
              {t.due_at && (
                <span style={{ flexShrink: 0, font: '500 10.5px/1 Inter', color: new Date(t.due_at).getTime() < now ? 'var(--red)' : 'var(--muted-2)' }}>
                  {stamp(t.due_at, now)}
                </span>
              )}
            </div>
          ))}
        </Card>
      )}

      {/* ── Activity ────────────────────────────────────────────────── */}
      <Card>
        <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--line-soft)' }}>
          <Eyebrow>Recent activity</Eyebrow>
        </div>
        {ctx.activity.length === 0 ? (
          <p style={{ margin: 0, padding: 12, font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
            Nothing yet — this call will be the first entry.
          </p>
        ) : (
          ctx.activity.slice(0, 10).map((a) => {
            const detail = activityDetail(a);
            return (
              <div
                key={`${a.kind}:${a.id}`}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '9px 12px', borderBottom: '1px solid var(--line-soft)' }}
              >
                <span
                  aria-hidden
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    borderRadius: 7,
                    background: 'var(--panel-2)',
                    color: activityColor(a),
                  }}
                >
                  <Icon name={activityIcon(a)} size={12} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                  <span style={{ font: '600 11.5px/1.2 Inter' }}>{activityTitle(a)}</span>
                  {detail && (
                    <span
                      style={{
                        font: '400 11px/1.35 Inter',
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {detail}
                    </span>
                  )}
                </span>
                <span style={{ flexShrink: 0, paddingTop: 2, font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                  {stamp(a.at, now)}
                </span>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}

export type { CallContextDto };
