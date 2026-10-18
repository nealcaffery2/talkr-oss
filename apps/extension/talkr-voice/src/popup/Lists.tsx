/**
 * The popup's list screens, iPhone-style: Inbox (texts and calls together, the
 * way CLOZR's inbox shows them, minus email), Recents, Voicemail, and the
 * caller-ID sheet. Rows open the lead; the round buttons call back.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icon, type IconName } from '@/shared/Icon';
import { Avatar } from '@/shared/ui';
import { api, type ConversationDto, type HistoryItemDto, type MeDto } from '@/shared/api';
import { duration, formatPhone, stamp } from '@/shared/time';
import { callLineId, inboxLineOptions, lineLabel, threadLineId } from '@/shared/lines';

/** The number on the other end of a call, whichever way it went. */
export function theirNumber(c: HistoryItemDto): string {
  return c.direction === 'inbound' ? c.from_number : c.to_number;
}

/**
 * The caller was sent to voicemail and left something. Servers that predate the
 * `voicemail` flag get CLOZR's test instead (inbound, recorded, nobody's name
 * on it), which misses a voicemail routed to one rep.
 */
export function isVoicemail(c: HistoryItemDto): boolean {
  if (c.kind !== 'call' || c.direction !== 'inbound' || !c.has_recording) return false;
  return c.voicemail ?? !c.user_name;
}

export function isMissed(c: HistoryItemDto): boolean {
  return c.direction === 'inbound' && !c.duration_seconds && !isVoicemail(c);
}

function callLine(c: HistoryItemDto): string {
  const what = isVoicemail(c) ? 'Voicemail' : c.direction === 'inbound' ? (isMissed(c) ? 'Missed' : 'Incoming') : 'Outgoing';
  const how = c.duration_seconds ? duration(c.duration_seconds) : c.status.replace(/_/g, ' ');
  return [what, how, c.disposition_label, c.note ? `“${c.note}”` : null].filter(Boolean).join(' · ');
}

function textLine(c: ConversationDto): string {
  const m = c.last_message;
  if (!m) return formatPhone(c.their_number);
  const body = m.body || (m.media_count ? 'Photo' : '');
  return m.direction === 'outbound' ? `You: ${body}` : body;
}

const ROUND_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  width: 30,
  height: 30,
  borderRadius: '50%',
  border: 'none',
};

function Row({
  name,
  preview,
  at,
  now,
  unread,
  icon,
  iconColor,
  onOpen,
  onCall,
  children,
}: {
  name: string;
  preview: string;
  at: string;
  now: number;
  unread: boolean;
  icon: IconName;
  iconColor: string;
  onOpen: () => void;
  onCall?: () => void;
  children?: ReactNode;
}) {
  return (
    <div style={{ borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px 10px 6px' }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            flexShrink: 0,
            borderRadius: '50%',
            background: unread ? 'var(--accent)' : 'transparent',
          }}
        />
        <button
          type="button"
          onClick={onOpen}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            border: 'none',
            background: 'transparent',
            padding: 0,
            textAlign: 'left',
            color: 'inherit',
          }}
        >
          <Avatar name={name} size={38} />
          <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name={icon} size={12} style={{ color: iconColor, flexShrink: 0 }} />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  font: `${unread ? 700 : 600} 13px/1.1 Inter`,
                  color: iconColor === 'var(--red)' ? 'var(--red)' : 'var(--text)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {name}
              </span>
              <span style={{ flexShrink: 0, font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                {stamp(at, now)}
              </span>
            </span>
            <span
              style={{
                font: '400 11.5px/1.35 Inter',
                color: 'var(--muted)',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
              }}
            >
              {preview}
            </span>
          </span>
        </button>
        {onCall && (
          <button
            type="button"
            aria-label={`Call ${name}`}
            title="Call back"
            onClick={onCall}
            style={{ ...ROUND_BTN, background: 'var(--green)', color: '#fff' }}
          >
            <Icon name="phone" size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/** iPhone-style segmented control. */
export function Segments<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, background: 'var(--panel-2)' }}>
      {options.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => onChange(id)}
          style={{
            flex: 1,
            height: 26,
            borderRadius: 7,
            border: 'none',
            background: value === id ? 'var(--panel)' : 'transparent',
            boxShadow: value === id ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
            color: value === id ? 'var(--text)' : 'var(--muted)',
            font: '600 11.5px/1 Inter',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p style={{ padding: '24px 16px', margin: 0, font: '400 12px/1.5 Inter', color: 'var(--muted)', textAlign: 'center' }}>{children}</p>;
}

function ListHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div style={{ padding: '10px 14px 8px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ font: '700 20px/1 Inter', letterSpacing: '-0.02em' }}>{title}</div>
      {children}
    </div>
  );
}

type InboxFilter = 'all' | 'texts' | 'calls' | 'unread';

export function InboxList({
  conversations,
  calls,
  now,
  me,
  onOpenThread,
  onOpenLead,
  onCall,
}: {
  conversations: ConversationDto[];
  calls: HistoryItemDto[];
  now: number;
  /** For the line filter: the rep's lines and the org's, to name them. */
  me: MeDto | null;
  onOpenThread: (id: string) => void;
  onOpenLead: (e164: string) => void;
  onCall: (e164: string) => void;
}) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  // One sending number only (CLOZR's `line` filter), over the rep's own threads and calls.
  const [line, setLine] = useState('');
  const lines = useMemo(() => inboxLineOptions(me, conversations), [me, conversations]);
  const onLine = line && lines.some((n) => n.id === line) ? line : '';
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const digits = needle.replace(/\D/g, '');
  const matches = (name: string | null, number: string) =>
    !needle || (name ?? '').toLowerCase().includes(needle) || (digits.length > 2 && number.includes(digits));

  type Item = { at: string; node: ReactNode };
  const items: Item[] = [];
  if (filter !== 'calls') {
    for (const c of conversations) {
      if (filter === 'unread' && c.unread_count === 0) continue;
      if (onLine && threadLineId(c, me) !== onLine) continue;
      if (!matches(c.contact_name, c.their_number)) continue;
      const name = c.contact_name ?? formatPhone(c.their_number);
      items.push({
        at: c.last_message_at ?? '1970-01-01',
        node: (
          <Row
            key={`t${c.id}`}
            name={name}
            preview={textLine(c)}
            at={c.last_message_at ?? ''}
            now={now}
            unread={c.unread_count > 0}
            icon="msg"
            iconColor="var(--accent)"
            onOpen={() => onOpenThread(c.id)}
          />
        ),
      });
    }
  }
  if (filter !== 'texts') {
    for (const c of calls) {
      const number = theirNumber(c);
      if (filter === 'unread' && !isMissed(c) && !isVoicemail(c)) continue;
      if (onLine && callLineId(c, me) !== onLine) continue;
      if (!matches(c.contact_name, number)) continue;
      items.push({
        at: c.at,
        node: (
          <Row
            key={`c${c.id}`}
            name={c.contact_name ?? formatPhone(number)}
            preview={callLine(c)}
            at={c.at}
            now={now}
            unread={isMissed(c) || isVoicemail(c)}
            icon={isVoicemail(c) ? 'voicemail' : 'phone'}
            iconColor={isMissed(c) ? 'var(--red)' : isVoicemail(c) ? 'var(--amber)' : 'var(--green)'}
            onOpen={() => onOpenLead(number)}
            onCall={() => onCall(number)}
          />
        ),
      });
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ListHeader title="Inbox">
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 30,
            padding: '0 10px',
            borderRadius: 9,
            background: 'var(--panel-2)',
            color: 'var(--muted)',
          }}
        >
          <Icon name="search" size={13} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or number"
            aria-label="Search"
            style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 12.5px/1 Inter' }}
          />
        </label>
        <Segments
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All'],
            ['texts', 'Texts'],
            ['calls', 'Calls'],
            ['unread', 'Unread'],
          ]}
        />
        {lines.length > 1 && (
          <select
            value={onLine}
            onChange={(e) => setLine(e.target.value)}
            aria-label="Line"
            style={{
              height: 28,
              padding: '0 8px',
              borderRadius: 9,
              border: 'none',
              background: 'var(--panel-2)',
              color: onLine ? 'var(--text)' : 'var(--muted)',
              font: '500 12px/1 Inter',
            }}
          >
            <option value="">All lines</option>
            {lines.map((n) => (
              <option key={n.id} value={n.id}>
                {lineLabel(n, formatPhone)}
              </option>
            ))}
          </select>
        )}
      </ListHeader>
      <div className="scroll" style={{ flex: 1 }}>
        {items.length === 0 ? <Empty>{needle ? 'Nothing matches.' : 'Nothing here yet.'}</Empty> : items.slice(0, 200).map((i) => i.node)}
      </div>
    </div>
  );
}

export function RecentsList({
  calls,
  now,
  onOpenLead,
  onCall,
}: {
  calls: HistoryItemDto[];
  now: number;
  onOpenLead: (e164: string) => void;
  onCall: (e164: string) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'missed'>('all');
  const shown = filter === 'missed' ? calls.filter(isMissed) : calls;
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ListHeader title="Recents">
        <Segments value={filter} onChange={setFilter} options={[['all', 'All'], ['missed', 'Missed']]} />
      </ListHeader>
      <div className="scroll" style={{ flex: 1 }}>
        {shown.length === 0 && <Empty>{filter === 'missed' ? 'No missed calls.' : 'No calls in the last 90 days.'}</Empty>}
        {shown.map((c) => {
          const number = theirNumber(c);
          return (
            <Row
              key={c.id}
              name={c.contact_name ?? formatPhone(number)}
              preview={callLine(c)}
              at={c.at}
              now={now}
              unread={false}
              icon={isVoicemail(c) ? 'voicemail' : c.direction === 'inbound' ? 'phone' : 'forward'}
              iconColor={isMissed(c) ? 'var(--red)' : 'var(--muted-2)'}
              onOpen={() => onOpenLead(number)}
              onCall={() => onCall(number)}
            />
          );
        })}
      </div>
    </div>
  );
}

/** Fetches the recording with the rep's bearer and plays it with the browser's own controls. */
function VoicemailPlayer({ callId }: { callId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    api
      .callRecordings(callId)
      .then(async ({ recordings }) => {
        const rec = recordings.find((r) => r.status === 'completed') ?? recordings[0];
        if (!rec) throw new Error('No recording on this call.');
        const blob = await api.recordingAudio(rec.id);
        if (!alive) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [callId]);
  if (error) return <p style={{ margin: 0, font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>;
  if (!src) return <p style={{ margin: 0, font: '400 11px/1.4 Inter', color: 'var(--muted)' }}>Loading…</p>;
  return <audio src={src} controls autoPlay style={{ width: '100%', height: 32 }} />;
}

export function VoicemailList({
  calls,
  now,
  onOpenLead,
  onCall,
}: {
  calls: HistoryItemDto[];
  now: number;
  onOpenLead: (e164: string) => void;
  onCall: (e164: string) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const voicemails = calls.filter(isVoicemail);
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <ListHeader title="Voicemail" />
      <div className="scroll" style={{ flex: 1 }}>
        {voicemails.length === 0 && <Empty>No voicemails in the last 90 days.</Empty>}
        {voicemails.map((c) => {
          const number = theirNumber(c);
          const open = playing === c.id;
          return (
            <Row
              key={c.id}
              name={c.contact_name ?? formatPhone(number)}
              preview={[formatPhone(number), c.address, c.duration_seconds ? duration(c.duration_seconds) : null]
                .filter(Boolean)
                .join(' · ')}
              at={c.at}
              now={now}
              unread={false}
              icon="voicemail"
              iconColor="var(--amber)"
              onOpen={() => setPlaying(open ? null : c.id)}
              onCall={() => onCall(number)}
            >
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 12px 12px 22px' }}>
                  <VoicemailPlayer callId={c.id} />
                  <button
                    type="button"
                    onClick={() => onOpenLead(number)}
                    style={{
                      alignSelf: 'flex-start',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      border: 'none',
                      background: 'transparent',
                      padding: 0,
                      color: 'var(--accent)',
                      font: '600 11.5px/1 Inter',
                    }}
                  >
                    <Icon name="user" size={12} />
                    View lead
                  </button>
                </div>
              )}
            </Row>
          );
        })}
      </div>
    </div>
  );
}

/** What the "Calling from" row says for the rep's current setting. */
export function callerIdLabel(me: MeDto | null): string {
  if (!me) return 'Your assigned number';
  if (me.caller_id_mode === 'local_presence') return 'Local presence · matches their area code';
  const n =
    me.org_numbers?.find((o) => o.id === me.default_phone_number_id) ?? me.numbers?.[0] ?? null;
  return n ? `${n.label ? `${n.label} · ` : ''}${formatPhone(n.phone_e164)}` : 'Your assigned number';
}

/**
 * Pick the number to call from. Saved as the rep's default (PATCH /v1/me), the
 * same setting CLOZR and the web app read, so all three dial out on one line.
 */
export function CallerIdSheet({ me, onClose, onSaved }: { me: MeDto; onClose: () => void; onSaved: () => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = me.caller_id_mode === 'local_presence';

  async function choose(key: string, input: Parameters<typeof api.updateMe>[0]) {
    setSaving(key);
    setError(null);
    try {
      await api.updateMe(input);
      onSaved();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const option = (key: string, title: string, sub: string, selected: boolean, onPick: () => void) => (
    <button
      key={key}
      type="button"
      disabled={saving !== null}
      onClick={onPick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '11px 14px',
        border: 'none',
        borderBottom: '1px solid var(--line-soft)',
        background: 'transparent',
        textAlign: 'left',
        color: 'inherit',
      }}
    >
      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={{ font: '600 13px/1.1 Inter' }}>{title}</span>
        <span style={{ font: '400 11px/1.3 Inter', color: 'var(--muted)' }}>{sub}</span>
      </span>
      {saving === key ? (
        <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>Saving…</span>
      ) : (
        selected && <Icon name="check" size={16} style={{ color: 'var(--accent)' }} />
      )}
    </button>
  );

  return (
    <div
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 5, background: 'rgba(0,0,0,.32)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--panel)', borderRadius: '16px 16px 0 0', maxHeight: '80%', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '12px 14px', borderBottom: '1px solid var(--line)' }}>
          <span style={{ font: '700 14px/1 Inter', marginRight: 'auto' }}>Call from</span>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'transparent', color: 'var(--accent)', font: '600 12px/1 Inter' }}
          >
            Done
          </button>
        </div>
        {error && <p style={{ margin: 0, padding: '8px 14px', font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
        <div className="scroll" style={{ flex: 1 }}>
          {option('local', 'Local presence', 'A number with the same area code as the person you call', local, () =>
            void choose('local', { caller_id_mode: 'local_presence' }),
          )}
          {(me.org_numbers ?? []).map((n) =>
            option(
              n.id,
              formatPhone(n.phone_e164),
              [
                n.label,
                n.assigned_user_id === me.id
                  ? 'Your line'
                  : n.assigned_user_id
                    ? `${n.assigned_user_name ?? 'A teammate'}'s line`
                    : 'Shared line',
              ]
                .filter(Boolean)
                .join(' · '),
              !local && me.default_phone_number_id === n.id,
              () => void choose(n.id, { caller_id_mode: 'dedicated', default_phone_number_id: n.id }),
            ),
          )}
        </div>
      </div>
    </div>
  );
}
