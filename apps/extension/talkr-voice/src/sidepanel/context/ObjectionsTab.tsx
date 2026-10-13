/**
 * Objections tab: what to say back. Every rebuttal the server matched to this
 * call, searchable by word and by tag, each one folded until it is needed.
 * "Used" records which rebuttals earn their keep.
 */

import { useMemo, useState } from 'react';
import { Icon } from '@/shared/Icon';
import { Card } from '@/shared/ui';
import { ScriptBody } from '@/shared/ScriptBody';
import { TagChip } from '@/shared/contacts';
import { api, type CallContextDto, type RenderedScriptDto } from '@/shared/api';

function matches(r: RenderedScriptDto, q: string): boolean {
  if (!q) return true;
  const hay = [r.title, r.category ?? '', r.rendered_body, ...r.tags].join('\n').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => hay.includes(word));
}

export function ObjectionsTab({ ctx, callId }: { ctx: CallContextDto | null; callId: string | null }) {
  const rebuttals = ctx?.scripts.rebuttals ?? [];
  const [q, setQ] = useState('');
  const [activeTags, setActiveTags] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [used, setUsed] = useState<ReadonlySet<string>>(() => new Set());
  const [marking, setMarking] = useState<string | null>(null);

  // Tags are the filter vocabulary; categories stand in when nobody tagged.
  const tags = useMemo(() => {
    const fromTags = new Set<string>();
    for (const r of rebuttals) for (const t of r.tags) fromTags.add(t);
    if (fromTags.size > 0) return [...fromTags].sort();
    const cats = new Set<string>();
    for (const r of rebuttals) if (r.category) cats.add(r.category);
    return [...cats].sort();
  }, [rebuttals]);

  const visible = rebuttals.filter((r) => {
    if (!matches(r, q)) return false;
    if (activeTags.size === 0) return true;
    return r.tags.some((t) => activeTags.has(t)) || (r.category ? activeTags.has(r.category) : false);
  });

  function toggle<T>(set: ReadonlySet<T>, value: T): Set<T> {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  }

  async function markUsed(id: string) {
    if (marking) return;
    setMarking(id);
    try {
      await api.markScriptUsed(id, {
        ...(callId ? { call_id: callId } : {}),
        ...(ctx?.contact ? { contact_id: ctx.contact.id } : {}),
      });
      setUsed((prev) => new Set(prev).add(id));
    } catch {
      /* a missed usage stat is not worth interrupting the call */
    } finally {
      setMarking(null);
    }
  }

  if (!ctx) {
    return <p style={{ margin: 0, padding: 4, font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>Loading…</p>;
  }

  if (rebuttals.length === 0) {
    return (
      <Card style={{ padding: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
        <Icon name="shield" size={20} style={{ color: 'var(--muted-2)' }} />
        <span style={{ font: '600 13px/1 Inter' }}>No rebuttals yet</span>
        <p style={{ margin: 0, font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
          Add rebuttals under Scripts in the web app and they will show here, filtered to this contact type.
        </p>
      </Card>
    );
  }

  const lastObjections = ctx.last_call_summary?.objections ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          height: 32,
          padding: '0 10px',
          borderRadius: 9,
          border: '1px solid var(--line)',
          background: 'var(--panel)',
        }}
      >
        <Icon name="search" size={13} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search objections…"
          aria-label="Search rebuttals"
          style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', font: '400 12px/1 Inter' }}
        />
        {q && (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => setQ('')}
            style={{ border: 'none', background: 'transparent', color: 'var(--muted)', padding: 0, display: 'inline-flex' }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {tags.map((t) => (
            <TagChip key={t} active={activeTags.has(t)} onClick={() => setActiveTags((s) => toggle(s, t))}>
              {t}
            </TagChip>
          ))}
        </div>
      )}

      {lastObjections.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, alignItems: 'center' }}>
          <span style={{ font: '600 10px/1 Inter', color: 'var(--muted)' }}>Last call:</span>
          {lastObjections.map((o) => (
            <TagChip key={o} onClick={() => setQ(o)}>
              {o}
            </TagChip>
          ))}
        </div>
      )}

      {visible.length === 0 && (
        <p style={{ margin: 0, padding: 4, font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
          Nothing matches{q ? ` “${q}”` : ''}.
        </p>
      )}

      {visible.map((r) => {
        const isOpen = open.has(r.id);
        const isUsed = used.has(r.id);
        return (
          <Card key={r.id}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((s) => toggle(s, r.id))}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                textAlign: 'left',
              }}
            >
              <Icon
                name={isOpen ? 'chevron-down' : 'chevron-right'}
                size={13}
                style={{ color: 'var(--muted-2)', flexShrink: 0 }}
              />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                <span style={{ font: '600 12px/1.2 Inter' }}>{r.title}</span>
                {(r.category || r.tags.length > 0) && (
                  <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                    {[r.category, ...r.tags.slice(0, 3)].filter(Boolean).join(' · ')}
                  </span>
                )}
              </span>
              {isUsed && <Icon name="check" size={13} style={{ color: 'var(--green)', flexShrink: 0 }} />}
            </button>
            {isOpen && (
              <div style={{ padding: '0 12px 10px 33px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ScriptBody body={r.rendered_body} fontSize={12.5} collapsible={false} />
                <button
                  type="button"
                  disabled={isUsed || marking === r.id}
                  onClick={() => void markUsed(r.id)}
                  style={{
                    alignSelf: 'flex-end',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '6px 9px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    background: isUsed ? 'var(--panel-2)' : 'var(--dark-1)',
                    color: isUsed ? 'var(--muted)' : '#fff',
                    font: '600 10.5px/1 Inter',
                    opacity: marking === r.id ? 0.6 : 1,
                  }}
                >
                  <Icon name="check" size={11} />
                  {isUsed ? 'Used' : 'Used it'}
                </button>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
