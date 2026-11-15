'use strict';
// Presentation only. No vehicle writes, inferred transmission programme or DSC lookup.
const clone = (v) => JSON.parse(JSON.stringify(v));
const displayUnits = require('./display_units');
const finite = (v) => typeof v === 'number' && isFinite(v);
const NAMES = ['comfort', 'sport', 'eco'];
const TACHOMETER = { max: 8000, segments: 80, step: 100, yellowAt: 6000, redAt: 7000, flashHalfPeriodMs: 250 };
function rpmFraction(value, completeCells) {
    // Linear RPM axis. Every complete block represents 100rpm.
    let rpm = finite(value) ? Math.max(0, Math.min(TACHOMETER.max, value)) : 0;
    if (completeCells) rpm = Math.floor(rpm / TACHOMETER.step) * TACHOMETER.step;
    return rpm / TACHOMETER.max;
}
function rpmFlash(value, now) {
    // Two phases on the existing HUD clock; never create a timer or latch
    // a stale RPM warning after the value disappears or leaves the red zone.
    return finite(value) && value >= TACHOMETER.redAt
        ? (Math.floor(now / TACHOMETER.flashHalfPeriodMs) % 2 === 0 ? 1 : 2) : 0;
}
function coldRpmRange(reading) {
    // Internal presentation contract, not the name of a BMW signal. Only an
    // independently confirmed, active cold restriction may produce this value.
    // No timer, oil-temperature estimate, configured redline or learned peak.
    if (!reading || reading.quality !== 'valid' || reading.active !== true || reading.unit !== 'rpm'
        || typeof reading.source !== 'string' || !reading.source.length
        || !finite(reading.value) || reading.value <= 0 || reading.value >= TACHOMETER.max) return [0, 0];
    return [1, reading.value / TACHOMETER.max];
}
const CATALOG = {
    rpm: ['ОБОРОТЫ', 'RPM', '', '', 0], boost: ['НАДДУВ', 'BOOST', 'БАР', 'PSI', 2],
    power: ['МОЩН.РАСЧ.', 'POWER CALC.', 'КВТ', 'HP', 0], torque: ['МОМЕНТ', 'TORQUE', 'НМ', 'LB-FT', 0],
    oil: ['МАСЛО', 'OIL', '°C', '°F', 0], coolant: ['ОХЛАЖД.', 'COOLANT', '°C', '°F', 0],
    intake: ['ВПУСК', 'INTAKE', '°C', '°F', 0], ambient: ['СНАРУЖИ', 'OUTSIDE', '°C', '°F', 0],
    speed: ['СКОРОСТЬ', 'SPEED', 'КМ/Ч', 'MPH', 0], fuel: ['ТОПЛИВО', 'FUEL', '%', '%', 0],
    range: ['ЗАПАС', 'RANGE', 'КМ', 'MI', 0],
    avgConsumption: ['СР. BC1', 'AVG BC1', 'Л/100КМ', 'MPG US', 1],
    consumption: ['РАСХОД', 'FUEL RATE', 'Л/100КМ', 'MPG US', 1],
    fuelFlow: ['РАСХОД', 'FUEL FLOW', 'Л/Ч', 'GAL/H', 1],
    tripDistance: ['ПУТЬ BC', 'TRIP BC', 'КМ', 'MI', 1],
    tripMinutes: ['ВРЕМЯ BC', 'TIME BC', 'МИН', 'MIN', 0],
    tripFuel: ['ТОПЛ.ПОЕЗД.', 'TRIP FUEL', 'Л', 'GAL', 1],
    odometer: ['ОДОМЕТР', 'ODOMETER', 'ТЫС.КМ', 'K MI', 1],
    gLong: ['ПРОДОЛЬН.', 'LONG', 'G', 'G', 2], gLat: ['ПОПЕРЕЧН.', 'LATERAL', 'G', 'G', 2],
};
['FL', 'FR', 'RL', 'RR'].forEach((w, i) => {
    const ru = ['ПЛ', 'ПП', 'ЗЛ', 'ЗП'][i];
    CATALOG['p' + w] = ['ШИНА ' + ru, 'TYRE ' + w, 'БАР', 'PSI', 1];
    CATALOG['t' + w] = ['ШИНА ' + ru, 'TYRE ' + w, '°C', '°F', 0];
});
function enabled(config) { return !!(config.profiles && config.profiles.enabled); }
function choose(config, driveProfile, forced) {
    if (!enabled(config)) return 'original';
    if (NAMES.indexOf(forced) >= 0 || forced === 'neutral') return forced;
    return config.profiles.followVehicleMode && NAMES.indexOf(driveProfile) >= 0 ? driveProfile : 'neutral';
}
function sensor(id, config) {
    const v = CATALOG[id]; if (!v) return null;
    const ru = config.language !== 'en';
    const english = { 'БАР': 'BAR', 'КВТ': 'KW', 'НМ': 'NM', 'КМ/Ч': 'KM/H', 'КМ': 'KM',
        'Л/100КМ': 'L/100KM', 'Л/Ч': 'L/H', 'МИН': 'MIN', 'Л': 'L', 'ТЫС.КМ': 'K KM' };
    return { id, head: v[ru ? 0 : 1], tok: 'metric:' + id, unit: (us) => { const u = v[us ? 3 : 2]; return ru ? u : english[u] || u; }, precision: v[4] };
}
function slot(config, profile, id) {
    if (profile === 'original') return config.retro.slots[id];
    return id === '1' ? 'consumption' : id === '2' ? 'range' : null;
}
function main(profile, speed) { return finite(speed) && speed === 0 ? 'fuelFlow' : 'consumption'; }
function transmission(state) {
    // Selector, programme and actual gear remain independent observations.
    // Park/reverse/neutral take precedence over a retained forward-gear value.
    if (['P', 'R', 'N'].indexOf(state.selector) >= 0) return { program: '', gear: state.selector };
    return {
        program: ['D', 'S', 'M'].indexOf(state.gearboxProgram) >= 0 ? state.gearboxProgram : '-',
        gear: Number.isInteger(state.gear) && state.gear >= 1 && state.gear <= 8 ? String(state.gear) : '-',
    };
}
function gearboxLabel(state) {
    // This compact caption accepts P/N/D/S/M/R, separately from the actual gear.
    // D may describe the selector position; it does not infer programme D.
    if (['P', 'R', 'N'].indexOf(state.selector) >= 0) return state.selector;
    if (['S', 'M'].indexOf(state.gearboxProgram) >= 0) return state.gearboxProgram;
    if (state.gearboxProgram === 'D' || state.selector === 'D') return 'D';
    return '-';
}
function format(id, value, config) {
    if (!finite(value) || !CATALOG[id]) return '--';
    const us = displayUnits.imperial(config, id);
    let n = value, places = CATALOG[id][4];
    if (['oil', 'coolant', 'intake', 'ambient', 'tFL', 'tFR', 'tRL', 'tRR'].indexOf(id) >= 0 && us) n = n * 1.8 + 32;
    else if (['speed', 'range', 'tripDistance', 'odometer'].indexOf(id) >= 0 && us) n *= 0.621371;
    else if ((id === 'boost' || /^p(?:FL|FR|RL|RR)$/.test(id)) && us) { n *= 14.5038; places = 1; }
    else if (id === 'power' && us) n *= 1.341022;
    else if (id === 'torque' && us) n *= 0.737562;
    else if ((id === 'avgConsumption' || id === 'consumption') && us) { if (n <= 0) return '--'; n = 235.214583 / n; }
    else if ((id === 'tripFuel' || id === 'fuelFlow') && us) n /= 3.785411784;
    if (id === 'fuel') n *= 100;
    if (id === 'odometer') { n /= 1000; if (n >= 100) places = 0; }
    // No compression or fallback typeface; rendering enforces the original box width.
    return n.toFixed(places);
}
function layout(original, config) {
    if (!enabled(config)) return original;
    // New status fields need '+' (SPORT+) and '!' even in English. The original
    // head atlas has neither; the approved label atlas covers both alphabets.
    const out = clone(original), font = 'ru_head';
    const by = {}; out.widgets.forEach((w) => { by[w.id] = w; });
    // Keep the reference JSON immutable. This is the explicitly requested adapted layout.
    by.revs.segments = TACHOMETER.segments;
    // Use the original larger DSEG atlas, without rescaling any glyph. The
    // 466px box holds three 155px cells plus 1px padding at integer coordinates.
    // Gear + speed reserve x663..1357 in the authored geometry. The whole
    // composition is centred on the panel below, retaining every internal gap.
    // Original glyph ink is 118px wide: 37px between speed digits, 111px
    // between the gear and the first speed cell. Mode/DSC stays independent.
    ['speed', 'speed_ghost'].forEach(id => Object.assign(by[id], { x: 891, y: 387, w: 466, h: 195, font: 'd7_gear' }));
    Object.assign(by.speed_unit, { x: 1064, y: 605, w: 120, align: 'center' });
    ['gear', 'gear_ghost'].forEach(id => Object.assign(by[id], { x: 663, y: 387, w: 155, h: 195, font: 'd7_gear', align: 'left' }));
    by.gear.color = 'fg';
    delete by.gear.hotWhen;
    Object.assign(by.gear_label, { x: 650, y: 605, w: 181, h: 37, text: '{{gearboxCaption}}',
        font: 'ru_unit', color: 'fg', align: 'center', spacing: 0 });
    // Keep the two temperature gauges to the right of the conservative stock
    // gear footprint (x1406..1597, y342..419); oil leaves 8px after centring.
    // The owner confirmed gear-overlay occlusion on the G30, but its exact
    // bounds still need a vehicle check. Boost remains diagnostic data only.
    const oilCentre = 1681, coolantCentre = 1820;
    [['oil', oilCentre], ['coolant', coolantCentre], ['fuel', 490]].forEach(pair => {
        const id = pair[0], centre = pair[1];
        [id, id + '_ghost', id + '_label'].forEach(key => { by[key].x = centre - by[key].w / 2; });
        Object.assign(by[id + '_bar'], { x: centre - 26, segments: 15 });
        // Pack fuel with the other left gauges, avoiding an almost screen-wide
        // image sheet spanning the gap to the two right-hand temperatures.
        if (id === 'fuel') [id, id + '_ghost', id + '_label', id + '_bar'].forEach(key => { by[key].conn = 3; });
    });
    out.widgets = out.widgets.filter(w => ['boost_head', 'boost', 'boost_ghost', 'boost_bar', 'slot1_head', 'slot1', 'slot2_head', 'slot2', 'clock', 'clock_ghost'].indexOf(w.id) < 0);
    const add = (id, x, y, w, h, text, face, color, align, conn) => out.widgets.push({ id, type: 'text', z: 5, x, y, w, h,
        text, font: face || font, color: color || 'green', align: align || 'center', conn: conn === undefined ? 1 : conn });
    // Match the existing unit row below consumption and range.
    [['fuel', 490, '%', 3], ['oil', oilCentre, '{{u:temp}}', 2], ['coolant', coolantCentre, '{{u:temp}}', 2]].forEach(row => {
        add(row[0] + '_unit', row[1] - 65, 655, 130, 27, row[2], font, 'green', 'center', row[3]);
    });
    // Two gauges use the same original meter component and d7_sm readouts.
    // Separate unit labels keep all headings legible without reducing fonts.
    [['consumption', 200, '{{consumptionLabel}}', '{{consumptionUnit}}', '{{profileMain}}', 'profileConsumption'],
        ['range', 345, '{{rangeLabel}}', '{{rangeUnit}}', '{{rangeValue}}', 'range']].forEach(row => {
        const id = row[0], centre = row[1], width = id === 'range' ? 160 : 130;
        add(id + '_label', centre - 65, 292, 130, 27, row[2], font, 'green', 'center', 3);
        out.widgets.push({ id: id + '_bar', type: 'meter', class: 'content', z: 2, x: centre - 26, y: 332,
            w: 52, h: 262, signal: row[5], min: 0, max: config.profiles.gaugeMax[id], segments: 15, gap: 5,
            vertical: true, colors: ['green', 'fg', 'green'], at: [0.3, 0.7], conn: 3 });
        add(id + '_ghost', centre - width / 2, 602, width, 47, id === 'range' ? '8888' : '88.8', 'd7_sm', 'ghost', 'center', 3);
        add(id, centre - width / 2, 602, width, 47, row[4], 'd7_sm', 'fg', 'center', 3);
        add(id + '_unit', centre - 65, 655, 130, 27, row[3], font, 'green', 'center', 3);
    });
    add('drive_mode', 620, 332, 780, 31, '{{modeAndDsc}}', 'ru_status', 'green');
    add('profile_axis', 1400, 155, 460, 27, '{{profileAxis}}', font, 'dim', 'right');
    // The upstream tachometer is centred at x1010 on the 1920px panel. Centre
    // the complete adapted composition at x960 instead: equal side margins,
    // unchanged glyphs, meter sizes and spacing. Keep the full-panel background
    // fixed; this translation is independent of any car-specific visibility mask.
    const dx = by.bg.x + by.bg.w / 2 - (by.revs.x + by.revs.w / 2);
    out.widgets.forEach((w) => { if (w !== by.bg) w.x += dx; });
    return out;
}
function theme(base, profile, config) {
    const out = clone(base);
    const hex = config.profiles.accents[profile];
    const neutral = [190, 198, 204]; // Existing Adaptive white, shared by every profile.
    const rgb = hex ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : neutral;
    ['fg', 'dim', 'arc', 'line', 'head', 'green'].forEach((k) => { out[k] = neutral.concat(255); });
    out.accent = rgb.concat(255);
    out.ghost = neutral.concat(40); out.track = neutral.concat(75);
    out.hot = [255, 224, 64, 255]; // Warning colour is distinct from the normal red Sport accent.
    out.bar = { low: [80, 255, 120], mid: [255, 224, 64], high: [255, 59, 48], midAt: 0.75 };
    return out;
}
module.exports = { CATALOG, NAMES, TACHOMETER, rpmFraction, rpmFlash, coldRpmRange, enabled, choose, sensor, slot, main, transmission, gearboxLabel, format, layout, theme };
