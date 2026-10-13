/**
 * The light markdown scripts are written in — `## ` sections, `- ` bullets,
 * `> ` asides, `**bold**` — rendered small enough to read beside a CRM.
 *
 * No markdown library: the grammar is four rules, MV3 bundles everything, and
 * a rep mid-call needs sections they can fold away, not a document renderer.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export type Block =
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'quote'; text: string };

export interface Section {
  /** Null for text before the first heading. */
  title: string | null;
  blocks: Block[];
}

export function parseScript(body: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: null, blocks: [] };
  let para: string[] = [];
  let list: string[] | null = null;

  const endPara = () => {
    if (para.length) current.blocks.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  const endList = () => {
    if (list) current.blocks.push({ kind: 'ul', items: list });
    list = null;
  };
  const endSection = () => {
    endPara();
    endList();
    if (current.title !== null || current.blocks.length) sections.push(current);
  };

  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      endSection();
      current = { title: heading[1]!.trim(), blocks: [] };
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.+)$/.exec(line);
    if (bullet) {
      endPara();
      (list ??= []).push(bullet[1]!);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      endPara();
      endList();
      const last = current.blocks[current.blocks.length - 1];
      if (last && last.kind === 'quote') last.text = `${last.text} ${quote[1]!}`.trim();
      else current.blocks.push({ kind: 'quote', text: quote[1]! });
      continue;
    }
    if (!line.trim()) {
      endPara();
      endList();
      continue;
    }
    endList();
    para.push(line.trim());
  }
  endSection();
  return sections;
}

/** `**bold**` and `*emphasis*`. Underscores are left alone: merge fields use them. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(<strong key={i++}>{m[1]}</strong>);
    else out.push(<em key={i++}>{m[2]}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Blocks({ blocks, fontSize }: { blocks: Block[]; fontSize: number }) {
  const font = `400 ${fontSize}px/1.5 Inter`;
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === 'ul') {
          return (
            <ul key={i} style={{ margin: '0 0 8px', paddingLeft: 18, font }}>
              {b.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 2 }}>
                  {inline(item)}
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'quote') {
          return (
            <blockquote
              key={i}
              style={{
                margin: '0 0 8px',
                padding: '6px 10px',
                borderLeft: '2px solid var(--accent)',
                borderRadius: '0 8px 8px 0',
                background: 'var(--panel-2)',
                font,
                color: 'var(--text)',
              }}
            >
              {inline(b.text)}
            </blockquote>
          );
        }
        return (
          <p key={i} style={{ margin: '0 0 8px', font }}>
            {inline(b.text)}
          </p>
        );
      })}
    </>
  );
}

/**
 * A script, sectioned by its `##` headings, each one foldable. Key the
 * element on the script id so switching scripts reopens everything.
 */
export function ScriptBody({
  body,
  fontSize = 13,
  collapsible = true,
}: {
  body: string;
  fontSize?: number;
  collapsible?: boolean;
}) {
  const sections = useMemo(() => parseScript(body), [body]);
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());

  if (sections.length === 0) {
    return <p style={{ margin: 0, font: `400 ${fontSize}px/1.5 Inter`, color: 'var(--muted)' }}>Empty script.</p>;
  }

  return (
    <div>
      {sections.map((s, i) => {
        if (s.title === null) return <Blocks key={i} blocks={s.blocks} fontSize={fontSize} />;
        const isClosed = closed.has(i);
        return (
          <section key={i} style={{ marginBottom: 6 }}>
            <button
              type="button"
              disabled={!collapsible}
              aria-expanded={!isClosed}
              onClick={() =>
                setClosed((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                padding: '7px 0',
                border: 'none',
                borderTop: i === 0 ? 'none' : '1px solid var(--line-soft)',
                background: 'transparent',
                textAlign: 'left',
                cursor: collapsible ? 'pointer' : 'default',
              }}
            >
              {collapsible && (
                <Icon
                  name={isClosed ? 'chevron-right' : 'chevron-down'}
                  size={13}
                  style={{ color: 'var(--muted-2)', flexShrink: 0 }}
                />
              )}
              <span style={{ font: `700 ${Math.max(fontSize - 1, 11)}px/1.2 Inter`, color: 'var(--text)' }}>
                {inline(s.title)}
              </span>
            </button>
            {!isClosed && <Blocks blocks={s.blocks} fontSize={fontSize} />}
          </section>
        );
      })}
    </div>
  );
}
