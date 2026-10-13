/**
 * One recording's audio bytes, whichever carrier produced it
 * (docs/transcription.md §2).
 *
 * Telnyx stores a pre-signed S3 link that already carries its extension and
 * expires minutes after the call, so the fetch re-mints it from the recording
 * id when needed. The carrier-specific half lives in the adapter
 * (`VoiceProvider.fetchRecordingMedia`), which is where provider vocabulary
 * belongs; what is left here is the choice of adapter. A recording is fetched
 * by the adapter for the carrier that made it; one from a carrier that is no
 * longer configured (Twilio, before it was removed) falls to the active one.
 */

import type { RecordingFormat, RecordingMedia, VoiceProvider } from '@talkr/core';
import type { Config } from '../config.js';
import { createProvider, type TalkrProvider } from './provider-factory.js';
import type { DbHandle } from '@talkr/db';

/** The half of a `recordings` row that says where the media lives. */
export interface RecordingMediaRow {
  provider?: string | null;
  providerUrl?: string | null;
  providerRecordingId?: string | null;
}

export type RecordingMediaFetcher = (
  recording: RecordingMediaRow,
  opts?: { format?: RecordingFormat },
) => Promise<RecordingMedia>;

function canFetch(
  provider: VoiceProvider | undefined,
): provider is VoiceProvider & Required<Pick<VoiceProvider, 'fetchRecordingMedia'>> {
  return typeof provider?.fetchRecordingMedia === 'function';
}

export function makeRecordingMediaFetcher(
  config: Config,
  provider?: TalkrProvider,
  dbh?: DbHandle,
): RecordingMediaFetcher {
  // Adapters built on demand for a recording made by another carrier. Built
  // once per process: they hold nothing but credentials and a fetch.
  const byName = new Map<string, TalkrProvider | null>();

  function adapterFor(name: string | null | undefined): TalkrProvider | null {
    if (!name || name === provider?.name) return provider ?? null;
    if (!byName.has(name)) {
      let built: TalkrProvider | null = null;
      try {
        // Missing credentials for that carrier throw here; the active
        // provider is then tried instead, and reports its own failure.
        // Only Telnyx can be built; a recording from a carrier that is gone
        // has no adapter left and falls through to the active one.
        if (name === 'telnyx') built = createProvider(config, dbh, 'telnyx');
      } catch {
        built = null;
      }
      byName.set(name, built);
    }
    return byName.get(name) ?? provider ?? null;
  }

  return async (recording, opts = {}) => {
    const adapter = adapterFor(recording.provider) ?? provider;
    if (!canFetch(adapter)) {
      throw new Error(
        `no carrier adapter can fetch ${recording.provider ?? 'this'} recording media on this server`,
      );
    }
    return adapter.fetchRecordingMedia({
      providerUrl: recording.providerUrl,
      providerRecordingId: recording.providerRecordingId,
      format: opts.format ?? 'mp3',
    });
  };
}
