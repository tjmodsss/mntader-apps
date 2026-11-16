'use strict';
const DSP = require('./kit/dsp-client');
// An in-app sheet keeps the Video Hub's existing stop-on-leave/focus rules.
// It changes the running PCM DSP without opening a second OAP app.
async function openEq(ctx) {
    let status = await DSP.request({ op: 'status' }), band = 0, focus = 0, busy = false, note = '';
    const names = ['Next band', 'Gain -0.5 dB', 'Gain +0.5 dB', 'DSP on / bypass', 'Done'];
    async function act(i) {
        if (busy) return;
        if (i === 0) { band = (band + 1) % status.config.bands.length; return; }
        if (i === 4) return 'close';
        busy = true;
        try {
            const config = JSON.parse(JSON.stringify(status.config));
            if (i === 3) config.enabled = !config.enabled;
            else config.bands[band].gainDb = Math.max(-12, Math.min(12, config.bands[band].gainDb + (i === 1 ? -0.5 : 0.5)));
            status = await DSP.request({ op: 'set', config, expectedRevision: status.revision });
            note = config.enabled ? 'PCM DSP active' : 'Bypass';
        } catch (e) {
            note = 'EQ: ' + String(e.message || e).slice(0, 80);
            try { status = await DSP.request({ op: 'status' }); } catch (_) {}
        } finally { busy = false; }
    }
    const sheet = {
        title: 'Audio DSP',
        draw(r, theme) {
            const t = theme || {}, S = t.sel || t.accent || '#7bc6ff', dim = t.dim || '#90a1b6', text = t.text || '#eef5ff';
            r.clear(t.bg || '#07111d');
            const bands = status.config.bands, b = bands[Math.min(band, bands.length - 1)];
            r.text('LIVE PCM EQUALIZER', 60, 100, 36, text, { font: 'bold', spacing: 1.5 });
            r.text('Band ' + (band + 1) + ' / ' + bands.length + '  |  ' + b.frequencyHz + ' Hz  |  Q ' + b.q.toFixed(1), 60, 167, 28, dim);
            r.text((b.gainDb > 0 ? '+' : '') + b.gainDb.toFixed(1) + ' dB', 60, 240, 54, S, { font: 'num' });
            r.text(status.config.enabled ? 'DSP on' : 'Bypass: PCM data passes through unchanged', 60, 299, 25, text);
            r.text('Only connected PCM apps. Stock CarPlay and radio are not routed through it.', 60, 350, 23, dim);
            r.text(busy ? 'Saving ...' : note, 60, 393, 23, t.warn || '#ffbd69');
            return names.map((label, i) => {
                const x = 48 + i * 307, y = 430, w = 290, h = 60, on = i === focus;
                r.roundRect(x, y, w, h, h / 2, on ? S : (t.track || '#182738'));
                r.text(label.toUpperCase(), x + w / 2, y + 38, 21, on ? (t.selText || (/^#(f|e)/i.test(S) ? '#05070a' : '#ffffff')) : text, { align: 'center', font: 'bold', spacing: 1 });
                return { x, y, w, h, act: () => { focus = i; return act(i); } };
            });
        },
        move(d) { focus = (focus + d + names.length * 10) % names.length; },
        press() { return act(focus); }, back() { return 'close'; },
    };
    if (!ctx.sheet(sheet)) throw new Error('The live EQ needs the GPU renderer. Set profiles in the Equalizer app instead.');
}
module.exports = { openEq };
