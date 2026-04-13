/** In-memory trip statistics, finalized when trip ends. */

import { haversineMiles } from '../utils/geo';

export class TripStats {
  tripId: number | null = null;
  startTs = 0;
  endTs: number | null = null;

  // Distance tracking
  distanceMi = 0;
  lastLat: number | null = null;
  lastLon: number | null = null;

  // Temperature tracking
  maxTransF: number | null = null;
  maxCoolantF: number | null = null;
  transWarnSecs = 0;
  coolantWarnSecs = 0;

  // Speed tracking
  speedSamples = 0;
  speedSum = 0;

  get avgSpeedMph(): number {
    if (this.speedSamples === 0) return 0;
    return this.speedSum / this.speedSamples;
  }

  get durationSecs(): number {
    const end = this.endTs ?? Date.now() / 1000;
    return end - this.startTs;
  }

  /** Update trip distance with new position. Returns delta in miles. */
  updateDistance(lat: number, lon: number): number {
    if (this.lastLat === null || this.lastLon === null) {
      this.lastLat = lat;
      this.lastLon = lon;
      return 0;
    }

    const deltaMi = haversineMiles(this.lastLat, this.lastLon, lat, lon);

    // Filter GPS jumps (> 0.5 mile in one update = likely error)
    if (deltaMi < 0.5) {
      this.distanceMi += deltaMi;
      this.lastLat = lat;
      this.lastLon = lon;
      return deltaMi;
    }

    // GPS jump — update position but don't add to distance
    this.lastLat = lat;
    this.lastLon = lon;
    return 0;
  }

  /** Record a speed sample for average calculation. */
  updateSpeed(speedMph: number): void {
    if (speedMph >= 0) {
      this.speedSamples += 1;
      this.speedSum += speedMph;
    }
  }

  /** Update temperature tracking with current readings. */
  updateTemps(
    transF: number | null,
    coolantF: number | null,
    dtSecs: number,
    transWarn = 230,
    coolantWarn = 220,
  ): void {
    if (transF !== null) {
      if (this.maxTransF === null || transF > this.maxTransF) {
        this.maxTransF = transF;
      }
      if (transF >= transWarn) {
        this.transWarnSecs += dtSecs;
      }
    }

    if (coolantF !== null) {
      if (this.maxCoolantF === null || coolantF > this.maxCoolantF) {
        this.maxCoolantF = coolantF;
      }
      if (coolantF >= coolantWarn) {
        this.coolantWarnSecs += dtSecs;
      }
    }
  }
}
