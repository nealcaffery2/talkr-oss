import { describe, expect, it } from 'vitest';
import {
  HOLD_MUSIC_URL_MAX,
  holdMusicSettingSchema,
  holdMusicWaitUrl,
  isPlayableHoldMusicUrl,
  orgSettingsPatchSchema,
  readHoldMusic,
} from '../src/org-settings.js';

describe('hold music validation', () => {
  it('accepts the three modes', () => {
    expect(holdMusicSettingSchema.parse({ mode: 'default' })).toEqual({ mode: 'default' });
    expect(holdMusicSettingSchema.parse({ mode: 'silence' })).toEqual({ mode: 'silence' });
    expect(holdMusicSettingSchema.parse({ mode: 'url', url: 'https://cdn.example.com/hold.mp3' })).toEqual({
      mode: 'url',
      url: 'https://cdn.example.com/hold.mp3',
    });
  });

  it('rejects an unknown mode', () => {
    expect(holdMusicSettingSchema.safeParse({ mode: 'jazz' }).success).toBe(false);
  });

  it('requires a url in url mode', () => {
    expect(holdMusicSettingSchema.safeParse({ mode: 'url' }).success).toBe(false);
    expect(holdMusicSettingSchema.safeParse({ mode: 'url', url: '   ' }).success).toBe(false);
  });

  it('drops a url the mode does not use, so it cannot be resurrected later', () => {
    expect(holdMusicSettingSchema.parse({ mode: 'silence', url: 'https://example.com/a.mp3' })).toEqual({
      mode: 'silence',
    });
  });

  it('trims the stored url', () => {
    expect(holdMusicSettingSchema.parse({ mode: 'url', url: '  https://example.com/a.mp3  ' })).toEqual({
      mode: 'url',
      url: 'https://example.com/a.mp3',
    });
  });

  it('refuses anything but http(s)', () => {
    for (const url of ['ftp://example.com/a.mp3', 'file:///etc/passwd', 'javascript:alert(1)', 'data:audio/mp3;base64,AAA']) {
      expect(isPlayableHoldMusicUrl(url)).toBe(false);
      expect(holdMusicSettingSchema.safeParse({ mode: 'url', url }).success).toBe(false);
    }
  });

  it('refuses a relative or malformed url', () => {
    for (const url of ['/hold.mp3', 'hold.mp3', 'https://', 'not a url']) {
      expect(isPlayableHoldMusicUrl(url)).toBe(false);
    }
  });

  // The carrier fetches this from the public internet, so these are not
  // "probably wrong" — they are guaranteed dead air on a live call.
  it('refuses hosts the carrier could never reach', () => {
    for (const url of [
      'http://localhost/hold.mp3',
      'http://localhost:8080/hold.mp3',
      'http://127.0.0.1/hold.mp3',
      'http://10.0.0.5/hold.mp3',
      'http://192.168.1.10/hold.mp3',
      'http://172.16.4.4/hold.mp3',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/hold.mp3',
      'https://intranet/hold.mp3',
      'https://box.local/hold.mp3',
    ]) {
      expect(isPlayableHoldMusicUrl(url)).toBe(false);
    }
  });

  it('allows public hosts, including ones outside the private ranges', () => {
    for (const url of [
      'https://cdn.example.com/hold.mp3',
      'http://example.co.uk/twiml/hold',
      'https://example.com:8443/hold.wav?token=abc',
      'https://172.32.0.1/hold.mp3',
      'https://11.0.0.1/hold.mp3',
    ]) {
      expect(isPlayableHoldMusicUrl(url)).toBe(true);
    }
  });

  it('refuses credentials embedded in the url', () => {
    expect(isPlayableHoldMusicUrl('https://user:pass@example.com/hold.mp3')).toBe(false);
  });

  it('bounds the url length', () => {
    const long = `https://example.com/${'a'.repeat(HOLD_MUSIC_URL_MAX)}.mp3`;
    expect(isPlayableHoldMusicUrl(long)).toBe(false);
    expect(holdMusicSettingSchema.safeParse({ mode: 'url', url: long }).success).toBe(false);
  });
});

describe('hold music readers', () => {
  it('falls back to the platform default for anything unrecognised', () => {
    for (const settings of [
      null,
      undefined,
      {},
      'nonsense',
      { hold_music: null },
      { hold_music: 'classical' },
      { hold_music: { mode: 'url' } }, // written before validation existed
      { hold_music: { mode: 'url', url: 'ftp://example.com/a.mp3' } },
    ]) {
      expect(readHoldMusic(settings)).toEqual({ mode: 'default' });
    }
  });

  it('reads a stored setting back', () => {
    expect(readHoldMusic({ hold_music: { mode: 'silence' }, timezone: 'America/New_York' })).toEqual({
      mode: 'silence',
    });
  });

  it('maps modes onto the provider waitUrl', () => {
    // undefined omits the attribute entirely (the carrier's own music);
    // '' is the documented "no wait music" value.
    expect(holdMusicWaitUrl({ mode: 'default' })).toBeUndefined();
    expect(holdMusicWaitUrl({ mode: 'silence' })).toBe('');
    expect(holdMusicWaitUrl({ mode: 'url', url: 'https://example.com/a.mp3' })).toBe(
      'https://example.com/a.mp3',
    );
  });
});

describe('org settings patch', () => {
  it('accepts an empty patch and a hold-music-only patch', () => {
    expect(orgSettingsPatchSchema.parse({})).toEqual({});
    expect(orgSettingsPatchSchema.parse({ hold_music: { mode: 'silence' } })).toEqual({
      hold_music: { mode: 'silence' },
    });
  });

  it('refuses keys it does not own, so a typo cannot land in the blob', () => {
    expect(orgSettingsPatchSchema.safeParse({ timezone: 'America/New_York' }).success).toBe(false);
  });

  it('refuses an invalid hold-music url at write time', () => {
    expect(
      orgSettingsPatchSchema.safeParse({ hold_music: { mode: 'url', url: 'http://localhost/a.mp3' } })
        .success,
    ).toBe(false);
  });
});
