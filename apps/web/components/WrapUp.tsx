'use client';

/**
 * The wrap-up screen: appears instantly on disconnect, fully keyboard-driven
 * (press the disposition's number, Tab to note, Enter to save) so a
 * high-volume rep moves straight to the next call.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type CallDto, type DispositionDto } from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { AddContactButton } from './AddContact';
import { isAppointmentDisposition, playSound } from '@/lib/sounds';
import { formatPhone } from '@/lib/time';

const KEY_ORDER = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];

/** The party the rep just spoke to, and whether the CRM already knows them. */
interface OtherParty {
  number: string;
  known: boolean;
}

function partyOf(call: CallDto): OtherParty {
  return {
    number: call.direction === 'outbound' ? call.to_number : call.from_number,
    known: Boolean(call.contact_id) || Boolean(call.contact_name),
  };
}

export function WrapUp() {
  const { wrapupCallId, finishWrapup, active } = useSoftphone();
  const [dispositions, setDispositions] = useState<DispositionDto[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [party, setParty] = useState<OtherParty | null>(null);
  /** Set once this wrap-up saved the number, so the offer becomes a receipt. */
  const [savedName, setSavedName] = useState<string | null>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const record = active?.record ?? null;

  useEffect(() => {
    if (!wrapupCallId) return;
    setSelected(null);
    setNote('');
    setFollowUp('');
    setError(null);
    setSavedName(null);
    api
      .listDispositions()
      .then((r) => setDispositions(r.dispositions))
      .catch((e) => setError((e as Error).message));
  }, [wrapupCallId]);

  // Who was on the other end. The softphone still holds the call record here;
  // after a reload mid-wrap-up it does not, so the server is asked instead.
  useEffect(() => {
    if (!wrapupCallId) {
      setParty(null);
      return;
    }
    if (record && record.id === wrapupCallId) {
      setParty(partyOf(record));
      return;
    }
    let cancelled = false;
    api
      .getCall(wrapupCallId)
      .then((r) => {
        if (!cancelled) setParty(partyOf(r.call));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [wrapupCallId, record]);

  const save = useCallback(async () => {
    if (!wrapupCallId || !selected || saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.setDisposition(wrapupCallId, {
        disposition: selected,
        note: note || undefined,
        follow_up_at: followUp ? new Date(followUp).toISOString() : undefined,
      });
      // The one outcome worth a sound. Matched on the slug *and* the label, so
      // an org that renamed "Appointment set" to "Booked" still gets it — and
      // only after the server accepted the disposition, never on a failed save.
      const chosen = dispositions.find((d) => d.slug === selected);
      if (chosen && isAppointmentDisposition(chosen)) playSound('appointment');
      finishWrapup();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [wrapupCallId, selected, note, followUp, saving, finishWrapup, dispositions]);

  useEffect(() => {
    if (!wrapupCallId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
        return;
      }
      const idx = KEY_ORDER.indexOf(e.key);
      if (idx >= 0 && dispositions[idx]) {
        setSelected(dispositions[idx].slug);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        void save();
      } else if (e.key.toLowerCase() === 'n') {
        noteRef.current?.focus();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [wrapupCallId, dispositions, save]);

  if (!wrapupCallId) return null;

  const selectedDisposition = dispositions.find((d) => d.slug === selected);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--panel)] p-6 shadow-2xl">
        <h2 className="text-lg font-semibold">Call wrap-up</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Press a key to pick, <kbd className="rounded bg-[var(--panel-2)] px-1">n</kbd> for notes,{' '}
          <kbd className="rounded bg-[var(--panel-2)] px-1">Enter</kbd> to save.
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {dispositions.map((d, i) => (
            <button
              key={d.slug}
              onClick={() => setSelected(d.slug)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                selected === d.slug
                  ? 'border-[var(--accent)] bg-[var(--accent)]/15'
                  : 'border-[var(--line)] bg-[var(--panel-2)] hover:border-[var(--muted)]'
              }`}
            >
              <span className="rounded bg-[var(--bg)] px-1.5 text-xs text-[var(--muted)]">
                {KEY_ORDER[i] ?? ''}
              </span>
              {d.name}
              {d.adds_suppression && <span className="ml-auto text-xs text-[var(--red)]">DNC</span>}
            </button>
          ))}
        </div>

        {/* The one moment the rep is certain who they just spoke to. Optional:
            the disposition saves with or without it. */}
        {party && party.number && !party.known && !savedName && (
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-[var(--line)] bg-[var(--panel-2)] px-3 py-2.5">
            <span className="text-sm">
              Save <span className="font-semibold">{formatPhone(party.number) || party.number}</span> as a contact
            </span>
            <span className="ml-auto">
              <AddContactButton
                phone={party.number}
                tone="dark"
                onCreated={(contact) => setSavedName(contact.display_name)}
              />
            </span>
          </div>
        )}
        {savedName && (
          <p className="mt-4 text-sm text-[var(--muted)]">
            Saved as <span className="font-semibold text-[var(--text)]">{savedName}</span>.
          </p>
        )}

        <textarea
          ref={noteRef}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Notes (seller motivation, condition, price talk…)"
          rows={3}
          className="mt-4 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3 text-sm outline-none focus:border-[var(--accent)]"
        />

        {selectedDisposition?.requires_follow_up && (
          <label className="mt-3 block text-sm">
            <span className="text-[var(--muted)]">Follow-up</span>
            <input
              type="datetime-local"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2 text-sm outline-none focus:border-[var(--accent)]"
            />
          </label>
        )}

        {error && <p className="mt-3 text-sm text-[var(--red)]">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={finishWrapup}
            className="rounded-lg px-4 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel-2)]"
          >
            Skip
          </button>
          <button
            onClick={() => void save()}
            disabled={!selected || saving}
            className="rounded-lg bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
