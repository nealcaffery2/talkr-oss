'use client';

/**
 * Team board (design 1c): one card per teammate, dominated by their local
 * time. A rep about to transfer a seller needs to know it is 11pm for the
 * person they were about to hand it to — that is the whole point of the page.
 *
 * Owners and admins also run the team from here — add someone, change a role
 * or title, set the caller-ID number, disable — because the roster is where
 * you notice the problem. Everyone else sees exactly the board.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AuthInviteOutcome,
  type CreateTeamMemberInput,
  type MeDto,
  type PhoneNumberDto,
  type TeamMemberAdminDto,
  type TeamMemberDto,
  type TeamRole,
  type UpdateTeamMemberInput,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Eyebrow,
  Input,
  Labeled,
  Notice,
  SectionTitle,
  Select,
  StatusMarker,
} from '@/components/ui';
import { CopyButton } from '@/components/CopyPhone';
import { callWindow, formatPhone, tzAbbr, tzCity, tzTime } from '@/lib/time';

const PRESENCE_COLOR: Record<string, string> = {
  available: 'var(--green)',
  away: 'var(--amber)',
  offline: 'var(--muted-2)',
};

/** Not a presence: the chip for someone who cannot be on the floor at all yet. */
const STATUS_COLOR: Record<string, string> = {
  invited: 'var(--amber)',
  disabled: 'var(--muted-2)',
};

const ROLE_LABEL: Record<TeamRole, string> = { rep: 'Rep', manager: 'Manager', admin: 'Admin', owner: 'Owner' };

/** The admin roster carries a status; the rep roster never does. */
function isAdminMember(m: TeamMemberDto): m is TeamMemberAdminDto {
  return 'status' in m;
}

function numberLabel(n: PhoneNumberDto): string {
  const pretty = formatPhone(n.phone_e164) || n.phone_e164;
  return n.label ? `${n.label} · ${pretty}` : pretty;
}

/** The member exists whatever happened to the email; say which it was. */
function inviteMessage(outcome: AuthInviteOutcome, error: string | null, added: boolean): string {
  switch (outcome) {
    case 'sent':
      return 'Invite email sent';
    case 'not_configured':
      return `${added ? 'Added. ' : ''}Invite email not configured yet — they can sign in once Supabase invites are enabled.`;
    case 'failed':
      return `${added ? 'Added, but the invite' : 'Invite'} email failed: ${error ?? 'unknown error'}`;
  }
}

export default function TeamPage() {
  const { authed, active, transfer } = useSoftphone();
  // undefined = not asked yet; null = asked and it failed (plain board).
  const [me, setMe] = useState<MeDto | null | undefined>(undefined);
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [numbers, setNumbers] = useState<PhoneNumberDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  const isAdmin = me?.role === 'owner' || me?.role === 'admin';
  const isOwner = me?.role === 'owner';

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Who I am decides which roster to read, so it is asked first. Failing to
  // find out means the plain board: the page never depends on being admin.
  useEffect(() => {
    if (!authed) return;
    api.getMe().then(setMe).catch(() => setMe(null));
  }, [authed]);

  useEffect(() => {
    if (!authed || me === undefined) return;
    const load = async () => {
      try {
        const r = isAdmin ? await api.listTeamMembers() : await api.listTeam();
        setTeam(r.members);
      } catch (e) {
        setError((e as Error).message);
      }
    };
    void load();
    // Presence goes stale after 90s, so a board left open must keep re-reading.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [authed, me, isAdmin]);

  useEffect(() => {
    if (!authed || !isAdmin) return;
    api
      .listNumbers()
      .then((r) => setNumbers(r.numbers.filter((n) => n.status === 'active')))
      .catch(() => undefined);
  }, [authed, isAdmin]);

  const replaceMember = useCallback((member: TeamMemberAdminDto) => {
    setTeam((prev) => prev.map((m) => (m.id === member.id ? member : m)));
  }, []);

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  // Disabled people sink to the bottom; the count and zones are of those who
  // could actually pick up a transfer.
  const roster = isAdmin
    ? [...team].sort(
        (a, b) =>
          Number(isAdminMember(a) && a.status === 'disabled') - Number(isAdminMember(b) && b.status === 'disabled'),
      )
    : team;
  const people = roster.filter((m) => !(isAdminMember(m) && m.status === 'disabled'));
  const zones = new Set(people.map((m) => m.timezone).filter(Boolean));

  return (
    <>
      <TopBar
        title="Team"
        subtitle={`${people.length} ${people.length === 1 ? 'person' : 'people'} across ${zones.size} time ${zones.size === 1 ? 'zone' : 'zones'}`}
      />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {isAdmin && (
          <div className="flex items-center justify-end gap-2 pb-3">
            <Button tone="dark" onClick={() => setAdding((v) => !v)}>
              <Icon name={adding ? 'x' : 'plus'} size={14} />
              {adding ? 'Cancel' : 'Add teammate'}
            </Button>
          </div>
        )}

        {flash && (
          <Notice
            className="mb-3"
            action={
              <Button tone="quiet" onClick={() => setFlash(null)}>
                Dismiss
              </Button>
            }
          >
            {flash}
          </Notice>
        )}
        {error && <p className="pb-3" style={{ font: '400 12px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}

        {isAdmin && adding && (
          <AddTeammateForm
            isOwner={isOwner}
            numbers={numbers}
            onCancel={() => setAdding(false)}
            onAdded={(member, message) => {
              setTeam((prev) => [...prev, member].sort((a, b) => a.display_name.localeCompare(b.display_name)));
              setFlash(message);
              setAdding(false);
            }}
          />
        )}

        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))' }}>
          {roster.map((m) => (
            <MemberCard
              key={m.id}
              m={m}
              now={now}
              canManage={isAdmin}
              isOwner={isOwner}
              numbers={numbers}
              open={openId === m.id}
              onToggle={() => setOpenId((cur) => (cur === m.id ? null : m.id))}
              canTransfer={Boolean(active)}
              onTransfer={(mode) => void transfer({ mode, user_id: m.id })}
              onChanged={replaceMember}
              onFlash={setFlash}
            />
          ))}
        </div>

        {team.length === 0 && !error && (
          <EmptyState
            compact
            icon="users"
            title="No teammates yet"
            hint="Invite a rep and they appear here with their local time, presence and whatever call they are on."
          />
        )}
      </div>
    </>
  );
}

function MemberCard({
  m,
  now,
  canManage,
  isOwner,
  numbers,
  open,
  onToggle,
  canTransfer,
  onTransfer,
  onChanged,
  onFlash,
}: {
  m: TeamMemberDto;
  now: number | null;
  canManage: boolean;
  isOwner: boolean;
  numbers: PhoneNumberDto[];
  open: boolean;
  onToggle: () => void;
  canTransfer: boolean;
  onTransfer: (mode: 'warm' | 'blind') => void;
  onChanged: (member: TeamMemberAdminDto) => void;
  onFlash: (message: string) => void;
}) {
  const w = m.timezone && now !== null ? callWindow(m.timezone, now) : null;
  const admin = canManage && isAdminMember(m) ? m : null;
  const offFloor = admin !== null && admin.status !== 'active';
  // An invited or disabled person has no presence worth showing; their status
  // is the thing an admin needs to see at a glance.
  const chip = offFloor
    ? { color: STATUS_COLOR[admin.status] ?? 'var(--muted-2)', label: admin.status }
    : { color: PRESENCE_COLOR[m.presence] ?? 'var(--muted-2)', label: m.presence };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2.5">
        <Avatar name={m.display_name} size={40} />
        <span className="mr-auto flex min-w-0 flex-col gap-1">
          <span className="truncate" style={{ font: '700 13.5px/1 Inter' }}>
            {m.display_name}
            {m.is_self && (
              <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}> · you</span>
            )}
          </span>
          <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
            {m.title ?? m.role}
          </span>
          {admin && (
            <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
              {admin.email}
            </span>
          )}
        </span>
        <StatusMarker color={chip.color} label={chip.label} />
        {admin && (
          <button
            type="button"
            onClick={onToggle}
            aria-label={`Manage ${m.display_name}`}
            aria-expanded={open}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center"
            style={{
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: open ? 'var(--panel-2)' : 'var(--panel)',
              color: 'var(--muted)',
              cursor: 'pointer',
            }}
          >
            <Icon name="more" size={13} />
          </button>
        )}
      </div>

      <div className="flex items-end justify-between">
        <span className="flex flex-col gap-1">
          <Eyebrow>Local time</Eyebrow>
          <span
            className="display"
            style={{ font: '600 22px/1 Inter', color: w && !w.safe ? 'var(--amber)' : undefined }}
            title={w?.label}
          >
            {m.timezone && now !== null ? tzTime(m.timezone, now) : '—'}
          </span>
        </span>
        <span className="flex flex-col items-end gap-1">
          <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
            {m.city ?? 'Zone not set'}
          </span>
          <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
            {m.timezone && now !== null
              ? `${tzAbbr(m.timezone, now)} · ${tzCity(m.timezone)}`
              : 'Set a zone in Settings'}
          </span>
        </span>
      </div>

      {/* Two ways to hand a seller over, and only two. Transfer is
          warm — you stay on until they pick up. Forward is blind —
          the caller goes now and you drop. Adding a third person to
          the line is a conference operation and lives on the active
          call itself, where the rest of the conference controls are. */}
      {!m.is_self && (
        <div className="flex gap-1.5">
          <Button
            tone="ghost"
            className="flex-1"
            disabled={!canTransfer || offFloor}
            title={offFloor ? 'Not on the floor' : canTransfer ? 'Warm transfer this call' : 'No call in progress'}
            onClick={() => onTransfer('warm')}
          >
            <Icon name="transfer" size={14} />
            Transfer
          </Button>
          <Button
            tone="ghost"
            className="flex-1"
            disabled={!canTransfer || offFloor}
            title={
              offFloor ? 'Not on the floor' : canTransfer ? 'Hand the caller over now and drop off' : 'No call in progress'
            }
            onClick={() => onTransfer('blind')}
          >
            <Icon name="forward" size={14} />
            Forward to
          </Button>
        </div>
      )}

      {admin && open && (
        <ManagePanel member={admin} isOwner={isOwner} numbers={numbers} onChanged={onChanged} onFlash={onFlash} />
      )}
    </Card>
  );
}

/**
 * The admin controls, opened from the card's "more" button. On my own card
 * only the title is here: my role and status are another admin's to change,
 * and the server refuses otherwise.
 */
function ManagePanel({
  member: m,
  isOwner,
  numbers,
  onChanged,
  onFlash,
}: {
  member: TeamMemberAdminDto;
  isOwner: boolean;
  numbers: PhoneNumberDto[];
  onChanged: (member: TeamMemberAdminDto) => void;
  onFlash: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (input: UpdateTeamMemberInput) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.updateTeamMember(m.id, input);
      onChanged(r.member);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.resendTeamInvite(m.id);
      onFlash(inviteMessage(r.auth_invite, r.auth_invite_error, false));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // An owner's row is an owner's business; an admin sees it read-only.
  const lockedByOwner = m.role === 'owner' && !isOwner;
  const roles: TeamRole[] = isOwner || m.role === 'owner' ? ['rep', 'manager', 'admin', 'owner'] : ['rep', 'manager', 'admin'];
  const disabled = m.status === 'disabled';
  const selectedNumber = numbers.find((n) => n.id === m.default_phone_number_id) ?? null;
  const staleNumber = m.default_phone_number_id !== null && selectedNumber === null;

  return (
    <div className="flex flex-col gap-2.5 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
      <Labeled label="Title">
        <Input
          key={m.title ?? ''}
          defaultValue={m.title ?? ''}
          placeholder="Acquisitions"
          disabled={busy}
          onBlur={(e) => {
            const next = e.target.value.trim() || null;
            if (next !== m.title) void save({ title: next });
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </Labeled>

      {!m.is_self && (
        <>
          <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
            <Labeled label="Role">
              <Select
                value={m.role}
                disabled={busy || lockedByOwner}
                title={lockedByOwner ? 'Only an owner can change an owner' : undefined}
                onChange={(e) => {
                  const next = roles.find((r) => r === e.target.value);
                  if (next && next !== m.role) void save({ role: next });
                }}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Labeled>
            {/* Not a <Labeled>: an <option> cannot hold a button, so the copy
                control sits beside the select — and interactive content inside
                a <label> is invalid, hence the explicit eyebrow + aria-label. */}
            <div className="flex min-w-0 flex-col gap-1.5">
              <Eyebrow>Default number</Eyebrow>
              <div className="flex min-w-0 items-center gap-1.5">
                <Select
                  className="flex-1"
                  aria-label="Default number"
                  value={m.default_phone_number_id ?? ''}
                  disabled={busy}
                  onChange={(e) => void save({ default_phone_number_id: e.target.value || null })}
                >
                  <option value="">None</option>
                  {staleNumber && m.default_phone_number_id && (
                    <option value={m.default_phone_number_id}>Number no longer active</option>
                  )}
                  {numbers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {numberLabel(n)}
                    </option>
                  ))}
                </Select>
                {selectedNumber && (
                  <CopyButton
                    value={selectedNumber.phone_e164}
                    label={`Copy ${m.display_name}'s number, ${formatPhone(selectedNumber.phone_e164) || selectedNumber.phone_e164}`}
                    size={26}
                  />
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {!m.auth_linked && !disabled && (
              <Button tone="ghost" disabled={busy} title="They have not signed in yet" onClick={() => void resend()}>
                <Icon name="send" size={13} />
                Resend invite
              </Button>
            )}
            {disabled ? (
              <Button
                tone="ghost"
                disabled={busy || lockedByOwner}
                title={lockedByOwner ? 'Only an owner can change an owner' : 'Let them sign in again'}
                onClick={() => void save({ status: 'active' })}
              >
                <Icon name="check" size={13} />
                Re-enable
              </Button>
            ) : (
              <Button
                tone="quiet"
                style={{ color: 'var(--red)' }}
                disabled={busy || lockedByOwner}
                title={lockedByOwner ? 'Only an owner can change an owner' : 'Every request of theirs fails from now on'}
                onClick={() => void save({ status: 'disabled' })}
              >
                <Icon name="x" size={13} />
                Disable
              </Button>
            )}
          </div>
        </>
      )}

      {err && <span style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>{err}</span>}
    </div>
  );
}

function AddTeammateForm({
  isOwner,
  numbers,
  onCancel,
  onAdded,
}: {
  isOwner: boolean;
  numbers: PhoneNumberDto[];
  onCancel: () => void;
  onAdded: (member: TeamMemberAdminDto, message: string) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('rep');
  const [title, setTitle] = useState('');
  const [numberId, setNumberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const roles: TeamRole[] = isOwner ? ['rep', 'manager', 'admin', 'owner'] : ['rep', 'manager', 'admin'];
  const ready = name.trim().length > 0 && /\S+@\S+\.\S+/.test(email.trim());

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const input: CreateTeamMemberInput = {
        email: email.trim(),
        display_name: name.trim(),
        role,
        title: title.trim() || null,
        default_phone_number_id: numberId || null,
      };
      const r = await api.createTeamMember(input);
      onAdded(r.member, inviteMessage(r.auth_invite, r.auth_invite_error, true));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mb-3.5 flex flex-col gap-3">
      <SectionTitle icon={<Icon name="users" size={15} />}>Add teammate</SectionTitle>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          <Labeled label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Lee" autoFocus />
          </Labeled>
          <Labeled label="Email">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jordan@example.com"
              autoComplete="off"
            />
          </Labeled>
          <Labeled label="Role">
            <Select value={role} onChange={(e) => setRole(roles.find((r) => r === e.target.value) ?? 'rep')}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </Labeled>
          <Labeled label="Title">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acquisitions" />
          </Labeled>
          <Labeled label="Default number">
            <Select value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">None yet</option>
              {numbers.map((n) => (
                <option key={n.id} value={n.id}>
                  {numberLabel(n)}
                </option>
              ))}
            </Select>
          </Labeled>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={!ready || busy}>
            {busy ? 'Adding…' : 'Add teammate'}
          </Button>
          <Button tone="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          {err ? (
            <span className="ml-auto" style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>
              {err}
            </span>
          ) : (
            <span className="ml-auto" style={{ font: '500 11px/1.4 Inter', color: 'var(--muted)' }}>
              They sign in with this email once the invite lands.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}
