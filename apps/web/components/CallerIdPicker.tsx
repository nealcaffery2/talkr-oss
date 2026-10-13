'use client';
/**
 * Which number a rep dials out from. One control, used on the dialer and in
 * Settings: "Local presence" (an org number whose area code matches the
 * seller's, when one exists) or a specific dedicated line. The choice is the
 * rep's own profile setting, so it follows them across devices.
 */
import { useState } from 'react';
import { api, type MeDto } from '@/lib/api';
import { formatPhone } from '@/lib/time';

const LOCAL = 'local_presence';

export function callerIdLabel(me: MeDto | null): string {
  if (!me) return '';
  if (me.caller_id_mode === LOCAL) {
    const fallback = me.org_numbers.find((n) => n.id === me.default_phone_number_id) ?? me.org_numbers[0];
    return fallback ? `Local presence · falls back to ${formatPhone(fallback.phone_e164)}` : 'Local presence';
  }
  const n = me.org_numbers.find((x) => x.id === me.default_phone_number_id) ?? me.numbers[0] ?? me.org_numbers[0];
  return n ? `Calling from ${formatPhone(n.phone_e164)}` : 'No number assigned to you yet';
}

export function CallerIdPicker({
  me,
  onChange,
  compact = false,
}: {
  me: MeDto;
  onChange: (next: MeDto) => void;
  compact?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = me.caller_id_mode === LOCAL ? LOCAL : (me.default_phone_number_id ?? me.numbers[0]?.id ?? me.org_numbers[0]?.id ?? '');

  async function select(next: string) {
    setError(null);
    setSaving(true);
    try {
      const patch: Parameters<typeof api.updateMe>[0] =
        next === LOCAL
          ? { caller_id_mode: 'local_presence' }
          : { caller_id_mode: 'dedicated', default_phone_number_id: next };
      const saved = await api.updateMe(patch);
      onChange({
        ...me,
        caller_id_mode: saved.caller_id_mode ?? me.caller_id_mode,
        default_phone_number_id: saved.default_phone_number_id ?? me.default_phone_number_id,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const option = (n: MeDto['org_numbers'][number]) => {
    const who = n.assigned_user_id === me.id ? ' · yours' : n.assigned_user_id ? '' : ' · shared';
    return `${formatPhone(n.phone_e164)}${n.label ? ` · ${n.label}` : ''}${who}`;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <select
        value={value}
        disabled={saving || me.org_numbers.length === 0}
        onChange={(e) => void select(e.target.value)}
        aria-label="Caller ID"
        className="outline-none"
        style={{
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-btn)',
          padding: compact ? '7px 9px' : '9px 11px',
          font: compact ? '500 11.5px/1 Inter' : '500 12.5px/1 Inter',
          background: 'var(--panel)',
          width: '100%',
        }}
      >
        {me.org_numbers.length === 0 && <option value="">No active numbers</option>}
        {me.org_numbers.length > 1 && <option value={LOCAL}>Local presence · match the seller&apos;s area code</option>}
        {me.org_numbers.map((n) => (
          <option key={n.id} value={n.id}>
            {option(n)}
          </option>
        ))}
      </select>
      {!compact && (
        <span style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
          {me.org_numbers.length > 1
            ? 'Local presence dials from the org number closest to the seller and falls back to your dedicated line. Applies to calls and texts.'
            : 'Add more numbers to the org to turn on local presence (area-code matching).'}
        </span>
      )}
      {error && <span style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{error}</span>}
    </div>
  );
}
