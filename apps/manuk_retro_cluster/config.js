'use strict';
// MIT, Retro Cluster. Node 8 compatible. User state lives in data/, never in source/.
const fs = require('fs');
const path = require('path');
const pack = fs.existsSync(path.join(__dirname, 'kit')) ? require('./kit/pack') : require('../../kit/runtime/pack');
const data = pack.open(path.join(__dirname, 'config'));
const schema = data.json('schema.json');
const clone = (v) => JSON.parse(JSON.stringify(v));
function defaults(profile) {
    if (profile !== 'car' && profile !== 'bench') throw new Error('Unknown profile');
    return clone(data.json('defaults-' + profile + '.json'));
}
function check(value, rule, name, errors) {
    if (rule.anyOf) {
        if (!rule.anyOf.some((r) => { const e = []; check(value, r, name, e); return !e.length; })) errors.push(name + ': invalid value');
        return;
    }
    if (rule.enum && !rule.enum.some((v) => v === value)) errors.push(name + ': unsupported value');
    if (rule.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(name + ': expected object'); return; }
        (rule.required || []).forEach((k) => { if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(name + '.' + k + ': required'); });
        Object.keys(value).forEach((k) => {
            if (!Object.prototype.hasOwnProperty.call(rule.properties, k)) errors.push(name + '.' + k + ': unknown key');
            else check(value[k], rule.properties[k], name + '.' + k, errors);
        });
    } else if (rule.type === 'string') {
        if (typeof value !== 'string' || rule.pattern && !(new RegExp(rule.pattern)).test(value)) errors.push(name + ': invalid string');
    } else if (rule.type === 'null') { if (value !== null) errors.push(name + ': expected null'); }
    else if (rule.type === 'boolean') { if (typeof value !== 'boolean') errors.push(name + ': expected boolean'); }
    else if (rule.type === 'number' || rule.type === 'integer') {
        if (typeof value !== 'number' || !isFinite(value) || (rule.type === 'integer' && Math.floor(value) !== value)) errors.push(name + ': expected ' + rule.type);
        else if (value < rule.minimum || value > rule.maximum) errors.push(name + ': outside allowed range');
    }
}
function validate(value) {
    value = migrate(value);
    const errors = [];
    check(value, schema, 'config', errors);
    if (!errors.length && value.safety.criticalMaxAgeMs <= value.safety.criticalReadTimeoutMs + value.safety.getterRefreshMs) errors.push('criticalMaxAgeMs must exceed read timeout plus refresh interval');
    if (errors.length) throw new Error(errors.join('; '));
    return clone(value);
}
function migrate(value) {
    const next = clone(value);
    if (next && next.schemaVersion === 1) {
        // Add only the new section; never reset enabled, units, tank or old Retro choices.
        if (!Object.prototype.hasOwnProperty.call(next, 'profiles')) {
            next.profiles = defaults('car').profiles;
            // Build the actual legacy shape before applying the subsequent migrations.
            next.profiles.ecoMaxConsumption = next.profiles.gaugeMax.consumption;
            delete next.profiles.gaugeMax;
        }
        next.schemaVersion = 2;
    }
    if (next && next.schemaVersion === 2) {
        // Right-hand readouts are now fixed by the owner's request.
        if (next.profiles && typeof next.profiles === 'object') delete next.profiles.slots;
        next.schemaVersion = 3;
    }
    if (next && next.schemaVersion === 3) {
        // The owner also removed the auxiliary block beside the clock.
        if (next.profiles && typeof next.profiles === 'object') delete next.profiles.aux;
        next.schemaVersion = 4;
    }
    if (next && next.schemaVersion === 4) {
        if (next.profiles && typeof next.profiles === 'object' && !Array.isArray(next.profiles)) {
            // Never turn an ambiguous or malformed old file into apparently valid settings.
            if (Object.prototype.hasOwnProperty.call(next.profiles, 'gaugeMax')) throw new Error('config.profiles.gaugeMax: unknown key in schema version 4');
            const maxima = defaults('car').profiles.gaugeMax;
            next.profiles.gaugeMax = {
                consumption: next.profiles.ecoMaxConsumption,
                range: maxima.range,
                fuelFlow: maxima.fuelFlow,
            };
            delete next.profiles.ecoMaxConsumption;
        }
        next.schemaVersion = 5;
    }
    if (next && next.schemaVersion === 5) {
        if (Object.prototype.hasOwnProperty.call(next, 'widgets')) throw new Error('config.widgets: unknown key in schema version 5');
        next.widgets = { selected: 'dashboard' };
        next.schemaVersion = 6;
    }
    if (next && next.schemaVersion === 6) {
        if (Object.prototype.hasOwnProperty.call(next, 'displayUnits')) throw new Error('config.displayUnits: unknown key in schema version 6');
        if (next.startup && typeof next.startup === 'object' && !Array.isArray(next.startup)) {
            if (Object.prototype.hasOwnProperty.call(next.startup, 'onEngineStart')) throw new Error('config.startup.onEngineStart: unknown key in schema version 6');
            next.startup.onEngineStart = false;
        }
        delete next.widgets;
        const us = next.units === 'us';
        next.displayUnits = { speed: us ? 'mph' : 'kmh', temperature: us ? 'f' : 'c',
            pressure: us ? 'psi' : 'bar', consumption: us ? 'mpg' : 'l100km' };
        next.schemaVersion = 7;
    }
    return next;
}
function writeAtomic(file, value) {
    value = validate(value);
    const tmp = file + '.tmp-' + process.pid;
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        fs.renameSync(tmp, file);
        // Best effort directory fsync (not supported by every target filesystem).
        try { const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); } } catch (e) {}
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(tmp); } catch (e) {}
    }
}
function toSettings(c) {
    return Object.assign({}, c.retro, {
        hudLayout: c.enabled ? 'retro80s' : 'off', units: c.units, clock: c.clock, language: c.language || 'ru',
        timeZone: c.timeZone.utcOffsetMinutes, theme: 'retro', byMode: false,
        demo: 'off', badge: 'none', badgeBMW: false, mapInTheme: false,
        smartTemps: false, cameraNotch: false, holiday: 'off',
        inComfort: 'retro80s', inSport: 'retro80s', inEco: 'retro80s'
    });
}
class ConfigStore {
    constructor(dataDir, profile, log) {
        this.profile = profile || 'car'; this.log = log || { error: () => {}, warn: () => {} };
        this.file = path.join(dataDir, 'manuk_retro_cluster.json');
        this.listeners = []; this.settingListeners = []; this.current = defaults(this.profile);
        this.watching = false; this.lastError = null;
        this.settings = {
            get: (key) => toSettings(this.current)[key],
            item: (key) => {
                const value = toSettings(this.current)[key];
                return value === undefined ? null : { key, default: value, type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'choice' };
            },
            onChange: (fn) => { this.settingListeners.push(fn); return () => { this.settingListeners = this.settingListeners.filter((f) => f !== fn); }; }
        };
        this.load();
    }
    _accept(next) {
        const old = toSettings(this.current), changed = JSON.stringify(next) !== JSON.stringify(this.current);
        this.current = next;
        if (!changed) return;
        this.listeners.slice().forEach((fn) => { try { fn(this.current); } catch (e) { this.log.error('config listener failed'); } });
        const now = toSettings(this.current);
        Object.keys(now).forEach((k) => { if (JSON.stringify(now[k]) !== JSON.stringify(old[k])) this.settingListeners.slice().forEach((fn) => { try { fn(k, now[k]); } catch (e) { this.log.error('settings listener failed'); } }); });
    }
    load() {
        try {
            if (!fs.existsSync(this.file)) {
                // First installation only; never overwrite an invalid user file.
                const next = defaults(this.profile); writeAtomic(this.file, next); this._accept(next);
            } else {
                const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')), valid = validate(raw);
                if (raw.schemaVersion >= 1 && raw.schemaVersion <= 6) writeAtomic(this.file, valid);
                this._accept(valid);
            }
            this.lastError = null;
        } catch (e) {
            const safe = defaults(this.profile); safe.enabled = false;
            this._accept(safe);
            if (this.lastError !== e.message) this.log.error('Configuration rejected; display disabled: ' + e.message);
            this.lastError = e.message;
        }
        return this.current;
    }
    save(next) { const valid = validate(next); writeAtomic(this.file, valid); this.lastError = null; this._accept(valid); return valid; }
    onChange(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
    watch() {
        if (this.watching) return;
        this.watching = true;
        this.watchHandler = () => this.load();
        fs.watchFile(this.file, { interval: 500, persistent: false }, this.watchHandler);
    }
    stop() { if (this.watching) fs.unwatchFile(this.file, this.watchHandler); this.watching = false; this.listeners = []; this.settingListeners = []; }
}
module.exports = { ConfigStore, defaults, validate, writeAtomic, toSettings, schema };
