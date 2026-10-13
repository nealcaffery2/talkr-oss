import { useEffect, useState } from 'react';
import { onSessionChanged, session, type Session } from './session';

/**
 * The session as React state. `undefined` while the first read is in flight,
 * so a surface can avoid flashing the sign-in screen at a signed-in rep.
 */
export function useSession(): Session | null | undefined {
  const [value, setValue] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    session
      .get()
      .then((s) => alive && setValue(s))
      .catch(() => alive && setValue(null));
    const off = onSessionChanged((s) => alive && setValue(s));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return value;
}
