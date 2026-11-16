'use strict';

// Parked-only gate. Playback is allowed only while a real, recent speed value
// says the car stands still; a missing, invalid or stale value locks it.
const MAX_KMH = 0.5, STALE_MS = 5000, INVALID = 65535, SCALE = 0.015625;

class ParkedGuard {
    constructor(options) {
        options = options || {};
        this.now = options.now || (() => Date.now());
        this.maxKmh = options.maxKmh === undefined ? MAX_KMH : options.maxKmh;
        this.staleMs = options.staleMs || STALE_MS;
        this.speed = null; this.at = 0;
    }
    /** statusCarSpeed2.speedVehicleCentreOfGravity as received. Invalid values are ignored (and so go stale). */
    update(raw) {
        if (typeof raw !== 'number' || !isFinite(raw) || raw < 0 || raw === INVALID) return false;
        this.speed = raw * SCALE; this.at = this.now();
        return true;
    }
    fresh() { return this.speed !== null && this.now() - this.at < this.staleMs; }
    /** 'parked' | 'moving' | 'no-signal' */
    state() { return !this.fresh() ? 'no-signal' : this.speed <= this.maxKmh ? 'parked' : 'moving'; }
    allowed() { return this.state() === 'parked'; }
    /** Why playback is locked ('' while parked). */
    hint() {
        const s = this.state();
        return s === 'no-signal' ? 'Waiting for real vehicle-speed data. Playback is locked.' :
            s === 'moving' ? 'Moving vehicle. Playback stopped.' : '';
    }
}
module.exports = { ParkedGuard, MAX_KMH, STALE_MS };
