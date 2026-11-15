'use strict';
const HudApp = require('./hud');
const ShiftScore = require('./shift_score');
const sensors = require('./sensors');
const RetroSource = require('./retro_source');
const dashboardLocale = require('./dashboard_locale');
const profileView = require('./profile_view');
const textRaster = require('./hud_text');
const themeModule = require('./hud_themes');
const tachometerShader = require('./retro_tachometer');
const displayUnits = require('./display_units');
const motion = require('./display_motion');
const finite = (v) => typeof v === 'number' && isFinite(v);
/** Original Retro renderer plus the explicitly requested application layout and tachometer. */
class RetroHud extends HudApp {
    constructor(ctx, source, store, profile) {
        const disposers = [];
        const settings = {
            get: (key) => store.settings.get(key), item: (key) => store.settings.item(key),
            onChange: (fn) => { const off = store.settings.onChange(fn); if (off) disposers.push(off); return off; },
        };
        const runtimeCtx = Object.assign({}, ctx, { settings, retroSource: source, retroStore: store, retroProfile: profile,
            spec: Object.assign({}, ctx.spec, { config: Object.assign({}, ctx.spec.config, {
                target: 'panel', waze: null, dme: null, tankLitres: store.current.retro.tankLitres,
                utcOffsetMinutes: store.current.timeZone.utcOffsetMinutes,
            }) }),
        });
        super(runtimeCtx);
        const loadLayout = this.layouts.load.bind(this.layouts);
        this.layouts.load = (name) => {
            const layout = profileView.layout(dashboardLocale.layout(loadLayout(name), store.current), store.current);
            if (profileView.enabled(store.current)) layout.widgets.forEach((w) => {
                if (w.id === 'speed') w.rate = 1; // The main tick paces this digit, not the shared 200 ms text throttle.
            });
            return layout;
        };
        this.motion = { speed: new motion.DisplayMotion(), rpm: new motion.DisplayMotion() };
        this.disposers = disposers;
        // The original coordination helper writes /dev/shm/bimmer-lab/cluster.json.
        // Our application neither impersonates Cluster Themes nor takes its claim.
        this.screen = { yielded: false, start() {}, stop() {}, beat() {}, release() {}, otherOn() { return false; } };
        this.vstate.stop();
        this.vstate = { hold() { return false; }, drop() { return false; }, text() { return 'managed by RetroSource'; }, stop() {} };
        // Keep the original count-in graphics and timing. V1 does not infer manual shifts or
        // learn/write a driver's reaction time from an unknown gearbox programme.
        const cueTick = this.cue.tick.bind(this.cue);
        this.cue.tick = (rpm, time, shift, redline, lead, gear, shown, seen) => cueTick(rpm, time, shift, redline, lead, gear, shown, seen, null);
        this.slotPicks = { retro80s: store.current.retro.slots };
        this.stopped = false;
    }
    _setupVehicleData() {
        const source = this.ctx.retroSource;
        this.sourceDisposers = [];
        this.car = {
            data: () => source.data(), setRedline() {},
            onSample: (fn) => { const off = source.onSample(fn); this.sourceDisposers.push(off); return off; },
        };
        this.gBuf = []; this.gSm = null; this.resetG();
        this.score = new ShiftScore(this.car, () => ({ redline: this.setting('redline'), shiftBefore: this.setting('shiftBefore'),
            coldGuard: this.setting('coldGuard'), mode: null }), this.log);
        // Never let a different installed app change our tach/shift setting through /dev/shm/redline.
        this.score.redline = () => null;
        this.demo = null;
    }
    _startDme() {} // No diagnostic requests, including the original implicit fuel poll.
    start() {
        if (this.started || this.stopped) return;
        super.start();
        if (profileView.enabled(this.ctx.retroStore.current)) {
            // Replace the existing timer; never add a parallel animation loop.
            clearInterval(this.tickTimer);
            this.tickTimer = setInterval(() => this._guard('tick', () => this._tick()), motion.FRAME_MS);
        }
    }
    _motionValue(name, now) {
        const source = this.ctx.retroSource, raw = source.read(name);
        if (!this.started || !profileView.enabled(this.ctx.retroStore.current)) return raw;
        const reading = source.reading ? source.reading(name) : null;
        const provider = source.sources && source.sources[name === 'speed' ? 'speed' : 'cds'];
        return this.motion[name].sample(raw, now, reading && reading.receivedAt, provider ? provider.epoch : 0);
    }
    _smoothRpm(now) {
        if (!profileView.enabled(this.ctx.retroStore.current)) return super._smoothRpm(now);
        this._motionValue('speed', now);
        this.rpmF = this._motionValue('rpm', now);
        this.rpmShown = finite(this.rpmF) ? Math.round(this.rpmF) : null;
    }
    _layoutName() { return 'retro80s'; }
    _chosenName() { return 'retro80s'; }
    _vehKeep() { return false; }
    _barMax(w) {
        // Display extent only: shift/redline/cold-guard settings stay independent.
        return profileView.enabled(this.ctx.retroStore.current) ? profileView.TACHOMETER.max : super._barMax(w);
    }
    _effectShader(w) {
        return profileView.enabled(this.ctx.retroStore.current) && w.type === 'shiftbar' && w.id === 'revs'
            ? tachometerShader : super._effectShader(w);
    }
    slotSensor(layout, id) {
        const config = this.ctx.retroStore.current;
        if (profileView.enabled(config)) return profileView.sensor(profileView.slot(config, this.visualState().profile, id), config);
        return dashboardLocale.sensor(sensors.get(config.retro.slots[id]), config);
    }
    _benchValues() { return this.ctx.retroProfile === 'bench' && this.ctx.retroBenchValues ? this.ctx.retroBenchValues() || {} : {}; }
    _value(name) {
        const b = this._benchValues();
        // Only the separately staged bench can supply these synthetic observations.
        // Speed/rpm/gear stay on the normal source path to exercise source quality.
        if (['speed', 'rpm', 'gear'].indexOf(name) < 0 && Object.prototype.hasOwnProperty.call(b, name)) return b[name];
        return this.ctx.retroSource.read(name);
    }
    visualState() {
        const cfg = this.ctx.retroStore.current, b = this._benchValues(), d = this.car.data();
        return { profile: profileView.choose(cfg, d.driveProfile, b.forceProfile), driveMode: d.driveMode || null,
            engineProfile: this._value('engineProfile'), gearboxProgram: this._value('gearboxProgram'),
            selector: this._value('selector') || d.stage || null, gear: d.gear, speed: d.speed, dsc: this._value('dsc') };
    }
    _mainMetric() { return profileView.main(this.visualState().profile, this.ctx.retroSource.read('speed')); }
    _metricValue(name) {
        if (name === 'fuel') return this._raw('fuel');
        if (name === 'consumption') {
            const speed = this.ctx.retroSource.read('speed');
            return finite(speed) && speed > 0 ? this._value(name) : null;
        }
        return this._value(name);
    }
    _metricText(name, width, font) {
        const s = profileView.format(name, this._metricValue(name), this.ctx.retroStore.current);
        return textRaster.measure(s, font || 'd7_val', 0) <= (width || 240) ? s : '--';
    }
    _metricUnit(name) {
        const cfg = this.ctx.retroStore.current;
        return profileView.sensor(name, cfg).unit(displayUnits.imperial(cfg, name));
    }
    _boost() { return this._value('boost'); }
    _warning(widget) {
        if (profileView.enabled(this.ctx.retroStore.current) && widget.id === 'boost') return this._overLimit('boost');
        return super._warning(widget);
    }
    _raw(name) {
        const cfg = this.ctx.retroStore.current, source = this.ctx.retroSource;
        if (name === 'speed' && profileView.enabled(cfg)) return this._motionValue('speed', Date.now());
        if (name === 'rpm' && !finite(source.read('rpm'))) { this.rpmF = null; this.rpmShown = null; return null; }
        const bench = this.ctx.retroProfile === 'bench' && this.ctx.retroBenchValues ? this.ctx.retroBenchValues() || {} : {};
        if (name === 'intake') return this._value('intake');
        if (name === 'profileConsumption') return this._metricValue(this._mainMetric());
        if (name === 'fuel') {
            if (finite(bench.fuelPct)) return Math.max(0, Math.min(100, bench.fuelPct)) / 100;
            const litres = source.read('fuelL'), tank = cfg.retro.tankLitres;
            // A bad capacity/source combination is not a full tank. Keep the
            // display consistent with the diagnostic fuelPct quality rules.
            return finite(litres) && finite(tank) && tank >= 1 && tank <= 200 && litres >= 0 && litres <= tank ? litres / tank : null;
        }
        if (name === 'range' || Object.prototype.hasOwnProperty.call(profileView.CATALOG, name) && ['rpm', 'speed', 'oil', 'coolant', 'fuel'].indexOf(name) < 0) return this._metricValue(name);
        return super._raw(name);
    }
    _token(name) {
        const cfg = this.ctx.retroStore.current;
        if (profileView.enabled(cfg)) {
            const state = this.visualState(), ru = cfg.language !== 'en';
            if (['speed', 'oil', 'coolant', 'boost'].indexOf(name) >= 0) return profileView.format(name, this._raw(name), cfg);
            if (name === 'u:speed') return displayUnits.imperial(cfg, 'speed') ? (ru ? 'МИЛЬ/Ч' : 'MPH') : (ru ? 'КМ/Ч' : 'KM/H');
            if (name === 'u:temp') return displayUnits.imperial(cfg, 'oil') ? '°F' : '°C';
            if (name === 'u:boost') return displayUnits.imperial(cfg, 'boost') ? 'PSI' : (ru ? 'БАР' : 'BAR');
            if (name === 'driveMode') return state.driveMode || (ru ? 'РЕЖИМ --' : 'MODE --');
            if (name === 'modeAndDsc') return this._token('driveMode') + ' / ' + this._token('dscState');
            if (name === 'engineState') return (ru ? 'ДВИГ.: ' : 'ENGINE: ') + (state.engineProfile || '--');
            if (name === 'systemStates') return this._token('engineState') + '   ' + this._token('dscState');
            if (name === 'gearboxState') return profileView.transmission(state).program;
            if (name === 'gearboxCaption') return (ru ? 'КПП: ' : 'GEARBOX: ') + profileView.gearboxLabel(state);
            if (name === 'gearnum') return profileView.transmission(state).gear;
            if (name === 'dscState') {
                if (state.dsc === 'DTC') return 'TRACTION';
                const labels = ru ? { ON: 'ON', OFF: 'OFF', INTERVENTION: 'ВМЕШАТ.', FAULT: 'ОШИБКА' }
                    : { ON: 'ON', OFF: 'OFF', INTERVENTION: 'ACTIVE', FAULT: 'FAULT' };
                return 'DSC ' + (labels[state.dsc] || '--');
            }
            if (name === 'profileAxis') return ru ? 'ОБОРОТЫ /1000' : 'RPM /1000';
            if (name === 'profileMain') return this._metricText(this._mainMetric(), 130, 'd7_sm');
            if (name === 'consumptionLabel') return profileView.sensor(this._mainMetric(), cfg).head;
            if (name === 'consumptionUnit') return this._metricUnit(this._mainMetric());
            if (name === 'rangeLabel') return profileView.sensor('range', cfg).head;
            if (name === 'rangeUnit') return this._metricUnit('range');
            if (name === 'rangeValue') return this._metricText('range', 160, 'd7_sm');
            if (name === 'boostGauge') return this._metricText('boost', 130, 'd7_sm');
            if (name === 'boostLabel') return profileView.sensor('boost', cfg).head;
            if (name === 'boostUnit') return this._metricUnit('boost');
            if (name === 'profileMainHead') { const s = profileView.sensor(this._mainMetric(), cfg); return s.head + ' ' + this._metricUnit(this._mainMetric()); }
            if (name === 'rangeHead') { const s = profileView.sensor('range', cfg); return s.head + ' ' + this._metricUnit('range'); }
            if (name.indexOf('metric:') === 0) return this._metricText(name.slice(7));
        }
        const translated = dashboardLocale.token(name, this.ctx.retroStore.current);
        if (translated !== undefined) return translated;
        if ((name === 'rpm' || name === 'rpm10') && !finite(this.ctx.retroSource.read('rpm'))) {
            this.rpmF = null; this.rpmShown = null;
            return name === 'rpm' ? '--' : '----';
        }
        if (name === 'gearnum') {
            const d = this.car.data();
            if (['P', 'R', 'N'].indexOf(d.stage) >= 0) return d.stage;
            return finite(d.gear) && d.gear > 0 ? String(d.gear) : '-';
        }
        return super._token(name);
    }
    _wireClientEvents(client, index) {
        super._wireClientEvents(client, index);
        client.on('disconnected', () => {
            // Do not replay stale cached image layers as the socket reconnects.
            this.releaseLayers();
        });
        client.on('ready', () => {
            if (!this.stopped && this.started && !this.widgets.size) this._rebuild();
        });
        client.on('refused', () => {
            this.failure = 'renderer refused a layer; disable and enable after checking the renderer';
            this.releaseLayers();
            this.clients.forEach((c) => c.close());
        });
    }
    _rebuild() {
        if (this.stopped || this.failure) return;
        this._resetMotion();
        super._rebuild();
        this.profileKey = null;
        this._syncProfile();
        if (this.pixelBytes > 16 * 1024 * 1024 || this._layerRefs().some((r) => this._layerRefs().filter((v) => v.ci === r.ci).length > 8)) {
            this.failure = 'layout exceeds conservative renderer budget';
            this.releaseLayers(); this.clients.forEach((c) => c.close());
        }
    }
    _tick() {
        // Keep the original shader/blink/image path; only presentation pacing changes.
        // Drag-timer tracking is not part of Retro and must not create runs.json.
        if (this.stopped || this.failure) return;
        this._syncProfile();
        const update = this.runs.update;
        this.runs.update = function () {};
        try { super._tick(); } finally { this.runs.update = update; }
    }
    _trip() {} // BC trip fields have explicit source/interval; no hidden integration from UI ticks.
    _syncProfile() {
        const cfg = this.ctx.retroStore.current;
        if (!profileView.enabled(cfg) || !this.theme || !this.widgets.size) return;
        const state = this.visualState(), key = state.profile + '|' + JSON.stringify(cfg.profiles.accents);
        if (key === this.profileKey) return;
        const initial = this.profileKey === null || this.profileKey === undefined;
        this.profileKey = key;
        this.theme = profileView.theme(themeModule.THEMES.retro, state.profile, cfg);
        // All adapted profiles share their gauge/text colours. Only the mode
        // accent changes: do not rasterise the DSEG digits, re-upload the RPM
        // scale or resend every effect uniform for an ordinary FES notification.
        // The first pass after rebuild still converts the original Retro palette.
        if (!initial) {
            this.widgets.forEach((x) => {
                if (x.w.id === 'drive_mode') this._update(x, Date.now(), false);
            });
            return;
        }
        this.widgets.forEach((x) => {
            const w = x.w, t = this.theme, rgb = (v) => v.slice(0, 3).map((n) => n / 255), rgba = (v) => v.map((n) => n / 255);
            const set = (name, value) => x.c.uniform(x.ref, name, value);
            if (w.type === 'shiftbar') {
                set('u_low', rgb(t.bar.low)); set('u_mid', rgb(t.bar.mid)); set('u_high', rgb(t.bar.high));
                set('u_track', rgba(t.track));
                set('u_midAt', [profileView.rpmFraction(profileView.TACHOMETER.yellowAt)]);
                set('u_highAt', [profileView.rpmFraction(profileView.TACHOMETER.redAt)]);
            } else if (w.type === 'meter') {
                const cs = w.colors;
                [1, 2, 3].forEach((i) => set('u_c' + i, rgb(themeModule.color(t, cs[i - 1]))));
                set('u_track', rgba(t.track));
            }
            x.last = null; x.lastPaint = 0;
            if (w.type === 'scale') this._paintScale(x);
            else this._update(x, Date.now(), true);
        });
    }
    _update(x, now, force) {
        if (profileView.enabled(this.ctx.retroStore.current)) {
            // Do not queue old animation frames behind a busy renderer. Its next
            // writable frame reads the current source and presentation target.
            if (!force && (x.w.id === 'speed' || x.w.id === 'revs') && x.c.blocked) return;
            if (x.w.id === 'drive_mode') {
                const w = x.w, warning = ['OFF', 'DTC', 'INTERVENTION', 'FAULT'].indexOf(this.visualState().dsc) >= 0;
                const parts = [
                    { text: this._token('driveMode'), color: this.theme.accent },
                    { text: ' / ', color: this.theme.fg },
                    { text: this._token('dscState'), color: warning ? this.theme.hot : this.theme.fg },
                ];
                const key = JSON.stringify(parts);
                if (!force && x.last === key) return;
                x.last = key; x.lastPaint = now;
                const width = parts.reduce((sum, p) => sum + textRaster.measure(p.text, w.font, 0), 0);
                let pen = Math.round((w.w - width) / 2);
                const out = Buffer.alloc(w.w * w.h * 4, 0);
                parts.forEach(p => {
                    const mask = textRaster.mask(w.w, w.h, p.text, { font: w.font, x: pen });
                    const painted = textRaster.tint(mask, w.w, w.h, { color: p.color, font: w.font });
                    for (let n = 0; n < mask.length; n++) if (mask[n]) painted.copy(out, n * 4, n * 4, n * 4 + 4);
                    pen += textRaster.measure(p.text, w.font, 0);
                });
                this._blitDiff(x, out);
                return;
            }
            if (x.w.id === 'consumption_bar') x.w.max = this.ctx.retroStore.current.profiles.gaugeMax[this._mainMetric()];
            if (x.w.id === 'revs') {
                // Keep initial and profile-change colour thresholds identical.
                if (force) {
                    x.c.uniform(x.ref, 'u_midAt', [profileView.rpmFraction(profileView.TACHOMETER.yellowAt)]);
                    x.c.uniform(x.ref, 'u_highAt', [profileView.rpmFraction(profileView.TACHOMETER.redAt)]);
                }
                const rpm = this.ctx.retroSource.read('rpm');
                const q = profileView.rpmFraction(this._motionValue('rpm', now), true);
                const source = this.ctx.retroSource;
                // Deliberately bypass _value()/bench overrides. The real source
                // currently reports unavailable until a passive mapping is proven.
                const cold = profileView.coldRpmRange(finite(rpm) && source.reading ? source.reading('coldRpmLimit') : null);
                // The red zone flashes the whole bar using this existing tick.
                // Red-zone/cold-band decisions use fresh raw data, never the
                // interpolated display value or a temperature/time heuristic.
                const flash = profileView.rpmFlash(rpm, now), key = q + ':' + flash + ':' + cold.join(',');
                if (force || x.last !== key) {
                    x.last = key; x.c.uniform(x.ref, 'u_value', [q]); x.c.uniform(x.ref, 'u_flash', [flash]);
                    x.c.uniform(x.ref, 'u_coldRange', cold);
                }
                return;
            }
        }
        return super._update(x, now, force);
    }
    _paintScale(x) {
        if (!profileView.enabled(this.ctx.retroStore.current)) return super._paintScale(x);
        const w = x.w, out = Buffer.alloc(w.w * w.h * 4, 0), t = this.theme.bar;
        for (let i = 0; i <= 8; i++) {
            const label = String(i), width = textRaster.measure(label, w.font, 0);
            const left = Math.round(Math.max(0, Math.min(w.w - width, i / 8 * w.w - width / 2)));
            const mask = textRaster.mask(w.w, w.h, label, { font: w.font, x: left });
            const rgb = i * 1000 >= profileView.TACHOMETER.redAt ? t.high
                : i * 1000 >= profileView.TACHOMETER.yellowAt ? t.mid : this.theme.dim.slice(0, 3);
            const painted = textRaster.tint(mask, w.w, w.h, { color: rgb.concat(255), font: w.font });
            for (let n = 0; n < mask.length; n++) if (mask[n]) painted.copy(out, n * 4, n * 4, n * 4 + 4);
        }
        this._blit(x, null, out);
    }
    releaseLayers() {
        this._resetMotion();
        if (!this.clients) return;
        this.clients.forEach((c) => {
            // Assets cannot be dropped while a sampled layer still refers to them.
            [false, true].forEach((assets) => Array.from(c.layers.keys()).forEach((ref) => {
                const layer = c.layers.get(ref);
                if (layer && (layer.kind === 'asset') === assets) c.drop(ref);
            }));
        });
        this.widgets.clear(); this.sheets = []; this.placed = []; this.pixelBytes = 0;
        this.atlases.clear();
        if (this.gEnvTex) this.gEnvTex.clear();
        this.layerStates.clear();
        this.stallTimers.forEach((t) => clearTimeout(t)); this.stallTimers.clear();
        clearTimeout(this.statusAskT); this.statusAskT = null;
    }
    _resetMotion() {
        if (this.motion) { this.motion.speed.clear(); this.motion.rpm.clear(); }
        this.rpmF = null; this.rpmShown = null;
    }
    statusText() {
        if (this.failure) return this.failure;
        if (this.stopped) return 'own rendering disabled; verify the stock display';
        return super.statusText();
    }
    stop() {
        if (this.stopped) return;
        this.stopped = true; this.started = false;
        this.releaseLayers();
        super.stop();
        clearTimeout(this._statusT);
        this.layouts.stop();
        this.sourceDisposers.forEach((fn) => fn());
        (this.disposers || []).forEach((fn) => fn());
        this.statusListeners = [];
    }
}

/** Owns one signal subscription set and at most one live HUD instance. */
class RetroRuntime {
    constructor(ctx, store, profile, deps) {
        this.ctx = ctx; this.store = store; this.profile = profile; this.deps = deps || {};
        this.Source = this.deps.Source || RetroSource; this.Hud = this.deps.Hud || RetroHud;
        this.source = new this.Source(ctx, () => store.current);
        this.listeners = []; this.hud = null; this.started = false; this.stopped = false;
        this.timer = null; this.currentStatus = 'not started'; this.configError = null;
        this.engineStarted = false; this.engineEpoch = null;
    }
    start() {
        if (this.started || this.stopped) return;
        this.started = true;
        this.offSource = this.source.onSample(() => this.evaluate());
        this.offConfig = this.store.onChange(() => {
            if (this.hud) this.hud.stop(); this.hud = null;
            this.configError = null;
            this.evaluate();
        });
        this.source.start();
        this.store.watch();
        this.timer = (this.deps.setInterval || setInterval)(() => {
            this.source.tick(); this.evaluate();
        }, 200);
        this.evaluate();
    }
    _clearEngineStart() { this.engineStarted = false; this.engineEpoch = null; }
    _engineStartReason(cfg) {
        if (!cfg.enabled || !cfg.startup || cfg.startup.onEngineStart !== true) {
            this._clearEngineStart();
            return null;
        }
        const token = this.source.engineEpochToken ? this.source.engineEpochToken() : null;
        const reading = this.source.reading ? this.source.reading('engineRunning') : null;
        if (typeof token !== 'string' || !token.length || !reading || reading.quality !== 'valid'
            || typeof reading.source !== 'string' || !reading.source.length
            || ['off', 'starting', 'running'].indexOf(reading.value) < 0) {
            this._clearEngineStart();
            return 'waiting for confirmed engine state';
        }
        if (token !== this.engineEpoch) {
            this.engineEpoch = token; this.engineStarted = false;
        }
        // The initial snapshot may already be running. This activates drawing
        // inside an existing process; it never launches an app or rewrites MGU policy.
        if (reading.value === 'running') this.engineStarted = true;
        return this.engineStarted ? null : 'waiting for engine start';
    }
    evaluate() {
        if (this.stopped) return;
        const cfg = this.store.current;
        const engineReason = this._engineStartReason(cfg);
        // The bench deliberately permits absent data, to inspect '--' rendering. It is not the car policy.
        const benchSafety = this.profile === 'bench' && this.ctx.retroBenchValues && (this.ctx.retroBenchValues() || {}).simulateCarSafety === true;
        const reason = !cfg.enabled ? 'disabled in configuration'
            : ((this.profile === 'car' || benchSafety) ? this.source.reason() : null) || engineReason;
        if (reason) {
            if (this.hud) { this.hud.stop(); this.hud = null; }
            return this.status(reason + '; own layers released');
        }
        if (!this.hud && !this.configError) {
            try {
                this.hud = new this.Hud(this.ctx, this.source, this.store, this.profile);
                this.hud.onStatus((s) => this.status(s));
                this.hud.start();
            } catch (e) {
                if (this.hud) this.hud.stop(); this.hud = null;
                this.configError = 'rendering could not start; inspect local logs and re-enable after correction';
                this.ctx.log.error(this.configError + ': ' + String(e && e.message || e));
            }
        }
        if (this.configError) this.status(this.configError);
        else if (this.hud) this.status(this.hud.statusText());
    }
    disable() {
        // Release first, even when storage is full. Persist for restart protection separately.
        this._clearEngineStart();
        if (this.hud) this.hud.stop(); this.hud = null;
        const next = JSON.parse(JSON.stringify(this.store.current)); next.enabled = false;
        try { this.store.save(next); }
        catch (e) { this.stop(); this.ctx.log.error('display stopped; could not persist disable, do not enable autostart'); throw e; }
        this.evaluate();
    }
    setEnabled(value) {
        if (this.stopped) throw new Error('Application is stopped');
        if (value !== true) return this.disable();
        const next = JSON.parse(JSON.stringify(this.store.current)); next.enabled = true;
        this.store.save(next);
        this.evaluate();
    }
    setEngineStart(value) {
        if (this.stopped) throw new Error('Application is stopped');
        if (typeof value !== 'boolean') throw new Error('Engine-start option must be a boolean');
        const next = JSON.parse(JSON.stringify(this.store.current)); next.startup.onEngineStart = value;
        this.store.save(next);
    }
    status(s) {
        if (s === this.currentStatus) return;
        this.currentStatus = s;
        this.ctx.log.info(s);
        this.listeners.slice().forEach((fn) => { try { fn(s); } catch (e) {} });
    }
    onStatus(fn) { this.listeners.push(fn); fn(this.currentStatus); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }
    stop() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.diagnostics) this.diagnostics.stop();
        this._clearEngineStart();
        (this.deps.clearInterval || clearInterval)(this.timer); this.timer = null;
        if (this.hud) this.hud.stop(); this.hud = null;
        if (this.offSource) this.offSource(); if (this.offConfig) this.offConfig();
        this.source.stop(); this.store.stop();
        this.status('stopped; own layers released, verify the stock display');
        this.listeners = [];
    }
}
module.exports = { RetroRuntime, RetroHud };
