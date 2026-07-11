/**
 * Transmission temperature provider interface.
 *
 * The ProMaster shipped with two different transmissions — 62TE (6-speed,
 * 2014–2021) and 948TE (9-speed, 2022+) — that expose trans temp via
 * different modules/DIDs. Each path is wrapped in a provider; the resolver
 * (transPathResolver) picks one per vehicle via auto-detection or the
 * transMode setting.
 */

export type TransPathId = '62TE' | '948TE';

export interface TransTempProvider {
  id: TransPathId;
  /**
   * Detect whether this path answers on this vehicle/adapter. May perform
   * bus traffic. On success the provider is left ready for read().
   */
  probe(): Promise<boolean>;
  /**
   * One trans-temp poll. Performs its own AT setup/teardown, updates the
   * vehicle store on a valid reading, and returns °F (null = no data this poll).
   */
  read(): Promise<number | null>;
}
