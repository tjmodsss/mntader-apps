'use strict';
// Russian labels are a separate presentation layer. The pinned Retro JSON and DSEG atlases stay intact.
const HEADS = { rpm: 'ОБОРОТЫ', boost: 'НАДДУВ', oil: 'МАСЛО', coolant: 'ОХЛАЖД.', intake: 'ВПУСК',
    speed: 'СКОРОСТЬ', fuel: 'ТОПЛИВО', range: 'ЗАПАС ХОДА' };
const LABELS = { gear_label: 'КПП', oil_label: 'МАСЛО', coolant_label: 'ОХЛАЖД.', fuel_label: 'ТОПЛИВО',
    boost_head: 'НАДДУВ {{u:boost}}' };
function russian(config) { return config.language !== 'en'; }
function layout(original, config) {
    if (!russian(config)) return original;
    const result = JSON.parse(JSON.stringify(original));
    result.name = 'Ретро 80-х';
    result.widgets.forEach((widget) => {
        if (LABELS[widget.id]) widget.text = LABELS[widget.id];
        if (widget.font === 'head') widget.font = 'ru_head';
        if (widget.font === 'unit') widget.font = 'ru_unit';
    });
    return result;
}
function unit(value) {
    return ({ 'KM/H': 'КМ/Ч', MPH: 'МИЛЬ/Ч', BAR: 'БАР', KM: 'КМ', MI: 'МИЛЬ' })[value] || value;
}
function sensor(original, config) {
    if (!original || !russian(config)) return original;
    return Object.assign({}, original, { head: HEADS[original.id] || original.head,
        unit: typeof original.unit === 'function' ? (us) => unit(original.unit(us)) : original.unit });
}
function token(name, config) {
    if (!russian(config)) return undefined;
    const us = config.units === 'us';
    if (name === 'u:speed') return us ? 'МИЛЬ/Ч' : 'КМ/Ч';
    if (name === 'u:boost') return us ? 'PSI' : 'БАР';
    return undefined;
}
module.exports = { layout, sensor, token, russian };
