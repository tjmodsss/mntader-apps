'use strict';
// Presentation choices never change the base units or quality of vehicle readings.
function category(id) {
    if (['speed', 'range', 'tripDistance', 'odometer'].indexOf(id) >= 0) return 'speed';
    if (['oil', 'coolant', 'intake', 'ambient', 'tFL', 'tFR', 'tRL', 'tRR'].indexOf(id) >= 0) return 'temperature';
    if (id === 'boost' || /^p(?:FL|FR|RL|RR)$/.test(id)) return 'pressure';
    if (['consumption', 'avgConsumption', 'tripFuel', 'fuelFlow'].indexOf(id) >= 0) return 'consumption';
    return null;
}
function imperial(config, id) {
    const kind = category(id), selected = config.displayUnits && config.displayUnits[kind];
    if (selected) return selected === 'mph' || selected === 'f' || selected === 'psi' || selected === 'mpg';
    return config.units === 'us';
}
module.exports = { category, imperial };
