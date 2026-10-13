'use client';

/**
 * Incoming-call panel: who's calling, which property, their local time, and
 * accept/decline. Declining lets the server-side routing chain proceed to the
 * next rep or to voicemail (docs/inbound-routing.md).
 *
 * The caller's local time is shown before pickup on purpose — it is context
 * the rep uses in the first sentence.
 */

import { useEffect, useState } from 'react';
import type { CallContextDto } from '@/lib/api';
import { fetchCallContext } from '@/lib/callContext';
import { useSoftphone } from '@/lib/softphone';
import { Icon, HangupIcon } from './Icon';
import { Avatar, Button } from './ui';
import { BAND_COLOR, BAND_LABEL, TempDot, degrees, oneLineAddress, tempBand } from './contacts';
import { ProspectTime } from './ProspectTime';
import { formatPhone } from '@/lib/time';

export function IncomingCall() {
  const { incoming, acceptIncoming, rejectIncoming } = useSoftphone();
  const [now, setNow] = useState<number | null>(null);
  // The full party — name, address, temperature — fetched the moment the
  // phone rings, so the first sentence can use it. The dialer's panel asks
  // for the same number and shares this fetch through the cache.
  const [ctx, setCtx] = useState<CallContextDto | null>(null);
  const from = incoming?.from ?? null;

  useEffect(() => {
    if (!incoming) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [incoming]);

  useEffect(() => {
    setCtx(null);
    if (!from || !/^\+\d{7,}$/.test(from)) return;
    let alive = true;
    fetchCallContext({ phone: from })
      .then((c) => alive && setCtx(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [from]);

  if (!incoming) return null;

  const contact = ctx?.contact ?? null;
  const name = contact?.display_name ?? incoming.context?.contact?.display_name;
  const legacyProperty = incoming.context?.property;
  const address = ctx?.property
    ? oneLineAddress(ctx.property)
    : contact?.address
      ? oneLineAddress(contact.address)
      : legacyProperty
        ? [legacyProperty.address_line1, legacyProperty.city, legacyProperty.state].filter(Boolean).join(', ')
        : null;
  const leadStatus = ctx?.lead?.status ?? incoming.context?.lead?.status ?? null;

  return (
    <div className="fixed inset-x-0 top-6 z-50 mx-auto w-full max-w-md px-4">
      <div
        className="p-5"
        style={{
          borderRadius: 'var(--r-lg)',
          background: 'var(--ink)',
          border: '1px solid var(--dark-2)',
          boxShadow: '0 24px 60px rgba(0,0,0,.45)',
        }}
      >
        <div className="flex items-center gap-3.5">
          <span className="relative inline-flex h-14 w-14 items-center justify-center">
            <span
              className="absolute inset-0 rounded-full"
              style={{ background: 'var(--accent)', animation: 'ringpulse 1.6s ease-out infinite' }}
              aria-hidden
            />
            <Avatar name={name ?? formatPhone(incoming.from)} size={48} dark />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate" style={{ font: '600 17px/1.2 Inter', color: '#fff' }}>
                {name ?? formatPhone(incoming.from)}
              </span>
              {contact && (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5"
                  title={`${degrees(contact.temperature_score)} engagement score`}
                  style={{ font: '700 10.5px/1 Inter', color: BAND_COLOR[tempBand(contact.temperature, contact.temperature_score)] }}
                >
                  <TempDot temperature={contact.temperature} score={contact.temperature_score} />
                  {BAND_LABEL[tempBand(contact.temperature, contact.temperature_score)]}
                  <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>
                    {degrees(contact.temperature_score)}
                  </span>
                </span>
              )}
            </div>
            <div
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
              style={{ font: '500 12px/1.5 Inter', color: 'var(--muted-2)' }}
            >
              <span className="truncate">
                {name ? formatPhone(incoming.from) : 'Incoming call'}
                {contact?.company ? ` · ${contact.company}` : ''}
              </span>
              <ProspectTime e164={incoming.from} tone="dark" now={now} size={11.5} />
            </div>
            {(address || leadStatus) && (
              <div className="truncate" style={{ font: '500 11px/1.5 Inter', color: 'var(--muted)' }}>
                {address ?? ''}
                {leadStatus ? `${address ? ' · ' : ''}lead: ${leadStatus.replace(/_/g, ' ')}` : ''}
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 flex gap-3">
          <Button tone="green" className="flex-1" style={{ padding: '12px 0' }} onClick={acceptIncoming}>
            <Icon name="phone" size={16} />
            Accept
          </Button>
          <Button tone="red" className="flex-1" style={{ padding: '12px 0' }} onClick={rejectIncoming}>
            <HangupIcon size={16} />
            Decline
          </Button>
        </div>
      </div>
    </div>
  );
}
