'use strict';
// Explicit, bounded passive observation. No renderer, diagnostic ECU requests,
// writes to vehicle interfaces, calibration, guessed units, or network export.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const metadata = require('./diagnostic_metadata');
const MAX_BYTES = 256 * 1024, MAX_SAMPLES = 121, DURATION_MS = 30000;
const IF = {
    fuel: 'de.bmw.infotainment.KombiIF', boost: 'de.bmw.infotainment.drivingexcitement.FES',
    dsc: 'de.bmw.chassis.VehicleStabilizationManagement', injection: 'de.bmw.infotainment.vehicle.CDS2',
    reset: 'de.bmw.infotainment.resetlogic.ResetLogic',
};
const SCOPES = [
    { id: 'tank', category: 'fuel', interface: IF.fuel, field: 'statusRangeTankStatus', members: ['fluidLevelFuelTank', 'range'] },
    { id: 'bc', category: 'consumption', interface: IF.fuel, field: 'statusBordcomputerAverage', members: ['consumptionAverage1BC1', 'consumptionAverage2BC2', 'statusUnitOfMeasurementConsumptionBC'] },
    { id: 'boost', category: 'boost', interface: IF.boost, field: 'statusSwitchDriveDynamicSport2', members: ['displayBoostPressure', 'displayMaximumValueBoostPressure'] },
    { id: 'dsc', category: 'dsc', interface: IF.dsc, field: 'StabilizationManagement', members: ['qualifierFunctionFDR', 'qualifierFunctionASC', 'qualifierFunctionABS'] },
    { id: 'injection', category: 'consumption', interface: IF.injection, field: 'statusInjectionVolume', members: ['injectionVolumeFuelEngine', 'oilTemperature'] },
    { id: 'current', category: 'consumption', interface: IF.reset, field: 'currentConsumption', dynamic: true },
    { id: 'average', category: 'consumption', interface: IF.reset, field: 'averageConsumption', dynamic: true },
];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const finite = (v) => typeof v === 'number' && isFinite(v);
const clone = (v) => JSON.parse(JSON.stringify(v));
const ascii = (v) => JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
const privateName = (s) => /vin|vehicleidentification|serial|identifier|(?:^|[._])id(?:[._]|$)|position|latitude|longitude|location|mileage|odometer|password|secret|token|credential|key|account|email|username/i.test(s);
function safeScalar(v) {
    if (v === null || typeof v === 'boolean') return v;
    if (finite(v)) return v;
    if (typeof v === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(v) && !/[A-HJ-NPR-Z0-9]{17}/.test(v)) return v;
    return undefined;
}
function valueAt(v, names) {
    let out = v;
    for (let i = 0; i < names.length; i++) {
        if (!out || typeof out !== 'object' || Array.isArray(out) || !own(out, names[i])) return undefined;
        out = out[names[i]];
    }
    return out;
}
function save(dir, report) {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('diagnostic data directory unavailable');
    const text = ascii(report) + '\n';
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('diagnostic report limit exceeded');
    const file = path.join(dir, 'diagnostics-last.json'), temp = path.join(dir, '.diagnostics-last-' + report.sessionId + '.tmp');
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, file);
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* cleanup */ } }
        try { fs.unlinkSync(temp); } catch (e) { /* renamed or not created */ }
    }
}
class Diagnostics {
    constructor(ctx, options) {
        this.ctx = ctx; this.options = options || {}; this.source = this.options.source;
        this.profile = this.options.profile === 'bench' ? 'bench' : 'car';
        // Injectable clocks are used only by isolated local tests, not by configuration.
        this.now = this.options.now || Date.now;
        this.setInterval = this.options.setInterval || setInterval;
        this.clearInterval = this.options.clearInterval || clearInterval;
        this.readMetadata = this.options.readMetadata || metadata.read;
        this.listeners = []; this.subs = []; this.generation = 0; this.stopped = false;
        this.state = { state: 'idle', simulation: this.profile === 'bench', elapsedSeconds: 0, report: null, summary: '', error: null };
    }
    snapshot() { return clone(this.state); }
    onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        this.listeners.push(fn);
        return () => { this.listeners = this.listeners.filter((f) => f !== fn); };
    }
    emit() { const s = this.snapshot(); this.listeners.slice().forEach((fn) => { try { fn(s); } catch (e) { /* UI cannot interrupt cleanup */ } }); }
    elapsed() { return Math.min(30, Math.max(0, Math.floor((this.now() - this.startedAt) / 1000))); }
    guard() {
        const s = this.source;
        if (!s || s.closed || typeof s.reading !== 'function' || !s.sources) return { ok: false, reason: 'vehicle-source-unavailable' };
        const keys = ['speed', 'gear', 'condition'], epochs = [];
        for (let i = 0; i < keys.length; i++) {
            const p = s.sources[keys[i]];
            if (!p || !p.available) return { ok: false, reason: 'guard-provider-unavailable' };
            epochs.push(p.epoch);
        }
        const epoch = epochs.join(':'), speed = s.reading('speed'), selector = s.reading('selector'), condition = s.reading('condition');
        if (condition.quality === 'valid' && condition.value !== 7 && condition.value !== 10) return { ok: false, unsafe: true, reason: 'vehicle-not-active' };
        if (condition.quality !== 'valid') return { ok: false, reason: 'vehicle-condition-unknown' };
        if (selector.quality === 'valid' && selector.value !== 'P') return { ok: false, unsafe: true, reason: 'selector-not-P' };
        if (selector.quality !== 'valid') return { ok: false, reason: 'selector-unknown' };
        if (speed.quality === 'valid' && finite(speed.value)) {
            if (speed.value !== 0) return { ok: false, unsafe: true, reason: 'vehicle-moving' };
            this.zero = { receivedAt: speed.receivedAt, epoch: epoch };
        } else if (!(this.zero && speed.quality === 'stale' && speed.receivedAt === this.zero.receivedAt && epoch === this.zero.epoch)) {
            return { ok: false, reason: 'speed-unknown' };
        }
        if (this.guardEpoch !== undefined && this.guardEpoch !== epoch) return { ok: false, reason: 'guard-epoch-ended' };
        return { ok: true, epoch: epoch };
    }
    start() {
        if (this.stopped || this.state.state === 'collecting') return this.snapshot();
        this.cleanup(); this.generation++; const generation = this.generation;
        this.startedAt = this.now(); this.zero = null; this.guardEpoch = undefined; this.measuring = false;
        let definitions;
        try { definitions = this.readMetadata(); } catch (e) { definitions = { status: 'unavailable', fields: [], incomplete: true }; }
        const version = this.ctx.spec && this.ctx.spec.version;
        this.report = { schemaVersion: 1, schema: 'm1cluster-diag-1', app: 'manuk_retro_cluster',
            appVersion: typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : 'unknown',
            sessionId: crypto.randomBytes(6).toString('hex'), environment: this.profile, simulation: this.profile === 'bench', readOnly: true, rawOnly: true,
            confirmation: this.profile === 'bench' ? 'SIMULATION-NOT-VEHICLE-DATA' : 'uninterpreted-observations-not-confirmed-values',
            state: 'collecting', elapsedSeconds: 0, reason: null, metadata: definitions,
            limitations: ['Native synchronous stalls cannot be interrupted by a JavaScript deadline.',
                'No fuel-counter scale, tank capacity, boost scale or DSC meaning is inferred.',
                'Unchanged zero speed is accepted only within the same observed provider epoch.'],
            sources: {}, samples: [], droppedSamples: 0, truncated: false };
        SCOPES.forEach((scope) => {
            const candidates = scope.dynamic ? metadata.primitivePaths(definitions, scope.interface, scope.field) : scope.members.map((m) => [m]);
            const paths = scope.dynamic ? candidates.filter((p) => !p.some(privateName) && p.length <= 8 && p.join('.').length <= 160).slice(0, 12) : candidates;
            const omittedPaths = candidates.length - paths.length;
            if (omittedPaths) this.report.truncated = true;
            this.report.sources[scope.id] = { interface: scope.interface, field: scope.field, category: scope.category,
                paths: paths, candidatePathCount: candidates.length, omittedPaths: omittedPaths, truncated: omittedPaths > 0, available: false, everAvailable: false, availabilityChanges: 0, observations: 0,
                rejectedValues: 0, stats: {}, latest: {}, reason: !paths.length ? 'no-safe-catalog-members' : 'not-observed' };
        });
        this.state = { state: 'collecting', simulation: this.profile === 'bench', elapsedSeconds: 0, report: null,
            summary: this.profile === 'bench' ? 'Имитация данных: ожидание неподвижного автомобиля и P.' : 'Ожидание неподвижного автомобиля и положения P.', error: null };
        this.timer = this.setInterval(() => this.tick(), 1000);
        if (this.source && typeof this.source.onSample === 'function') this.unlisten = this.source.onSample(() => this.checkGuard(generation));
        this.emit();
        this.checkGuard(generation);
        // A single explicit speed snapshot can establish the guard when drawing
        // is disabled. There is no new periodic getter, diagnostic poll or wake.
        if (this.state.state === 'collecting' && !this.measuring) {
            const p = this.source && this.source.sources && this.source.sources.speed;
            if (p && p.available && p.sub && typeof p.sub.refresh === 'function') {
                try { Promise.resolve(p.sub.refresh(['statusCarSpeed2'], 1500)).then(() => this.checkGuard(generation), () => this.checkGuard(generation)); }
                catch (e) { /* guard timeout gives an explicit refusal */ }
            }
        }
        return this.snapshot();
    }
    checkGuard(generation) {
        if (this.state.state !== 'collecting' || generation !== this.generation) return;
        const g = this.guard();
        if (g.ok) {
            if (!this.measuring) { this.guardEpoch = g.epoch; this.measuring = true; this.subscribe(generation); }
        } else if (this.measuring || g.unsafe) this.finish('cancelled', g.reason);
        else this.waitReason = g.reason;
    }
    subscribe(generation) {
        const grouped = {};
        SCOPES.forEach((scope) => {
            if (!this.report.sources[scope.id].paths.length) return;
            if (!grouped[scope.interface]) grouped[scope.interface] = {};
            grouped[scope.interface][scope.field] = (v) => this.receive(scope.id, v, generation);
        });
        if (!this.ctx.signals || typeof this.ctx.signals.watch !== 'function') { this.finish('error', 'signal-reader-unavailable'); return; }
        Object.keys(grouped).forEach((iface) => {
            const alive = () => this.state.state === 'collecting' && this.generation === generation;
            Promise.resolve().then(() => {
                if (!alive()) return null;
                return this.ctx.signals.watch(iface, '1', grouped[iface], this.ctx.log, { onAvailability: (available) => {
                    if (!alive()) return;
                    Object.keys(this.report.sources).forEach((id) => {
                        const s = this.report.sources[id]; if (s.interface !== iface) return;
                        if (s.available !== !!available) s.availabilityChanges++;
                        s.available = !!available; if (available) s.everAvailable = true;
                    });
                } });
            }).then((sub) => {
                if (!sub) return;
                if (!alive()) { this.shutdown(sub); return; }
                this.subs.push(sub);
                Object.keys(this.report.sources).forEach((id) => {
                    const s = this.report.sources[id]; if (s.interface !== iface) return;
                    if (sub.available) { s.available = true; s.everAvailable = true; }
                    if (sub.error) s.reason = 'subscription-unavailable';
                });
            }).catch(() => {
                if (!alive()) return;
                Object.keys(this.report.sources).forEach((id) => { const s = this.report.sources[id]; if (s.interface === iface) s.reason = 'subscription-failed'; });
            });
        });
    }
    receive(id, value, generation) {
        if (this.state.state !== 'collecting' || this.generation !== generation) return;
        if (this.now() - this.startedAt >= DURATION_MS) { this.finish('complete', 'duration-complete'); return; }
        this.checkGuard(generation); if (this.state.state !== 'collecting') return;
        const s = this.report.sources[id], elapsedMs = Math.max(0, this.now() - this.startedAt);
        s.observations++; s.everAvailable = true; s.available = true;
        const raw = {};
        s.paths.forEach((p) => {
            let v = safeScalar(valueAt(value, p));
            const name = p.join('.'), scope = SCOPES.filter((x) => x.id === id)[0];
            if (typeof v === 'string') {
                if (scope.dynamic) {
                    const f = (this.report.metadata.fields || []).filter((x) => x.interface === scope.interface && x.field === scope.field)[0];
                    const member = f && (f.members || []).filter((m) => m.path.join('.') === name)[0];
                    if (!member || !member.enum || !member.enum.some((e) => e.name === v)) v = undefined;
                } else if (id !== 'dsc' && name !== 'statusUnitOfMeasurementConsumptionBC') v = undefined;
            }
            if (v === undefined) { s.rejectedValues++; return; }
            raw[name] = v;
            if (!own(s.stats, name)) s.stats[name] = { first: v, latest: v, min: finite(v) ? v : null, max: finite(v) ? v : null, count: 1, firstMs: elapsedMs, latestMs: elapsedMs };
            else {
                const st = s.stats[name]; st.latest = v; st.latestMs = elapsedMs; st.count++;
                if (finite(v)) { st.min = st.min === null ? v : Math.min(st.min, v); st.max = st.max === null ? v : Math.max(st.max, v); }
            }
        });
        s.latest = raw; s.reason = Object.keys(raw).length ? 'raw-only-unverified' : 'no-safe-values-in-observation';
    }
    take() {
        if (!this.report) return;
        const latest = {};
        Object.keys(this.report.sources).forEach((id) => { const s = this.report.sources[id]; latest[id] = { available: s.available, raw: clone(s.latest) }; });
        this.report.samples.push({ elapsedMs: Math.max(0, this.now() - this.startedAt), sources: latest });
        // Reserve room for finish metadata. Drop middle samples, preserving the
        // first observation and newest snapshot; aggregate first/min/max remain.
        while (this.report.samples.length > MAX_SAMPLES || Buffer.byteLength(ascii(this.report), 'utf8') > MAX_BYTES - 2048) {
            if (!this.report.samples.length) break;
            this.report.samples.splice(this.report.samples.length > 2 ? 1 : 0, 1); this.report.droppedSamples++; this.report.truncated = true;
        }
    }
    tick() {
        if (this.state.state !== 'collecting') return;
        this.checkGuard(this.generation); if (this.state.state !== 'collecting') return;
        if (!this.measuring && this.now() - this.startedAt >= 3000) { this.finish('error', this.waitReason || 'parked-guard-unavailable'); return; }
        this.state.elapsedSeconds = this.elapsed();
        if (this.now() - this.startedAt >= DURATION_MS) { this.finish('complete', 'duration-complete'); return; }
        if (this.measuring) this.take();
        this.state.summary = (this.profile === 'bench' ? 'Имитация данных. ' : '') + (this.measuring ? 'Сбор сырых значений: ' + this.state.elapsedSeconds + ' / 30 с.' : 'Ожидание скорости 0, P и активного автомобиля.');
        this.emit();
    }
    shutdown(sub) { try { Promise.resolve(sub.shutdown && sub.shutdown()).catch(() => {}); } catch (e) { /* only this subscription */ } }
    cleanup() {
        if (this.timer !== undefined) { this.clearInterval(this.timer); this.timer = undefined; }
        if (this.unlisten) { this.unlisten(); this.unlisten = null; }
        this.subs.forEach((sub) => this.shutdown(sub)); this.subs = [];
    }
    finish(state, reason) {
        if (this.state.state !== 'collecting') return;
        this.state.state = state; this.generation++; this.cleanup(); this.take();
        this.report.state = state; this.report.reason = reason; this.report.elapsedSeconds = this.elapsed();
        this.state.elapsedSeconds = this.report.elapsedSeconds;
        try { save(this.ctx.dataDir, this.report); }
        catch (e) { this.state.error = 'report-save-failed'; this.report.saveError = 'report-save-failed'; }
        this.state.report = clone(this.report);
        this.state.summary = (this.profile === 'bench' ? 'Имитация данных. ' : '') + (state === 'complete' ? 'Сбор завершён. Сырые значения ещё не подтверждают показания.' : 'Сбор остановлен: ' + reason + '.');
        if (state === 'error') this.state.error = reason;
        this.emit();
    }
    cancel() { this.finish('cancelled', 'cancelled-by-user'); return this.snapshot(); }
    stop() { this.cancel(); this.stopped = true; this.cleanup(); this.listeners = []; }
}
module.exports = Diagnostics;
module.exports.SCOPES = SCOPES;
module.exports.MAX_BYTES = MAX_BYTES;
