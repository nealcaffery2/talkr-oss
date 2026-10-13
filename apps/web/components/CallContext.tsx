'use client';

/**
 * The in-call panel: who is on the line, what has happened with them, the
 * script to read and the rebuttals to reach for. One request —
 * GET /v1/call-context — feeds every tab, so the panel is ready the moment a
 * number is typed, a call rings, or a call connects. It never waits to be
 * clicked open: the dialer mounts it beside the live call.
 *
 * Three tabs — Lead | Script | Objections — either owned here (a Segmented
 * at the top) or handed in by the phone layout, where the same four-way
 * control also carries the call itself.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ApiError,
  api,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  type CallContextActivityDto,
  type CallContextDto,
  type CallContextParams,
  type ContactDto,
  type ContactType,
  type ScriptDto,
  type UpdateContactInput,
} from '@/lib/api';
import { Icon, type IconName } from './Icon';
import { Avatar, Button, Card, EmptyState, Eyebrow, FIELD, Input, Labeled, Notice, Segmented, Select, StatusMarker } from './ui';
import {
  BAND_COLOR,
  FilterChip,
  STATUS_COLOR,
  STATUS_LABEL,
  StatusMark,
  TEMP_LABEL,
  TYPE_LABEL,
  TagChip,
  TagsField,
  TempDot,
  TemperatureBadge,
  TypeBadge,
  degrees,
  errorMessage,
  oneLineAddress,
  tempBand,
} from './contacts';
import { ProspectTime } from './ProspectTime';
import { duration, formatPhone, timeAgo } from '@/lib/time';
import {
  callContextKey,
  fetchCallContext,
  inlineRuns,
  invalidateCallContext,
  parseScript,
  renderScriptMerge,
  type ScriptBlock,
} from '@/lib/callContext';

export type CallContextMode = 'precall' | 'incall' | 'incoming';
export type CallContextTab = 'lead' | 'script' | 'objections';

export const CALL_CONTEXT_TABS: Array<{ value: CallContextTab; label: string }> = [
  { value: 'lead', label: 'Lead' },
  { value: 'script', label: 'Script' },
  { value: 'objections', label: 'Objections' },
];

// Session memory, module scope: the tab a rep last chose per mode, and the
// type size they read scripts at. Lost on reload on purpose — nothing here is
// worth a storage key.
const lastTab: Partial<Record<CallContextMode, CallContextTab>> = {};
let largeType = false;

/** Lead before a call and on inbound; the script the moment an outbound call is placed. */
export function defaultCallContextTab(mode: CallContextMode, direction?: 'inbound' | 'outbound'): CallContextTab {
  return lastTab[mode] ?? (mode === 'incall' && direction === 'outbound' ? 'script' : 'lead');
}

export interface CallContextProps {
  /** Who to show. Null renders nothing but the empty frame. */
  params: CallContextParams | null;
  /** The live call, so "used" tallies land on it. */
  callId?: string;
  mode: CallContextMode;
  /** Which way the live call went; picks the opening tab in a call. */
  direction?: 'inbound' | 'outbound';
  /** Controlled tab (the phone layout owns the segmented control); omit and the panel shows its own. */
  tab?: CallContextTab;
  onTabChange?: (tab: CallContextTab) => void;
  onCall?: (input: { to_number: string; lead_id?: string; contact_id?: string }) => void;
  /** False greys the Call button (softphone not ready, a call already up). */
  canCall?: boolean;
  onText?: (phone: string) => void;
  /** After a contact is created or edited from the panel. */
  onUpdated?: (ctx: CallContextDto) => void;
}

const MODE_LABEL: Record<CallContextMode, string> = {
  precall: 'For this number',
  incall: 'On this call',
  incoming: 'Calling in',
};

export function CallContext({
  params,
  callId,
  mode,
  direction,
  tab: controlledTab,
  onTabChange,
  onCall,
  canCall = true,
  onText,
  onUpdated,
}: CallContextProps) {
  const key = callContextKey(params);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [innerTab, setInnerTab] = useState<CallContextTab>(() => defaultCallContextTab(mode, direction));
  const [now, setNow] = useState<number | null>(null);
  const tab = controlledTab ?? innerTab;

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Load on every change of party. A typed number settles for 300ms first
  // (the tenth digit lands and the rep keeps typing a country code, or
  // backspaces); ids fetch at once. A stale party never sits under a new one.
  useEffect(() => {
    setCtx(null);
    setError(null);
    if (!key) {
      setLoading(false);
      return;
    }
    const p = paramsRef.current;
    if (!p) return;
    let alive = true;
    setLoading(true);
    const run = () => {
      fetchCallContext(p)
        .then((c) => {
          if (!alive) return;
          setCtx(c);
          setLoading(false);
        })
        .catch((e: unknown) => {
          if (!alive) return;
          setError(errorMessage(e));
          setLoading(false);
        });
    };
    const t = setTimeout(run, key.startsWith('phone:') ? 300 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [key]);

  const pickTab = (next: CallContextTab) => {
    lastTab[mode] = next;
    onTabChange?.(next);
    if (controlledTab === undefined) setInnerTab(next);
  };

  /** Re-read after an edit: the same party, fresh. */
  const reload = useCallback(async () => {
    const p = paramsRef.current;
    if (!p) return;
    try {
      const c = await fetchCallContext(p, true);
      setCtx(c);
      setError(null);
      onUpdated?.(c);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [onUpdated]);

  /**
   * A contact was just created for this number. Re-read the party; if the
   * server has not linked the new contact to the call yet, read the contact
   * directly so the rep is never left looking at "Unknown number".
   */
  const onCreated = useCallback(
    async (contactId: string) => {
      invalidateCallContext();
      const p = paramsRef.current;
      let c: CallContextDto | null = null;
      if (p) {
        try {
          c = await fetchCallContext(p, true);
        } catch {
          c = null;
        }
      }
      if (!c?.contact) {
        try {
          c = await fetchCallContext({ contact_id: contactId }, true);
        } catch (e) {
          setError(errorMessage(e));
          return;
        }
      }
      setCtx(c);
      setError(null);
      onUpdated?.(c);
    },
    [onUpdated],
  );

  /** PATCH the contact; the response replaces the contact in place, nothing else re-fetches. */
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const patchContact = useCallback(
    async (input: UpdateContactInput) => {
      const id = ctx?.contact?.id;
      if (!id) return;
      setSaveState('saving');
      try {
        const r = await api.updateContact(id, input);
        invalidateCallContext();
        setCtx((cur) => (cur ? { ...cur, contact: r.contact } : cur));
        setSaveState('saved');
        onUpdated?.({ ...(ctx as CallContextDto), contact: r.contact });
      } catch (e) {
        setSaveState('error');
        setError(errorMessage(e));
      }
    },
    [ctx, onUpdated],
  );
  useEffect(() => {
    if (saveState !== 'saved') return;
    const t = setTimeout(() => setSaveState('idle'), 2000);
    return () => clearTimeout(t);
  }, [saveState]);

  const phone = ctx?.phone_e164 ?? params?.phone ?? ctx?.contact?.primary_phone ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <HeaderCard
        ctx={ctx}
        phone={phone}
        loading={loading}
        now={now}
        mode={mode}
        onCall={onCall}
        canCall={canCall}
        onText={onText}
        onCreated={onCreated}
      />

      {controlledTab === undefined && (
        <div className="flex items-center justify-between gap-2">
          <Segmented value={tab} onChange={pickTab} options={CALL_CONTEXT_TABS} />
          <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
            {MODE_LABEL[mode]}
          </span>
        </div>
      )}

      {error && (
        <Notice
          tone="error"
          action={
            <Button tone="quiet" onClick={() => void reload()}>
              Retry
            </Button>
          }
        >
          {error}
        </Notice>
      )}

      {tab === 'lead' && (
        <LeadTab ctx={ctx} loading={loading} now={now} saveState={saveState} onPatch={(input) => void patchContact(input)} />
      )}
      {tab === 'script' && <ScriptTab ctx={ctx} loading={loading} callId={callId} />}
      {tab === 'objections' && <ObjectionsTab ctx={ctx} loading={loading} callId={callId} />}
    </div>
  );
}

/* ── Header ───────────────────────────────────────────────────────────────── */

function propertyLine(p: { line1: string | null; city: string | null; state: string | null; postal_code: string | null }): string {
  return oneLineAddress(p);
}

/** "resumes Tue" / "resumes Sep 14" / "resumes 3:00 PM" — the grain a rep on a call needs. */
function resumesLabel(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = t - now;
  const d = new Date(t);
  if (diff < 86_400_000 && d.getDate() === new Date(now).getDate()) {
    return `resumes ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }
  if (diff < 7 * 86_400_000) return `resumes ${d.toLocaleDateString([], { weekday: 'short' })}`;
  return `resumes ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}

function Chip({ icon, children, title }: { icon: IconName; children: ReactNode; title?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={title}
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        background: 'var(--panel-2)',
        font: '600 10.5px/1 Inter',
        color: 'var(--muted)',
        whiteSpace: 'nowrap',
      }}
    >
      <Icon name={icon} size={11} style={{ color: 'var(--accent)' }} />
      {children}
    </span>
  );
}

function HeaderCard({
  ctx,
  phone,
  loading,
  now,
  mode,
  onCall,
  canCall,
  onText,
  onCreated,
}: {
  ctx: CallContextDto | null;
  phone: string | null;
  loading: boolean;
  now: number | null;
  mode: CallContextMode;
  onCall?: CallContextProps['onCall'];
  canCall: boolean;
  onText?: (phone: string) => void;
  onCreated: (contactId: string) => void;
}) {
  const c = ctx?.contact ?? null;
  const lead = ctx?.lead ?? null;
  const name = c?.display_name ?? (loading || (!ctx && phone) ? 'Looking up…' : 'Unknown number');
  const address = ctx?.property ? propertyLine(ctx.property) : c?.address ? oneLineAddress(c.address) : '';
  const rep = lead?.assigned_user_name ?? c?.assigned_user_name ?? null;
  const dnc = c?.status === 'dnc';

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <Avatar name={c?.display_name ?? (phone ? formatPhone(phone) : '?')} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate" style={{ font: '700 15px/1.1 Inter', letterSpacing: '-0.01em', maxWidth: '100%' }}>
              {name}
            </span>
            {c && <TypeBadge type={c.type} />}
            {c && <StatusMark status={c.status} />}
            {c && <TemperatureBadge temperature={c.temperature} score={c.temperature_score} locked={c.temperature_locked} />}
          </div>

          <span
            className="flex flex-wrap items-center gap-x-2 gap-y-1"
            style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)' }}
          >
            <span>
              {phone ? formatPhone(phone) || phone : 'No number on file'}
              {c?.company ? ` · ${c.company}` : ''}
            </span>
            {/* Their clock, in the same words as the call hero and the call bar. */}
            <ProspectTime e164={phone} now={now} size={11.5} />
          </span>

          {(address || lead) && (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)' }}>
              {address && (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="pin" size={12} style={{ color: 'var(--accent)' }} />
                  {address}
                </span>
              )}
              {lead && <StatusMarker color="var(--accent)" label={`Lead · ${lead.status.replace(/_/g, ' ')}`} />}
              {lead?.source && <span style={{ color: 'var(--muted-2)' }}>via {lead.source}</span>}
            </span>
          )}

          {(rep || (ctx && ctx.sequences.length > 0) || ctx?.campaign || lead?.crm_url || (c && c.tags.length > 0)) && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {rep && <Chip icon="user">{rep}</Chip>}
              {ctx?.sequences.map((s) => (
                <Chip key={s.id} icon="forward" title={`${s.name} · ${s.run_status}`}>
                  {s.name} · Step {s.step}/{s.step_count}
                  {s.resume_at && now !== null ? ` · ${resumesLabel(s.resume_at, now)}` : ''}
                </Chip>
              ))}
              {ctx?.campaign && <Chip icon="transfer">{ctx.campaign.name}</Chip>}
              {lead?.crm_url && (
                <a
                  href={lead.crm_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1"
                  style={{ font: '600 10.5px/1 Inter', color: 'var(--accent)', padding: '3px 2px' }}
                >
                  Open in CRM
                  <Icon name="forward" size={11} />
                </a>
              )}
              {c?.tags.map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {onCall && phone && mode !== 'incall' && (
            <Button
              tone="green"
              disabled={!canCall || dnc}
              title={dnc ? 'Do not call' : canCall ? `Call ${formatPhone(phone)}` : 'Softphone not ready, or a call is in progress'}
              onClick={() =>
                onCall({
                  to_number: phone,
                  ...(ctx?.lead?.id ? { lead_id: ctx.lead.id } : {}),
                  ...(c?.id ? { contact_id: c.id } : {}),
                })
              }
            >
              <Icon name="phone" size={14} />
              Call
            </Button>
          )}
          {onText && phone && (
            <Button tone="ghost" onClick={() => onText(phone)} style={{ padding: '7px 10px', font: '600 11.5px/1 Inter' }}>
              <Icon name="msg" size={13} />
              Text
            </Button>
          )}
          {c && (
            <Link
              href={`/contacts/${encodeURIComponent(c.id)}`}
              className="inline-flex items-center gap-1"
              style={{ font: '600 11px/1 Inter', color: 'var(--muted)', padding: '4px 2px' }}
            >
              Open contact
              <Icon name="chevron-right" size={12} />
            </Link>
          )}
        </div>
      </div>

      {ctx && !c && !loading && <QuickAdd phone={ctx.suggest_create?.phone_e164 ?? phone} onCreated={onCreated} />}
    </Card>
  );
}

/** Name + type + Save: a contact exists before the greeting is over. */
function QuickAdd({ phone, onCreated }: { phone: string | null; onCreated: (contactId: string) => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<ContactType>('seller');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    const display_name = name.trim();
    if (!display_name || !phone || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createContact({ display_name, type, phone });
      onCreated(r.contact.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const existing = typeof e.body?.contact_id === 'string' ? e.body.contact_id : null;
        if (existing) {
          onCreated(existing);
          return;
        }
        setErr('A contact already has this number.');
      } else {
        setErr(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 pt-3"
      style={{ borderTop: '1px solid var(--line)' }}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Eyebrow>New contact for this number</Eyebrow>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Their name"
          aria-label="Contact name"
          className="flex-1"
          style={{ minWidth: 150 }}
          disabled={busy || !phone}
        />
        <div className="max-w-full overflow-x-auto">
          <Segmented value={type} onChange={setType} options={CONTACT_TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))} />
        </div>
        <Button type="submit" tone="accent" disabled={!name.trim() || !phone || busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {err && <span style={{ font: '500 11.5px/1.3 Inter', color: 'var(--red)' }}>{err}</span>}
    </form>
  );
}

/* ── Lead tab ─────────────────────────────────────────────────────────────── */

function LeadTab({
  ctx,
  loading,
  now,
  saveState,
  onPatch,
}: {
  ctx: CallContextDto | null;
  loading: boolean;
  now: number | null;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onPatch: (input: UpdateContactInput) => void;
}) {
  if (!ctx) {
    return (
      <Card>
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to see who it is.'}</p>
      </Card>
    );
  }
  const c = ctx.contact;
  const summary = ctx.last_call_summary;
  const rows = ctx.activity.slice(0, 10);

  return (
    <>
      {c ? (
        <NotesCard contact={c} saveState={saveState} onPatch={onPatch} />
      ) : (
        <Card>
          <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Save the contact above to keep notes, status, temperature and tags on this number.</p>
        </Card>
      )}

      {summary && (
        <Card className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <Eyebrow>Last call</Eyebrow>
            <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>{now === null ? '' : timeAgo(summary.at, now)}</span>
          </div>
          <p style={{ font: '400 12.5px/1.55 Inter' }}>{summary.summary}</p>
          {summary.next_steps.length > 0 && (
            <div className="flex flex-col gap-1">
              <Eyebrow>Next steps</Eyebrow>
              <ul className="flex flex-col gap-1 pl-4" style={{ listStyle: 'disc' }}>
                {summary.next_steps.map((s, i) => (
                  <li key={i} style={{ font: '400 12px/1.45 Inter' }}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {summary.objections.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Eyebrow>Objections heard</Eyebrow>
              {summary.objections.map((o, i) => (
                <TagChip key={`${o}-${i}`}>{o}</TagChip>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-1.5">
        {ctx.open_tasks.length > 0 && (
          <div className="flex flex-col pb-2" style={{ borderBottom: '1px solid var(--line)' }}>
            <Eyebrow className="pb-1.5">Open tasks</Eyebrow>
            {ctx.open_tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2.5 py-1.5">
                <span
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
                  style={{ borderRadius: 8, background: 'var(--panel-2)', color: 'var(--amber)' }}
                >
                  <Icon name="check" size={12} />
                </span>
                <span className="mr-auto min-w-0 truncate" style={{ font: '600 12px/1 Inter' }}>
                  {t.title}
                </span>
                <span className="shrink-0" style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
                  {[
                    t.due_at ? `due ${new Date(t.due_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : null,
                    t.assigned_user_name,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center justify-between pb-1">
          <Eyebrow>Recent activity</Eyebrow>
          <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
            {ctx.activity.length === 0 ? '' : `last ${rows.length}`}
          </span>
        </div>
        {rows.length === 0 ? (
          <EmptyState compact icon="clock" title="Nothing yet" hint="The first call or text with this number shows up here." />
        ) : (
          <ul>
            {rows.map((a) => (
              <ActivityRow key={`${a.kind}-${a.id}`} a={a} now={now} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function pick<T extends string>(list: readonly T[], value: string): T | null {
  return list.find((x) => x === value) ?? null;
}

/** Contact notes, status, temperature and tags — every field saves in place. */
function NotesCard({
  contact: c,
  saveState,
  onPatch,
}: {
  contact: ContactDto;
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  onPatch: (input: UpdateContactInput) => void;
}) {
  const busy = saveState === 'saving';
  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <Eyebrow>Notes</Eyebrow>
        <span
          aria-live="polite"
          style={{
            font: '600 10px/1 Inter',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: saveState === 'error' ? 'var(--red)' : saveState === 'saved' ? 'var(--green)' : 'var(--muted-2)',
            minHeight: 10,
          }}
        >
          {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
        </span>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Labeled label="Status">
          <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 0 0 11px' }}>
            <span style={{ width: 6, height: 6, background: STATUS_COLOR[c.status], flexShrink: 0 }} aria-hidden />
            <select
              value={c.status}
              disabled={busy}
              aria-label="Status"
              onChange={(e) => {
                const next = pick(CONTACT_STATUSES, e.target.value);
                if (next && next !== c.status) onPatch({ status: next });
              }}
              className="min-w-0 flex-1"
              style={{ border: 'none', background: 'transparent', padding: '9px 8px 9px 0', font: '500 12.5px/1 Inter', color: 'var(--text)', outline: 'none' }}
            >
              {CONTACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </span>
        </Labeled>
        <Labeled label={c.temperature_locked ? 'Temperature · set by hand' : 'Temperature'}>
          <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 6px 0 11px' }}>
            <TempDot temperature={c.temperature} score={c.temperature_score} />
            <select
              value={c.temperature}
              disabled={busy}
              aria-label="Temperature"
              title="Choosing a temperature locks it; the score stops moving it until unlocked on the contact page."
              onChange={(e) => {
                const next = pick(TEMPERATURES, e.target.value);
                if (next && next !== c.temperature) onPatch({ temperature: next });
              }}
              className="min-w-0 flex-1"
              style={{
                border: 'none',
                background: 'transparent',
                padding: '9px 4px 9px 0',
                font: '600 12.5px/1 Inter',
                color: BAND_COLOR[tempBand(c.temperature, c.temperature_score)],
                outline: 'none',
              }}
            >
              {TEMPERATURES.map((t) => (
                <option key={t} value={t}>
                  {TEMP_LABEL[t]}
                </option>
              ))}
            </select>
            <span className="pl-2" style={{ borderLeft: '1px solid var(--line)', font: '600 11px/1 Inter', color: 'var(--muted)' }} title="Engagement score, 0–100°">
              {degrees(c.temperature_score)}
            </span>
          </span>
        </Labeled>
      </div>

      <TagsField tags={c.tags} disabled={busy} onChange={(tags) => onPatch({ tags })} placeholder="Add a tag" />

      <textarea
        key={c.notes ?? ''}
        defaultValue={c.notes ?? ''}
        placeholder="Anything the next rep should know — saved when you click away"
        rows={4}
        disabled={busy}
        aria-label="Contact notes"
        onBlur={(e) => {
          const next = e.target.value.trim() || null;
          if (next !== c.notes) onPatch({ notes: next });
        }}
        className="min-w-0"
        style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical' }}
      />
    </Card>
  );
}

const KIND_ICON: Record<CallContextActivityDto['kind'], IconName> = { call: 'phone', sms: 'msg', task: 'check' };

function ActivityRow({ a, now }: { a: CallContextActivityDto; now: number | null }) {
  const inbound = a.direction === 'inbound';
  const missed = a.kind === 'call' && (a.status === 'no_answer' || a.status === 'busy' || a.status === 'failed');
  const color = missed ? 'var(--red)' : a.kind === 'task' ? 'var(--amber)' : inbound ? 'var(--green)' : 'var(--accent)';
  const title =
    a.kind === 'task'
      ? 'Task'
      : `${a.direction === 'inbound' ? 'Inbound' : a.direction === 'outbound' ? 'Outbound' : ''} ${a.kind === 'call' ? 'call' : 'text'}`.trim();
  const facts = [
    a.kind === 'call' && a.duration_seconds !== null && a.duration_seconds > 0 ? duration(a.duration_seconds) : null,
    a.status ? a.status.replace(/_/g, ' ') : null,
    a.disposition_label,
    a.user_name,
  ].filter(Boolean);
  const text = a.note ?? a.body;
  return (
    <li className="flex gap-3 py-2.5" style={{ borderBottom: '1px solid var(--panel-2)' }}>
      <span
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
        style={{ borderRadius: 8, background: 'var(--panel-2)', color }}
        aria-hidden
      >
        <Icon name={KIND_ICON[a.kind]} size={12} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2">
          <span className="mr-auto truncate" style={{ font: '600 12px/1 Inter' }}>
            {title}
          </span>
          <span className="shrink-0" style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
            {now === null ? '' : timeAgo(a.at, now)}
          </span>
        </span>
        {facts.length > 0 && (
          <span
            className="truncate"
            style={{ font: '500 9.5px/1 Inter', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted-2)' }}
          >
            {facts.join(' · ')}
          </span>
        )}
        {text && (
          <span style={{ font: '400 11.5px/1.45 Inter', color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{text}</span>
        )}
      </span>
    </li>
  );
}

/* ── Script tab ───────────────────────────────────────────────────────────── */

function ScriptTab({ ctx, loading, callId }: { ctx: CallContextDto | null; loading: boolean; callId?: string }) {
  const primary = ctx?.scripts.primary ?? null;
  const alternatives = useMemo(() => ctx?.scripts.alternatives ?? [], [ctx]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Alternatives arrive as id + title only; their bodies are fetched one at a
  // time and kept, so flipping back to one already read costs nothing.
  const [fetched, setFetched] = useState<Record<string, ScriptDto>>({});
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [large, setLarge] = useState(largeType);
  const [used, setUsed] = useState<'idle' | 'busy' | 'done'>('idle');

  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;

  // A new party starts on its own primary script.
  useEffect(() => {
    setSelectedId(null);
    setUsed('idle');
    setFetchError(null);
  }, [primary?.id, ctx?.contact?.id]);

  /**
   * The picked alternative's body: GET /v1/scripts/:id, merged in the browser
   * with this party's merge_fields — the same grammar the server renders
   * `rendered_body` with. A body already read is not asked for again.
   */
  useEffect(() => {
    const id = selectedId;
    if (!id || fetchedRef.current[id]) return;
    let alive = true;
    setFetchError(null);
    api
      .getScript(id)
      .then((r) => {
        if (alive) setFetched((cur) => ({ ...cur, [id]: r.script }));
      })
      .catch((e: unknown) => {
        if (alive) setFetchError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [selectedId, retry]);

  const choose = (id: string) => {
    setSelectedId(id === primary?.id ? null : id);
    setUsed('idle');
  };

  const current: { id: string; title: string; category: string | null; body: string } | null = useMemo(() => {
    if (!ctx) return null;
    if (selectedId === null) return primary ? { id: primary.id, title: primary.title, category: primary.category, body: primary.rendered_body } : null;
    const s = fetched[selectedId];
    if (!s) return null;
    return { id: s.id, title: s.title, category: s.category, body: renderScriptMerge(s.body, ctx.merge_fields) };
  }, [ctx, selectedId, primary, fetched]);

  const markUsed = async () => {
    if (!current || used !== 'idle') return;
    setUsed('busy');
    try {
      await api.scriptUsed(current.id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact?.id ? { contact_id: ctx.contact.id } : {}),
      });
      setUsed('done');
    } catch {
      setUsed('idle');
    }
  };

  const options = [
    ...(primary ? [{ id: primary.id, title: primary.title, category: primary.category }] : []),
    ...alternatives.filter((a) => a.id !== primary?.id),
  ];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {options.length > 1 ? (
          <Select
            value={selectedId ?? primary?.id ?? ''}
            onChange={(e) => choose(e.target.value)}
            aria-label="Script"
            className="min-w-0 flex-1"
            style={{ minWidth: 160 }}
          >
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
                {o.category ? ` · ${o.category}` : ''}
              </option>
            ))}
          </Select>
        ) : (
          <span className="mr-auto min-w-0 truncate" style={{ font: '700 13px/1 Inter' }}>
            {current?.title ?? 'Script'}
            {current?.category && <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}> · {current.category}</span>}
          </span>
        )}
        <Segmented
          value={large ? 'large' : 'normal'}
          onChange={(v) => {
            const next = v === 'large';
            setLarge(next);
            largeType = next;
          }}
          options={[
            { value: 'normal', label: 'A' },
            { value: 'large', label: 'A+' },
          ]}
        />
        {current && (
          <Button tone="ghost" onClick={() => void markUsed()} disabled={used !== 'idle'} style={{ padding: '7px 10px', font: '600 11px/1 Inter' }}>
            <Icon name="check" size={12} />
            {used === 'done' ? 'Logged' : used === 'busy' ? '…' : 'Mark used'}
          </Button>
        )}
      </div>

      {!ctx ? (
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to load its script.'}</p>
      ) : fetchError && selectedId !== null ? (
        <Notice
          tone="error"
          action={
            <Button tone="quiet" onClick={() => setRetry((n) => n + 1)}>
              Retry
            </Button>
          }
        >
          {fetchError}
        </Notice>
      ) : selectedId !== null && !current ? (
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Loading script…</p>
      ) : !current ? (
        <EmptyState
          title="No script for this contact yet"
          hint="Scripts are matched by contact type and campaign. Add one, or import the example playbook."
          action={
            <Link href="/scripts" style={{ font: '600 12px/1 Inter', color: 'var(--accent)' }}>
              Manage scripts
            </Link>
          }
        />
      ) : (
        <ScriptBody body={current.body} large={large} collapsible />
      )}
    </Card>
  );
}

/* ── Objections tab ───────────────────────────────────────────────────────── */

function ObjectionsTab({ ctx, loading, callId }: { ctx: CallContextDto | null; loading: boolean; callId?: string }) {
  const rebuttals = useMemo(() => ctx?.scripts.rebuttals ?? [], [ctx]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const tags = useMemo(() => {
    const seen = new Set<string>();
    for (const r of rebuttals) {
      if (r.category) seen.add(r.category);
      for (const t of r.tags) seen.add(t);
    }
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [rebuttals]);

  const needle = q.trim().toLowerCase();
  const shown = rebuttals.filter(
    (r) =>
      (!tag || r.category === tag || r.tags.includes(tag)) &&
      (!needle || `${r.title} ${r.rendered_body}`.toLowerCase().includes(needle)),
  );

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  const used = async (id: string) => {
    setErr(null);
    try {
      await api.scriptUsed(id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact?.id ? { contact_id: ctx.contact.id } : {}),
      });
      setFlash(id);
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  return (
    <Card className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 px-3 py-2" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--bg)' }}>
        <Icon name="search" size={14} style={{ color: 'var(--muted-2)' }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="What did they say? “too low”, “not selling”, “agent”…"
          aria-label="Search rebuttals"
          className="min-w-0 flex-1 bg-transparent outline-none"
          style={{ font: '400 12.5px/1 Inter' }}
        />
        {q && (
          <button type="button" onClick={() => setQ('')} aria-label="Clear search" style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={tag === null} onClick={() => setTag(null)}>
            All
          </FilterChip>
          {tags.map((t) => (
            <FilterChip key={t} active={tag === t} onClick={() => setTag(tag === t ? null : t)}>
              {t}
            </FilterChip>
          ))}
        </div>
      )}

      {err && <Notice tone="error">{err}</Notice>}

      {!ctx ? (
        <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>{loading ? 'Loading…' : 'Type or pick a number to load rebuttals.'}</p>
      ) : rebuttals.length === 0 ? (
        <EmptyState
          title="No rebuttals yet"
          hint="Add objection rebuttals under Scripts, or import the example playbook."
          action={
            <Link href="/scripts" style={{ font: '600 12px/1 Inter', color: 'var(--accent)' }}>
              Manage scripts
            </Link>
          }
        />
      ) : shown.length === 0 ? (
        <EmptyState compact icon="search" title="Nothing matches" hint="Try another word, or clear the filter above." />
      ) : (
        <ul className="flex flex-col">
          {shown.map((r) => {
            const isOpen = open === r.id;
            return (
              <li key={r.id} style={{ borderBottom: '1px solid var(--panel-2)' }}>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : r.id)}
                  aria-expanded={isOpen}
                  className="lift-row flex w-full items-center gap-2.5 py-2.5 text-left"
                  // No inline `background`: it would outrank the .lift-row hover.
                  style={{ border: '1px solid transparent', borderRadius: 8, cursor: 'pointer', padding: '10px 6px' }}
                >
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={13} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
                  <span className="mr-auto min-w-0 truncate" style={{ font: '600 12.5px/1 Inter' }}>
                    {r.title}
                  </span>
                  {r.category && (
                    <span className="shrink-0" style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted-2)' }}>
                      {r.category}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="flex flex-col gap-2.5 pb-3 pl-6">
                    <ScriptBody body={r.rendered_body} large={largeType} />
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        tone={flash === r.id ? 'green' : 'ghost'}
                        onClick={() => void used(r.id)}
                        style={{ padding: '7px 10px', font: '600 11px/1 Inter' }}
                      >
                        <Icon name="check" size={12} />
                        {flash === r.id ? 'Logged' : 'Used'}
                      </Button>
                      {r.tags.map((t) => (
                        <TagChip key={t}>{t}</TagChip>
                      ))}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/* ── Script body ──────────────────────────────────────────────────────────── */

function Inline({ text }: { text: string }) {
  return (
    <>
      {inlineRuns(text).map((run, i) =>
        run.kind === 'bold' ? (
          <strong key={i} style={{ fontWeight: 700 }}>
            {run.text}
          </strong>
        ) : run.kind === 'token' ? (
          <span key={i} title="No value for this field" style={{ color: 'var(--accent)', background: 'var(--accent-soft)', borderRadius: 4, padding: '0 3px' }}>
            {run.text}
          </span>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

function Block({ block, size, lh }: { block: ScriptBlock; size: number; lh: number }) {
  if (block.type === 'ul') {
    return (
      <ul className="flex flex-col gap-1 pl-5" style={{ listStyle: 'disc' }}>
        {block.items.map((item, i) => (
          <li key={i} style={{ font: `400 ${size}px/${lh} Inter` }}>
            <Inline text={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === 'note') {
    return (
      <p style={{ margin: 0, borderLeft: '2px solid var(--accent)', paddingLeft: 10, color: 'var(--muted)', font: `500 ${size - 1}px/${lh} Inter` }}>
        <Inline text={block.text} />
      </p>
    );
  }
  return (
    <p style={{ margin: 0, font: `400 ${size}px/${lh} Inter` }}>
      <Inline text={block.text} />
    </p>
  );
}

/**
 * Markdown-lite renderer for script bodies: `## ` sections (collapsible when
 * asked), `- ` bullets, `**bold**`, `> ` notes, and `{merge}` tokens that were
 * left unfilled shown in the accent so the rep knows to improvise a word.
 */
export function ScriptBody({ body, large = false, collapsible = false }: { body: string; large?: boolean; collapsible?: boolean }) {
  const sections = useMemo(() => parseScript(body), [body]);
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  useEffect(() => setClosed({}), [body]);
  const size = large ? 16.5 : 13.5;
  const lh = large ? 1.6 : 1.55;

  if (sections.length === 0) {
    return <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Empty script.</p>;
  }

  return (
    <div className="flex flex-col gap-3.5">
      {sections.map((s, i) => {
        const isClosed = collapsible && Boolean(closed[i]);
        const titleStyle = { font: `700 ${large ? 14 : 12.5}px/1.2 Inter`, letterSpacing: '-0.01em' } as const;
        return (
          <section key={i} className="flex flex-col gap-2">
            {s.title !== null &&
              (collapsible ? (
                <button
                  type="button"
                  onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))}
                  aria-expanded={!isClosed}
                  className="flex items-center gap-1.5 text-left"
                  style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
                >
                  <Icon name={isClosed ? 'chevron-right' : 'chevron-down'} size={13} style={{ color: 'var(--muted-2)' }} />
                  <span style={titleStyle}>{s.title}</span>
                </button>
              ) : (
                <span style={titleStyle}>{s.title}</span>
              ))}
            {!isClosed && s.blocks.map((b, j) => <Block key={j} block={b} size={size} lh={lh} />)}
          </section>
        );
      })}
    </div>
  );
}
