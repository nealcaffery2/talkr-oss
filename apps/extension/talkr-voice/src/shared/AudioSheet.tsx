/**
 * Pick the microphone and speaker for the call (the "Audio" control in both
 * designs). Devices are enumerated here, in a visible page that already holds
 * the microphone grant; the switch itself is a command to the offscreen
 * document, because that is where the Device lives.
 */

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Eyebrow } from './ui';
import type { CallSnapshot, Command } from './messages';

interface Props {
  snapshot: CallSnapshot;
  dispatch: (command: Command) => Promise<void>;
  onClose: () => void;
}

export function AudioSheet({ snapshot, dispatch, onClose }: Props) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((list) => alive && setDevices(list))
        .catch(() => alive && setDevices([]));
    void load();
    navigator.mediaDevices.addEventListener('devicechange', load);
    return () => {
      alive = false;
      navigator.mediaDevices.removeEventListener('devicechange', load);
    };
  }, []);

  const groups: Array<['input' | 'output', string, MediaDeviceInfo[]]> = [
    ['input', 'Microphone', devices.filter((d) => d.kind === 'audioinput')],
    ['output', 'Speaker', devices.filter((d) => d.kind === 'audiooutput')],
  ];

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(10,10,12,.86)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      <div
        className="scroll"
        style={{
          background: 'var(--dark-1)',
          borderTop: '1px solid var(--dark-2)',
          borderRadius: '16px 16px 0 0',
          padding: '14px 16px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          maxHeight: '82%',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ font: '700 13px/1 Inter', color: '#fff' }}>Audio</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              border: '1px solid var(--dark-3)',
              background: 'transparent',
              color: '#e4e4e7',
            }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>

        {groups.map(([kind, label, list]) => {
          const chosen = kind === 'input' ? snapshot.audioInputId : snapshot.audioOutputId;
          return (
            <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <Eyebrow>{label}</Eyebrow>
              {list.length === 0 && (
                <p style={{ margin: 0, font: '400 11px/1.5 Inter', color: 'var(--muted)' }}>
                  No {label.toLowerCase()} found. Enable the softphone first so Chrome lists your devices.
                </p>
              )}
              {list.map((d, i) => {
                // Until a choice is made the browser default is in use.
                const selected = chosen ? chosen === d.deviceId : d.deviceId === 'default' || (i === 0 && !list.some((x) => x.deviceId === 'default'));
                return (
                  <button
                    key={d.deviceId || `${kind}-${i}`}
                    type="button"
                    onClick={() => void dispatch({ type: 'setAudio', kind, deviceId: d.deviceId })}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '9px 10px',
                      borderRadius: 10,
                      border: '1px solid var(--dark-2)',
                      background: selected ? 'rgba(255,35,59,.18)' : 'rgba(255,255,255,.04)',
                      color: '#fff',
                      font: '500 12px/1.2 Inter',
                      textAlign: 'left',
                    }}
                  >
                    <Icon name={kind === 'input' ? 'mic' : 'speaker'} size={14} style={{ color: 'var(--accent-light)' }} />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {d.label || `${label} ${i + 1}`}
                    </span>
                    {selected && <Icon name="check" size={14} style={{ color: 'var(--accent-light)' }} />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
