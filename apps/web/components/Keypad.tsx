'use client';

const KEYS: Array<[string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/** DTMF pad. Dark by default because it lives inside the call surfaces. */
export function Keypad({ onDigit, dark = true }: { onDigit: (d: string) => void; dark?: boolean }) {
  return (
    <div className="mx-auto grid w-60 grid-cols-3 gap-2">
      {KEYS.map(([k, letters]) => (
        <button
          key={k}
          type="button"
          onClick={() => onDigit(k)}
          className="flex flex-col items-center justify-center gap-px py-2.5 transition-transform active:scale-95"
          style={{
            borderRadius: 'var(--r-md)',
            border: `1px solid ${dark ? 'var(--dark-2)' : 'var(--line)'}`,
            background: dark ? 'rgba(255,255,255,.05)' : 'var(--panel)',
            color: dark ? '#fff' : 'var(--text)',
            cursor: 'pointer',
          }}
        >
          <span style={{ font: '500 18px/1 Inter' }}>{k}</span>
          <span
            style={{
              font: '600 7px/1 Inter',
              letterSpacing: '0.14em',
              color: dark ? 'var(--muted)' : 'var(--muted-2)',
            }}
          >
            {letters}
          </span>
        </button>
      ))}
    </div>
  );
}
