'use strict';
// Signal names/scaling and enum mappings from the MIT MGU App Kit, pinned in UPSTREAM.lock.json.
// No simulator, gear inference, diagnostic calls, setters, or vehicle characteristics.
const driveModes = require('./drive_modes');
const IF = {
    cds: 'de.bmw.infotainment.vehicle.CDS', speed: 'de.bmw.infotainment.vehicle.Vehicle2',
    gear: 'de.bmw.infrastructure.VehicleInformation', condition: 'de.bmw.infrastructure.VehicleCondition',
    fuel: 'de.bmw.infotainment.KombiIF', boost: 'de.bmw.infotainment.drivingexcitement.FES',
    accel: 'de.bmw.infotainment.vehicle.CDS2', units: 'de.bmw.infotainment.vehicle.Vehicle',
    tyres: 'de.bmw.infotainment.vehicle.TPMS', ambient: 'de.bmw.infrastructure.EnvironmentalInformation',
    mdrive: 'de.bmw.infotainment.misc.MDrive', dsc: 'de.bmw.chassis.VehicleStabilizationManagement',
};
const FIELDS = {
    cds: ['statusEngineSpeed2', 'statusEngineTemperature', 'statusEngineStatus'], speed: ['statusCarSpeed2'],
    gear: ['statusGearboxDrive', 'DataPowerTrain2'], condition: ['VehicleCondition'],
    fuel: ['statusRangeTankStatus', 'statusBordcomputerAverage', 'statusBordcomputerTravelData'],
    boost: ['statusSwitchDriveDynamicSport2', 'statusActualValueTorque2', 'statusFESVehicleDynamicSwitchHMI'],
    accel: ['statusLongitudinalAccelerationMassCenter', 'statusLateralAccelerationMassCenter'],
    units: ['statusNewCurrentUnitsStatusExt'], tyres: ['statusTyrePressure', 'statusTyreTemperature'],
    ambient: ['ExteriorTemperature'], mdrive: ['dataDisplayGearbox'], dsc: ['StabilizationManagement'],
};
const CORNERS = ['FL', 'FR', 'RL', 'RR'];
const TYRE_KEYS = CORNERS.map((c) => 'p' + c).concat(CORNERS.map((c) => 't' + c));
const KEYS = { cds: ['rpm', 'oil', 'coolant', 'engineRunning'], speed: ['speed'], gear: ['gear', 'stage'],
    condition: ['condition'], fuel: ['fuelL', 'range', 'odometer', 'avgConsumption', 'tripDistance', 'tripMinutes'],
    boost: ['boost', 'torque', 'driveMode', 'driveProfile'], accel: ['gLong', 'gLat'],
    units: ['pressureUnit', 'temperatureUnit'], tyres: TYRE_KEYS, ambient: ['ambient'],
    mdrive: ['gearboxProgram'], dsc: ['dsc'] };
const UNITS = { rpm: 'rpm', speed: 'km/h', oil: '°C', coolant: '°C', fuelL: 'l', fuelPct: '%', range: 'km',
    boost: 'bar', torque: 'Nm', power: 'kW', gLong: 'g', gLat: 'g', ambient: '°C', odometer: 'km',
    avgConsumption: 'l/100km', tripDistance: 'km', tripMinutes: 'min', consumption: 'l/100km',
    fuelFlow: 'l/h', tripFuel: 'l', intake: '°C', coldRpmLimit: 'rpm' };
TYRE_KEYS.forEach((key) => { UNITS[key] = key.charAt(0) === 'p' ? 'bar' : '°C'; });
const UNSUPPORTED = { engineProfile: 'no independent engine profile source established',
    consumption: 'no verified instantaneous consumption scaling', fuelFlow: 'no verified passive fuel flow source',
    tripFuel: 'no verified fuel flow source to integrate', intake: 'no verified passive intake temperature source',
    coldRpmLimit: 'no confirmed passive source for an active cold-engine RPM restriction; no temperature or timer fallback' };
// Dynamic engine/acceleration readings are renewed by notifications or successful getters.
// Slow getter-backed measurements tolerate three missed 10-second reads; event states use epochs.
const MAX_AGE = { boost: 3000, torque: 3000, gLong: 3000, gLat: 3000,
    fuelL: 35000, range: 35000, odometer: 35000, avgConsumption: 35000, tripDistance: 35000, tripMinutes: 35000 };
TYRE_KEYS.forEach((key) => { MAX_AGE[key] = 35000; });
const MEMBERS = { rpm: 'actualValueRPMEngineCrankshaft', speed: 'speedVehicleCentreOfGravity',
    oil: 'temperatureEngineOilDrive', coolant: 'temperatureEngineDrive', engineRunning: 'statusEngineRunDrive',
    fuelL: 'fluidLevelFuelTank', range: 'range', odometer: 'mileageKilometre', boost: 'displayBoostPressure',
    torque: 'actualValueTorqueCrankshaft', driveMode: 'actualValueModeDrivingExperience', driveProfile: 'actualValueModeDrivingExperience',
    avgConsumption: 'consumptionAverage1BC1', tripDistance: 'wayPassed', ambient: 'temperatureExterior',
    gLong: 'longitudinalAccelerationCentreOfGravity', gLat: 'lateralAccelerationCentreOfGravity',
    gearboxProgram: 'displayProgramGearbox', pressureUnit: 'unitOfMeasurementAirPressure', temperatureUnit: 'unitOfMeasurementTemperature' };
MEMBERS.condition = 'statusConditionVehicle';
CORNERS.forEach((c) => { MEMBERS['p' + c] = 'actualValuePressureTyre' + c + 'H'; MEMBERS['t' + c] = 'actualValueTemperatureTyre' + c + 'H'; });
const PRESSURE_UNITS = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' };
const TEMPERATURE_UNITS = { 1: 'C', 2: 'F', C: 'C', F: 'F' };
const CONSUMPTION_UNITS = { 1: 'l/100km', 2: 'mpg UK', 3: 'mpg US', 4: 'km/l',
    VERBRAUCH_IN_L_S_100KM: 'l/100km', VERBRAUCH_IN_MPG_UK: 'mpg UK', VERBRAUCH_IN_MPG_US: 'mpg US', VERBRAUCH_IN_KM_S_L: 'km/l' };
const CONDITION = { PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3,
    WOHNEN: 5, PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8, FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12 };
const finite = (v) => typeof v === 'number' && isFinite(v);
const lookup = (table, raw) => Object.prototype.hasOwnProperty.call(table, raw) ? table[raw] : null;
function scale(raw, invalid, factor, offset) {
    return finite(raw) && raw >= 0 && raw < invalid ? raw * factor + offset : null;
}
function gear(raw) {
    if (typeof raw === 'number') return Math.floor(raw) === raw && raw >= 3 && raw <= 12 ? raw - 2 : raw === 1 ? -1 : raw === 2 ? 0 : null;
    return /^G(?:[1-9]|10)$/.test(String(raw)) ? Number(raw.slice(1)) : raw === 'R' ? -1 : raw === 'N_OR_P' ? 0 : null;
}
function selection(raw) {
    const n = typeof raw === 'number' ? raw : ({ N: 1, R: 2, P: 3, NP: 4 }[raw] || (/^_[1-9]$/.test(String(raw)) ? 4 + Number(raw.slice(1)) : 0));
    if (n === 1) return { stage: 'N', gear: 0 };
    if (n === 2) return { stage: 'R', gear: -1 };
    if (n === 3) return { stage: 'P', gear: 0 };
    if (Math.floor(n) === n && n >= 5 && n <= 13) return { stage: 'D', gear: n - 4 };
    return { stage: null, gear: null }; // NP is deliberately ambiguous, not N.
}

class RetroSource {
    constructor(ctx, config, opts) {
        this.ctx = ctx; this.config = config; this.opts = opts || {};
        this.now = this.opts.now || Date.now;
        this.values = {}; this.sources = {}; this.listeners = [];
        this.started = false; this.closed = false; this.generation = 0;
        Object.keys(IF).forEach((k) => { this.sources[k] = { available: false, lifecycleSeen: false, epoch: 0, sub: null, busy: false, refreshed: 0 }; });
    }
    start() {
        if (this.started || this.closed) return;
        this.started = true;
        const generation = ++this.generation;
        Object.keys(IF).forEach((key) => {
            const handlers = {};
            FIELDS[key].forEach((field) => { handlers[field] = (v) => {
                if (!this.closed && generation === this.generation) this.receive(key, field, v);
            }; });
            Promise.resolve().then(() => this.ctx.signals.watch(IF[key], '1', handlers, this.ctx.log, {
                onAvailability: (available) => { if (!this.closed && generation === this.generation) this.availability(key, available); },
            })).then((sub) => {
                if (this.closed || generation !== this.generation) { if (sub && sub.shutdown) sub.shutdown(); return; }
                this.sources[key].sub = sub;
                if (sub.available) this.availability(key, true);
                if (sub.error) this.ctx.log.warn('source ' + key + ' unavailable');
            }).catch(() => { this.availability(key, false); this.ctx.log.warn('source ' + key + ' subscription failed'); });
        });
    }
    availability(key, on, fromValue) {
        const s = this.sources[key];
        if (s && !fromValue) s.lifecycleSeen = true;
        if (!s || s.available === !!on) return;
        s.available = !!on;
        if (!on) {
            s.epoch++;
            KEYS[key].forEach((k) => { delete this.values[k]; });
            if (key === 'condition') { this.vehicleInactive = true; this.invalidateDrive(); }
            if (key === 'units') this.invalidateTyres();
        }
        this.emit();
    }
    invalidateTyres() {
        TYRE_KEYS.forEach((key) => { delete this.values[key]; });
        const s = this.sources.tyres;
        s.epoch++; s.refreshed = 0;
        if (s.sub && s.sub.invalidate) s.sub.invalidate();
    }
    invalidateDrive() {
        Object.keys(this.sources).forEach((key) => {
            if (key === 'condition') return;
            const s = this.sources[key]; s.epoch++; s.refreshed = 0;
            s.needsSnapshot = true;
            KEYS[key].forEach((k) => { delete this.values[k]; });
            if (s.sub && s.sub.invalidate) s.sub.invalidate();
        });
    }
    put(key, value, source, meta) {
        const s = this.sources[source];
        this.values[key] = Object.assign({ value: value, at: this.now(), source: source, epoch: s.epoch,
            unit: UNITS[key] || '', quality: value === null ? 'invalid' : 'valid', origin: IF[source] }, meta || {});
    }
    receive(source, field, v) {
        if (this.closed) return;
        const provider = this.sources[source];
        if (!provider) return;
        if (provider.lifecycleSeen && !provider.available) return;
        if (source !== 'condition' && this.vehicleInactive) return;
        v = v || {};
        // A notification itself is evidence of this provider, even before watch() resolves.
        this.availability(source, true, true);
        const put = (k, value, extra) => this.put(k, value, source, Object.assign({
            origin: IF[source] + '.' + field + (MEMBERS[k] ? '.' + MEMBERS[k] : ''),
            raw: MEMBERS[k] ? v[MEMBERS[k]] : undefined,
        }, extra || {}));
        if (field === 'statusEngineSpeed2') put('rpm', scale(v.actualValueRPMEngineCrankshaft, 65535, 0.25, 0));
        if (field === 'statusEngineTemperature') {
            put('oil', scale(v.temperatureEngineOilDrive, 255, 1, -48));
            put('coolant', scale(v.temperatureEngineDrive, 255, 1, -48));
        }
        if (field === 'statusEngineStatus') {
            const running = { MOTOR_AUS: 'off', MOTOR_STARTET: 'starting', MOTOR_LAEUFT: 'running', 0: 'off', 1: 'starting', 2: 'running' };
            put('engineRunning', lookup(running, v.statusEngineRunDrive));
        }
        if (field === 'statusCarSpeed2') put('speed', scale(v.speedVehicleCentreOfGravity, 65535, 0.015625, 0));
        if (field === 'statusGearboxDrive') {
            const stages = { P: 'P', R: 'R', N: 'N', D: 'D', 1: 'P', 2: 'R', 3: 'N', 4: 'D' };
            put('stage', lookup(stages, v.statusActualStageDrive), { raw: v.statusActualStageDrive });
            put('gear', gear(v.statusActualGearDrive), { raw: v.statusActualGearDrive });
        }
        if (field === 'DataPowerTrain2') {
            const g = selection(v.statusGearSelectionDrive);
            put('stage', g.stage, { raw: v.statusGearSelectionDrive }); put('gear', g.gear, { raw: v.statusGearSelectionDrive });
        }
        if (field === 'VehicleCondition') {
            const raw = v.statusConditionVehicle, n = typeof raw === 'number' ? raw : CONDITION[raw];
            put('condition', [1, 2, 3, 5, 7, 8, 10, 12].indexOf(n) >= 0 ? n : null);
            this.vehicleInactive = n !== 7 && n !== 10;
            if (this.vehicleInactive) {
                // Provider availability can survive ignition off. The next drive must obtain new observations.
                this.invalidateDrive();
            }
        }
        if (field === 'statusRangeTankStatus') {
            put('fuelL', scale(v.fluidLevelFuelTank, 255, 1, 0));
            put('range', scale(v.range, 4095, 1, 0));
            put('odometer', scale(v.mileageKilometre, 16777215, 1, 0));
        }
        if (field === 'statusSwitchDriveDynamicSport2') put('boost', null, { quality: 'unverified',
            candidate: scale(v.displayBoostPressure, 255, 0.01, 0), reason: 'upstream marks boost scaling q:true; requires vehicle comparison' });
        if (field === 'statusActualValueTorque2') put('torque', scale(v.actualValueTorqueCrankshaft, 4095, 0.5, -1023.5));
        if (field === 'statusFESVehicleDynamicSwitchHMI') {
            const mode = driveModes.decode(v.actualValueModeDrivingExperience);
            put('driveMode', mode.name);
            put('driveProfile', mode.profile, { quality: mode.known ? 'derived' : 'invalid',
                reason: mode.name === 'ADAPTIVE' ? 'neutral palette; no separate Adaptive design' : undefined });
        }
        if (field === 'dataDisplayGearbox') {
            const program = { S_MINUS_PROGRAMM: 'S', M_MINUS_PROGRAMM: 'M', 1: 'S', 2: 'M' };
            put('gearboxProgram', lookup(program, v.displayProgramGearbox));
        }
        if (field === 'StabilizationManagement') put('dsc', null, { quality: 'unverified',
            raw: { qualifierFunctionFDR: v.qualifierFunctionFDR, qualifierFunctionASC: v.qualifierFunctionASC, qualifierFunctionABS: v.qualifierFunctionABS },
            reason: 'qualifier semantics are not decoded; no ON/OFF inference' });
        if (field === 'ExteriorTemperature') put('ambient', scale(v.temperatureExterior, 255, 0.5, -40));
        if (field === 'statusLongitudinalAccelerationMassCenter') put('gLong', scale(v.longitudinalAccelerationCentreOfGravity, 65535, 0.002 / 9.80665, -65 / 9.80665));
        if (field === 'statusLateralAccelerationMassCenter') put('gLat', scale(v.lateralAccelerationCentreOfGravity, 65535, 0.002 / 9.80665, -65 / 9.80665));
        if (field === 'statusBordcomputerAverage') {
            const rawUnit = v.statusUnitOfMeasurementConsumptionBC, unit = lookup(CONSUMPTION_UNITS, rawUnit);
            const candidate = scale(v.consumptionAverage1BC1, 65535, 0.1, 0);
            // The owner compared one metric BC sample with the stock G30 display.
            // This validates only that metric scale for this application: other
            // units and instantaneous consumption still have no confirmed scale.
            if (rawUnit === 1 || rawUnit === 'VERBRAUCH_IN_L_S_100KM') {
                put('avgConsumption', candidate, { inputUnit: 'l/100km', interval: 'stock onboard computer BC1',
                    confirmation: 'metric-scale-owner-G30-single-sample',
                    reason: candidate === null ? 'BC1 raw value is missing or outside 0..65534; not a zero consumption reading'
                        : 'metric BC1 raw x0.1 compared by owner with stock G30 display in one sample; average only, not current trip or instantaneous fuel flow' });
            } else put('avgConsumption', null, { quality: 'unverified', candidate: candidate, candidateUnit: unit,
                interval: 'stock onboard computer BC1', reason: 'only the explicit metric BC unit has an owner-compared scale; other or unknown units remain unverified' });
        }
        if (field === 'statusBordcomputerTravelData') {
            put('tripDistance', null, { quality: 'unverified', candidate: scale(v.wayPassed, 65535, 1, 0),
                reason: 'upstream marks wayPassed scaling q:true', interval: 'stock onboard computer travel data' });
            const h = v.rideDurationHours, m = v.rideDurationMinutes;
            put('tripMinutes', Number.isInteger(h) && h >= 0 && h < 65535 && Number.isInteger(m) && m >= 0 && m < 60 ? h * 60 + m : null,
                { raw: { rideDurationHours: h, rideDurationMinutes: m }, interval: 'stock onboard computer travel data' });
        }
        if (field === 'statusNewCurrentUnitsStatusExt') {
            const p = lookup(PRESSURE_UNITS, v.unitOfMeasurementAirPressure), t = lookup(TEMPERATURE_UNITS, v.unitOfMeasurementTemperature);
            if (p !== this.read('pressureUnit') || t !== this.read('temperatureUnit')) this.invalidateTyres();
            put('pressureUnit', p); put('temperatureUnit', t);
        }
        if (field === 'statusTyrePressure' || field === 'statusTyreTemperature') {
            const pressure = field === 'statusTyrePressure', unit = this.read(pressure ? 'pressureUnit' : 'temperatureUnit');
            CORNERS.forEach((c) => {
                const key = (pressure ? 'p' : 't') + c, raw = v[MEMBERS[key]];
                let value = scale(raw, pressure ? 65532 : 65535, pressure ? 0.1 : 1, pressure ? 0 : -40);
                if (value !== null && unit) {
                    value = pressure ? value * ({ BAR: 1, KPA: 0.01, PSI: 1 / 14.5038 }[unit]) : unit === 'F' ? (value - 32) * 5 / 9 : value;
                } else value = null;
                put(key, value, !unit ? { quality: 'unavailable', reason: 'vehicle display units unavailable; no unit guessing' } : { inputUnit: unit });
            });
        }
        this.emit();
    }
    reading(key) {
        if (key === 'selector') return this.reading('stage');
        if (key === 'actualGear') {
            const r = this.reading('gear');
            return Object.assign({}, r, { value: finite(r.value) && r.value > 0 ? r.value : null });
        }
        if (key === 'fuelPct') {
            // Diagnostic metadata only: Kombi publishes litres, not a percentage.
            // Never guess capacity or preserve an observation across provider epochs.
            const fuel = this.reading('fuelL'), cfg = this.config(), tank = cfg.retro && cfg.retro.tankLitres;
            const out = { value: null, unit: '%', source: fuel.source ? 'derived from ' + fuel.source + ' and config.retro.tankLitres' : null,
                quality: 'unavailable', receivedAt: fuel.receivedAt, raw: fuel.raw,
                formula: '100 * fuelL / configured tankLitres', confirmation: 'not-verified-on-this-car' };
            if (fuel.quality !== 'valid' || fuel.unit !== 'l' || !finite(fuel.value) || fuel.value < 0) {
                out.quality = fuel.quality === 'stale' || fuel.quality === 'invalid' ? fuel.quality : 'unavailable';
                out.reason = 'fuelL is not a current valid litre reading; ' + (fuel.reason || fuel.quality);
            } else if (tank === null || tank === undefined) out.reason = 'tankLitres is not confirmed; fuelL is available in litres';
            else if (!finite(tank) || tank < 1 || tank > 200) {
                out.quality = 'invalid'; out.reason = 'tankLitres is outside the validated configuration range';
            } else if (fuel.value > tank) {
                out.quality = 'invalid'; out.reason = 'fuelL exceeds configured tankLitres; capacity or source needs verification';
            } else {
                out.value = 100 * fuel.value / tank; out.quality = 'derived';
                out.reason = 'calculated from current litres and explicitly configured capacity; not a direct percent signal';
            }
            return out;
        }
        if (key === 'power') {
            const rpm = this.reading('rpm'), torque = this.reading('torque'), valid = finite(rpm.value) && finite(torque.value);
            return { value: valid ? Math.max(0, torque.value) * rpm.value / 9549 : null, unit: 'kW',
                source: 'derived from ' + torque.source + ' and ' + rpm.source, quality: valid ? 'derived' : 'unavailable',
                receivedAt: valid ? Math.min(rpm.receivedAt, torque.receivedAt) : null,
                formula: 'max(0, torqueNm) * rpm / 9549', reason: 'ECU signal estimate; not a dynamometer measurement', confirmation: 'not-verified-on-this-car' };
        }
        const v = this.values[key];
        if (!v) return { value: null, unit: UNITS[key] || '', source: null, quality: 'unavailable', receivedAt: null,
            reason: UNSUPPORTED[key] || 'no current observation', confirmation: 'not-verified-on-this-car' };
        const source = this.sources[v.source];
        const out = { value: v.value, unit: v.unit, source: v.origin, quality: v.quality, receivedAt: v.at, confirmation: 'not-verified-on-this-car' };
        ['raw', 'candidate', 'candidateUnit', 'inputUnit', 'interval', 'reason', 'active', 'confirmation'].forEach((k) => { if (v[k] !== undefined) out[k] = v[k]; });
        if (!source.available || source.epoch !== v.epoch) return Object.assign(out, { value: null, quality: 'unavailable', reason: 'source epoch ended' });
        const maxAge = key === 'speed' || key === 'rpm' ? this.config().safety.criticalMaxAgeMs : MAX_AGE[key];
        if (maxAge && this.now() - v.at > maxAge) return Object.assign(out, { value: null, quality: 'stale', reason: 'no fresh notification or successful getter' });
        return out;
    }
    read(key) { return this.reading(key).value; }
    // Read-only lifecycle identity, not a vehicle command or an engine-start event.
    // A constant token lets display activation survive start-stop in one active
    // session; provider loss/sleep requires a newly confirmed running state.
    engineEpochToken() {
        const condition = this.reading('condition');
        if (this.closed || !this.sources.condition.available || !this.sources.cds.available
            || condition.quality !== 'valid' || (condition.value !== 7 && condition.value !== 10)) return null;
        return this.sources.condition.epoch + ':' + this.sources.cds.epoch;
    }
    readings() {
        const out = {};
        Object.keys(UNITS).concat(Object.keys(UNSUPPORTED), Object.keys(this.values), ['driveMode', 'driveProfile', 'selector', 'actualGear', 'gearboxProgram', 'dsc', 'engineRunning']).forEach((key) => { out[key] = this.reading(key); });
        return out;
    }
    diagnostics() {
        const providers = {};
        Object.keys(this.sources).forEach((key) => { providers[key] = { interface: IF[key], available: this.sources[key].available, epoch: this.sources[key].epoch }; });
        return { providers: providers, readings: this.readings() };
    }
    data() {
        const out = { demo: false };
        Object.keys(this.values).forEach((k) => { out[k] = this.read(k); });
        Object.keys(UNSUPPORTED).concat(['driveMode', 'driveProfile', 'gearboxProgram', 'dsc', 'engineRunning', 'power', 'selector', 'actualGear', 'fuelPct']).forEach((k) => { out[k] = this.read(k); });
        return out;
    }
    reason() {
        const d = this.data();
        if (this.config().safety.requireVehicleCondition && d.condition !== 7 && d.condition !== 10) return 'waiting for active vehicle state';
        if (!finite(d.speed)) return 'speed unavailable';
        if (!(['P', 'R', 'N'].indexOf(d.stage) >= 0 || finite(d.gear) && d.gear > 0)) return 'gear unavailable or ambiguous';
        return null;
    }
    tick() {
        if (this.closed) return;
        const current = this.config(), cfg = current.safety;
        Object.keys(this.sources).forEach((key) => {
            const s = this.sources[key];
            if (s.sub && s.sub.available !== s.available) this.availability(key, !!s.sub.available);
            if (!current.enabled || (cfg.requireVehicleCondition && this.read('condition') !== 7 && this.read('condition') !== 10)) return;
            const slow = key === 'fuel' || key === 'tyres';
            const snapshot = s.needsSnapshot;
            if ((!snapshot && ['speed', 'cds', 'boost', 'accel', 'fuel', 'tyres'].indexOf(key) < 0) || !s.available || !s.sub || !s.sub.refresh || s.busy || (!snapshot && this.now() - s.refreshed < (slow ? 10000 : cfg.getterRefreshMs))) return;
            s.busy = true; s.refreshed = this.now();
            // Reads only; no diagnostic session, write, wake-up or provider-start request.
            const fields = snapshot ? FIELDS[key] : key === 'speed' ? ['statusCarSpeed2'] : key === 'cds' ? ['statusEngineSpeed2'] : key === 'boost' ? ['statusActualValueTorque2'] : FIELDS[key];
            s.needsSnapshot = false;
            Promise.resolve(s.sub.refresh(fields, cfg.criticalReadTimeoutMs)).catch(() => {}).then(() => { s.busy = false; });
        });
    }
    onSample(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
    emit() { const d = this.data(), t = this.now(); this.listeners.slice().forEach((fn) => { try { fn(d, t); } catch (e) { this.ctx.log.warn('source listener failed'); } }); }
    setRedline() {} // Required by the drawing engine; this source never synthesizes rpm.
    stop() {
        if (this.closed) return;
        this.closed = true; this.generation++;
        Object.keys(this.sources).forEach((key) => {
            const s = this.sources[key];
            if (s.sub && s.sub.shutdown) Promise.resolve(s.sub.shutdown()).catch(() => {});
            s.available = false;
        });
        this.values = {}; this.listeners = [];
    }
}
RetroSource.IF = IF;
module.exports = RetroSource;
