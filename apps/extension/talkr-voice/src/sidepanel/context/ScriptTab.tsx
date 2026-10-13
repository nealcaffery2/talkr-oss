/**
 * Script tab: what to say. The server picks the primary script for this
 * contact and campaign and renders its merge fields; the alternatives arrive
 * as titles and are fetched and rendered here when the rep switches to one.
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/shared/Icon';
import { Button, Card } from '@/shared/ui';
import { ScriptBody } from '@/shared/ScriptBody';
import { api, type CallContextDto, type ScriptDto } from '@/shared/api';
import { renderMergeFields } from '@/shared/callContext';

const FONT_SIZES = [12, 13.5, 15] as const;
const FONT_KEY = 'talkr.script.font';

function loadFontIndex(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return Number.isInteger(n) && n >= 0 && n < FONT_SIZES.length ? n : 1;
  } catch {
    return 1;
  }
}

/** Alternative bodies, once read. Scripts do not change mid-call. */
const scriptCache = new Map<string, ScriptDto>();

const SELECT: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  padding: '0 8px',
  font: '600 11.5px/1 Inter',
  color: 'var(--text)',
  outline: 'none',
};

const SMALL_BTN: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--text)',
  font: '700 11px/1 Inter',
};

export function ScriptTab({ ctx, callId }: { ctx: CallContextDto | null; callId: string | null }) {
  const primary = ctx?.scripts.primary ?? null;
  const alternatives = ctx?.scripts.alternatives ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [alt, setAlt] = useState<{ id: string; script: ScriptDto } | null>(null);
  const [altError, setAltError] = useState<string | null>(null);
  const [fontIndex, setFontIndex] = useState(loadFontIndex);
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  const [marking, setMarking] = useState(false);

  // A new call starts on its own primary script.
  const contextId = ctx ? `${ctx.phone_e164}:${primary?.id ?? ''}` : null;
  useEffect(() => {
    setSelectedId(null);
    setAlt(null);
    setAltError(null);
  }, [contextId]);

  useEffect(() => {
    if (!selectedId || selectedId === primary?.id) {
      setAlt(null);
      return;
    }
    const cached = scriptCache.get(selectedId);
    if (cached) {
      setAlt({ id: selectedId, script: cached });
      return;
    }
    let alive = true;
    setAltError(null);
    api
      .getScript(selectedId)
      .then((script) => {
        scriptCache.set(selectedId, script);
        if (alive) setAlt({ id: selectedId, script });
      })
      .catch((err: Error) => alive && setAltError(err.message));
    return () => {
      alive = false;
    };
  }, [selectedId, primary?.id]);

  function setFont(delta: number) {
    setFontIndex((i) => {
      const next = Math.min(FONT_SIZES.length - 1, Math.max(0, i + delta));
      try {
        localStorage.setItem(FONT_KEY, String(next));
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  if (!ctx) {
    return <p style={{ margin: 0, padding: 4, font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Loading…</p>;
  }

  if (!primary && alternatives.length === 0) {
    return (
      <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
        <Icon name="template" size={20} style={{ color: 'var(--muted-2)' }} />
        <span style={{ font: '600 13px/1 Inter' }}>No script for this call</span>
        <p style={{ margin: 0, font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          Scripts are matched by contact type and campaign. Add one under Scripts in the web app.
        </p>
      </Card>
    );
  }

  const showingAlt = selectedId !== null && selectedId !== primary?.id;
  const active: { id: string; title: string; body: string } | null = showingAlt
    ? alt && alt.id === selectedId
      ? { id: alt.id, title: alt.script.title, body: renderMergeFields(alt.script.body, ctx.merge_fields) }
      : null
    : primary
      ? { id: primary.id, title: primary.title, body: primary.rendered_body }
      : null;
  const fontSize = FONT_SIZES[fontIndex] ?? 13.5;

  async function markUsed() {
    if (!active || marking) return;
    setMarking(true);
    try {
      await api.markScriptUsed(active.id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact ? { contact_id: ctx.contact.id } : {}),
      });
      setUsed((prev) => new Set(prev).add(active.id));
    } catch {
      /* a missed usage stat is not worth interrupting the call */
    } finally {
      setMarking(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          aria-label="Script"
          value={selectedId ?? primary?.id ?? ''}
          onChange={(e) => setSelectedId(e.target.value || null)}
          style={SELECT}
        >
          {primary && <option value={primary.id}>{primary.title}</option>}
          {alternatives.length > 0 && (
            <optgroup label="Alternatives">
              {alternatives.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                  {a.category ? ` · ${a.category}` : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <button type="button" aria-label="Smaller text" disabled={fontIndex === 0} onClick={() => setFont(-1)} style={{ ...SMALL_BTN, opacity: fontIndex === 0 ? 0.4 : 1 }}>
          A−
        </button>
        <button
          type="button"
          aria-label="Larger text"
          disabled={fontIndex === FONT_SIZES.length - 1}
          onClick={() => setFont(1)}
          style={{ ...SMALL_BTN, opacity: fontIndex === FONT_SIZES.length - 1 ? 0.4 : 1 }}
        >
          A+
        </button>
      </div>

      <Card style={{ padding: '4px 12px 10px' }}>
        {active ? (
          <ScriptBody key={active.id} body={active.body} fontSize={fontSize} />
        ) : altError ? (
          <p style={{ margin: '8px 0', font: '500 11.5px/1.4 Inter', color: 'var(--red)' }}>Could not load that script: {altError}</p>
        ) : (
          <p style={{ margin: '8px 0', font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Loading script…</p>
        )}
      </Card>

      {active && (
        <Button
          tone={used.has(active.id) ? 'ghost' : 'dark'}
          disabled={marking || used.has(active.id)}
          onClick={() => void markUsed()}
          style={{ alignSelf: 'flex-end', padding: '7px 10px', font: '600 11px/1 Inter' }}
        >
          <Icon name="check" size={12} />
          {used.has(active.id) ? 'Marked used' : 'Mark used'}
        </Button>
      )}
    </div>
  );
}
