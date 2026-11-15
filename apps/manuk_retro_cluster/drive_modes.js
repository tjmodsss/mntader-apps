'use strict';
// Exact ICE FES enum names/numbers used by idrive7-apps live_data/signals.js and
// ambient_config/ambient.js (MIT, pinned in UPSTREAM.lock.json). No prefix guesses.
const MODES = [
    null,
    ['SPORT_DYNAMIC', 'SPORT', 'sport'],
    ['SPORT_EXPERT', 'SPORT+', 'sport'],
    ['SPORT_INDIVIDUAL', 'SPORT INDIVIDUAL', 'sport'],
    ['COMFORT', 'COMFORT', 'comfort'],
    ['COMFORT_PLUS', 'COMFORT+', 'comfort'],
    ['COMFORT_INDIVIDUAL', 'COMFORT INDIVIDUAL', 'comfort'],
    ['ECO_PRO_EFFICIENT', 'ECO PRO', 'eco'],
    ['ECO_PRO_PLUS', 'ECO PRO+', 'eco'],
    ['ECO_PRO_INDIVIDUAL', 'ECO PRO INDIVIDUAL', 'eco'],
    ['ADAPTIVE', 'ADAPTIVE', null],
];
function decode(raw) {
    let index = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : -1;
    if (index < 0) index = MODES.findIndex((m) => m && m[0] === raw);
    const row = Number.isInteger(index) ? MODES[index] : null;
    return row ? { name: row[1], profile: row[2], raw: raw, known: true }
        : { name: null, profile: null, raw: raw, known: false };
}
module.exports = { decode };
