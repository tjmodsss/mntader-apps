'use strict';
const finite = (n) => typeof n === 'number' && isFinite(n);
const TRANSITION_MS = 100;
/** Presentation only. Never predicts a new value or updates the signal source. */
class DisplayMotion {
    constructor() { this.clear(); }
    clear() { this.target = null; this.from = null; this.begin = null; this.at = null; this.epoch = null; }
    value(now) {
        if (!finite(this.target)) return null;
        const part = Math.max(0, Math.min(1, (now - this.begin) / TRANSITION_MS));
        return this.from + (this.target - this.from) * part;
    }
    sample(raw, now, receivedAt, epoch) {
        if (!finite(raw) || !finite(now)) { this.clear(); return null; }
        // A new lifecycle, stopped rendering, reversed clock, and a real zero
        // must not replay an animation from the preceding drive/frame sequence.
        if (!finite(this.target) || epoch !== this.epoch || now < this.at || now - this.at > 250 || raw === 0) {
            this.from = this.target = raw; this.begin = now; this.epoch = epoch;
        } else if (raw !== this.target) {
            this.from = this.value(now); this.target = raw;
            this.begin = finite(receivedAt) ? Math.min(now, receivedAt) : now;
        }
        this.at = now;
        return this.value(now);
    }
}
module.exports = { DisplayMotion: DisplayMotion, TRANSITION_MS: TRANSITION_MS, FRAME_MS: 34 };
