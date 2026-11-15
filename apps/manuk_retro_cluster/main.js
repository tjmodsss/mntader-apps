'use strict';
const mgu = require('./kit/mgu');
const ConfigStore = require('./config').ConfigStore;
const RetroRuntime = require('./retro_runtime').RetroRuntime;
const settingsUi = require('./settings_ui');
const Diagnostics = require('./diagnostics');

function background(ctx) {
    const specProfile = (ctx.spec.config || {}).retroProfile;
    const profile = specProfile === 'bench' && process.env.MANUK_BENCH === '1' && process.env.RETRO_PROFILE === 'bench' ? 'bench' : 'car';
    const store = new ConfigStore(ctx.dataDir, profile, ctx.log);
    const originalLog = ctx.log;
    const levels = { error: 0, warn: 1, info: 2, debug: 3 };
    const filtered = {};
    Object.keys(levels).forEach((key) => { filtered[key] = function () {
        if (levels[key] <= levels[store.current.logging.level] && originalLog[key]) originalLog[key].apply(originalLog, arguments);
    }; });
    const controller = new RetroRuntime(Object.assign({}, ctx, { log: filtered }), store, profile);
    ctx.retroProfile = profile;
    controller.diagnostics = new Diagnostics(Object.assign({}, ctx, { log: filtered }), { profile: profile, source: controller.source });
    ctx.retroController = controller;
    controller.start();
    process.once('exit', () => controller.stop());
    // SIGTERM is handled cooperatively; no BMW process is touched.
    process.once('SIGTERM', () => { controller.stop(); process.exit(0); });
    process.once('SIGINT', () => { controller.stop(); process.exit(0); });
    return controller;
}

mgu.run({
    background,
    start(ctx) {
        // The upstream Mac HU stub has no background hook. Car mgu.js calls it before RHMI.
        const controller = ctx.background || background(ctx);
        ctx.retroController = controller;
        if (!ctx.ui) return;
        if (ctx.retroSettingsUi) ctx.retroSettingsUi.stop();
        ctx.retroSettingsUi = settingsUi.attach(ctx, controller);
        // No ui.open(): only a manual entry-point action opens the settings page.
        return ctx.retroSettingsUi.ready;
    },
});
