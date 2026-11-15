'use strict';
// Read only the selected master-catalog type definitions. Never load native
// modules, make a SOME/IP request, or copy the complete BMW catalog.
// Schema evidence: idrive7-apps 9f0f68afe8407e80c411d9be92519528c3f6f023,
// kit/tools/sigdoc.py (dataRef/extends/enum.items) and check_signals.py.
const fs = require('fs');
const CATALOG = '/etc/oap/someip/someip-interfaces.json';
// The app shares the MGU's memory. Refuse larger catalogs before allocating
// or parsing; this is an input bound, not a proven bound on V8 heap usage.
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 24 * 1024;
const MAX_STEPS = 2048, MAX_MEMBERS = 128, MAX_DEPTH = 12, MAX_ENUM_ITEMS = 128;
const SCOPES = Object.freeze([
    ['de.bmw.infotainment.KombiIF', 'statusRangeTankStatus'],
    ['de.bmw.infotainment.KombiIF', 'statusBordcomputerAverage'],
    ['de.bmw.infotainment.drivingexcitement.FES', 'statusSwitchDriveDynamicSport2'],
    ['de.bmw.chassis.VehicleStabilizationManagement', 'StabilizationManagement'],
    ['de.bmw.infotainment.vehicle.CDS2', 'statusInjectionVolume'],
    ['de.bmw.infotainment.resetlogic.ResetLogic', 'currentConsumption'],
    ['de.bmw.infotainment.resetlogic.ResetLogic', 'averageConsumption']
].map((x) => Object.freeze(x)));
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const map = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const privateName = (s) => /(?:^|[._:])vin|vehicleidentification|password|secret|token|credential|keychain|username|account|email/i.test(s);
const identifier = (s) => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]{0,159}$/.test(s) &&
    !/^[A-HJ-NPR-Z0-9]{17}$/.test(s) && !/^(?:__proto__|prototype|constructor)$/.test(s) && !privateName(s);
const numeric = (s) => /^(?:u?int(?:8|16|32|64)?|float(?:32|64)?|double|byte|boolean|bool)$/i.test(s || '');
const livePath = (s) => identifier(s) && !/serial|identif|(?:^|[._:])id(?:$|[._:]|[A-Z])|position|latitude|longitude|location|mileage|odometer|key/i.test(s);
function base(status, reason) {
    const r = { schemaVersion: 1, evidence: 'metadata-only', status: status, fields: [], incomplete: status !== 'available' };
    if (reason) r.reason = reason;
    return r;
}
function scan(db) {
    if (!map(db) || !map(db.interfaces) || !map(db.datatypes)) return base('invalid', 'Master catalog shape is unavailable.');
    const report = base('available');
    let steps = 0, members = 0, omitted = 0;
    function limit() { if (++steps > MAX_STEPS) throw new Error('limit'); }
    function emit(field, memberPath, ref, type, en, array) {
        limit();
        if (++members > MAX_MEMBERS) throw new Error('limit');
        const member = { path: memberPath, dataRef: identifier(ref) ? ref : null, type: identifier(type) ? type : null };
        if (en) member.enum = en;
        if (array) member.array = true;
        field.members.push(member);
        if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_OUTPUT_BYTES - 256) throw new Error('limit');
    }
    function walk(field, ref, memberPath, stack, array) {
        limit();
        if (!identifier(ref) || stack.length >= MAX_DEPTH || stack.indexOf(ref) >= 0) { omitted++; return; }
        const d = own(db.datatypes, ref) ? db.datatypes[ref] : null;
        if (!map(d)) {
            // Built-in scalar references are permitted, unknown references stay unknown.
            emit(field, memberPath, ref, numeric(ref) ? ref : null, null, array);
            if (!numeric(ref)) omitted++;
            return;
        }
        const next = stack.concat(ref), type = identifier(d.type) ? d.type : null;
        if (type === 'struct') {
            if (d.extends) walk(field, d.extends, memberPath, next, array);
            if (!Array.isArray(d.members)) { omitted++; return; }
            for (let i = 0; i < d.members.length; i++) {
                limit();
                const m = d.members[i];
                if (!map(m) || !identifier(m.name)) { omitted++; continue; }
                walk(field, m.dataRef, memberPath.concat(m.name), next, array);
            }
        } else if (type === 'typedef') {
            walk(field, d.dataRef || d.baseType, memberPath, next, array);
        } else if (type === 'array') {
            // Definitions may describe arrays; they never authorize collection of live arrays.
            walk(field, d.elementDataRef, memberPath, next, true);
        } else {
            let en = null;
            if (type === 'enum') {
                en = [];
                if (!map(d.items)) omitted++;
                else {
                    const names = Object.keys(d.items);
                    if (names.length > MAX_ENUM_ITEMS) throw new Error('limit');
                    names.forEach((name) => {
                        limit();
                        const value = d.items[name];
                        if (identifier(name) && typeof value === 'number' && Number.isSafeInteger(value)) en.push({ name: name, value: value });
                        else omitted++;
                    });
                }
            }
            emit(field, memberPath, ref, type, en, array);
        }
    }
    try {
        SCOPES.forEach((scope) => {
            const iface = own(db.interfaces, scope[0]) && db.interfaces[scope[0]];
            const f = map(iface) && map(iface.fields) && own(iface.fields, scope[1]) && iface.fields[scope[1]];
            const field = { interface: scope[0], field: scope[1], present: map(f), getter: false, notifier: false, members: [] };
            report.fields.push(field);
            if (!map(f)) return;
            field.getter = !!(map(f.getter) && f.getter.id);
            field.notifier = !!f.notifier;
            walk(field, f.dataRef, [], [], false);
        });
    } catch (e) {
        // No incomplete enum or partial field is evidence for a decoding table.
        return base('limited', 'Selected definitions exceeded inspection limits; no partial definitions retained.');
    }
    report.incomplete = omitted > 0 || report.fields.some((f) => !f.present);
    if (omitted) report.omitted = omitted;
    if (!report.fields.some((f) => f.present)) report.status = 'unavailable';
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_OUTPUT_BYTES) return base('limited', 'Selected definitions exceeded output limits.');
    return report;
}
function primitivePaths(report, iface, field) {
    if (!report || report.status !== 'available' || !Array.isArray(report.fields)) return [];
    const f = report.fields.filter((x) => x.interface === iface && x.field === field && x.present)[0];
    if (!f || !Array.isArray(f.members)) return [];
    return f.members.filter((m) => !m.array && Array.isArray(m.path) && m.path.length > 0 && m.path.every(livePath) &&
        (numeric(m.type) || (m.type === 'enum' && Array.isArray(m.enum) && m.enum.length > 0))).map((m) => m.path.slice());
}
function read(fileSystem) {
    // Dependency injection is for fixtures only; the production path is fixed.
    const io = fileSystem || fs;
    let fd;
    try {
        fd = io.openSync(CATALOG, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
        const stat = io.fstatSync(fd);
        if (!stat.isFile() || stat.size < 2) return base('invalid', 'Catalog is not a bounded regular JSON file.');
        if (stat.size > MAX_INPUT_BYTES) return base('limited', 'Catalog exceeds the 8 MiB in-app inspection limit; metadata unavailable.');
        const data = Buffer.alloc(stat.size + 1);
        let length = 0, n;
        while (length < data.length && (n = io.readSync(fd, data, length, data.length - length, null)) > 0) length += n;
        if (length > stat.size) return base('invalid', 'Catalog changed during inspection.');
        let db;
        try { db = JSON.parse(data.slice(0, length).toString('utf8')); }
        catch (e) { return base('invalid', 'Catalog is not valid JSON.'); }
        return scan(db);
    } catch (e) {
        return base(e && e.code === 'ENOENT' ? 'missing' : 'unavailable', 'Selected catalog definitions could not be read.');
    } finally { if (fd !== undefined) { try { io.closeSync(fd); } catch (e) { /* read-only cleanup */ } } }
}
module.exports = { read, scan, primitivePaths, SCOPES, CATALOG, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES };
