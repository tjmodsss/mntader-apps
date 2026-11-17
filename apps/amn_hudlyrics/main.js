'use strict';
/**
 * HUD Lyrics (amn_hudlyrics): synced lyrics for the song the car plays (CarPlay), one line at a time in the
 * head-up display, and a Now Playing page on the centre screen.
 *
 * The centre screen: the song and its progress on the left, the lyrics on the right (the line sung large,
 * the one before and the one after dim), and a status row that says what each part is doing: the song,
 * the timing, the lyrics lookup and the HUD. If the HUD stays dark, that row says which part stopped.
 *
 * The HUD (Settings > Lyrics in the HUD, experimental, off by default): hud/music_cluster.js from G's Music,
 * target 'hud', through the Store's Cluster renderer. One line by default; hidden during route guidance
 * (BMW navigation, CarPlay, Android Auto) unless "Show during navigation" is on, while paused for 30 s, and
 * for a song without synced lyrics.
 *
 * Built from arefahmad's Car Lyrics (MIT): car/nowplaying.js, net/http.js and the song clock below.
 * stage/lyrics.js and hud/ are from nickgcode's G's Music (MIT). Fonts: Inter (OFL), data/fonts/.
 *
 * Read-only toward the car: it subscribes to and reads fields, never calls a method or writes a value.
 * One internet host: lrclib.net (net/http.js refuses any other). The log holds only the track's title,
 * artist and timing, the lyrics lookup's result and the HUD layer's state.
 *
 * Node 8 only (the car's version): no ?. ?? import, object spread, class fields, optional catch binding.
 * Nothing may throw out of a callback: every callback goes through guard().
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const fonts = require('./kit/fonts');
const pack = require('./kit/pack');
const { Canvas } = require('./kit/canvas');
const NP = require('./nowplaying');
const LyricsLib = require('./lyrics');
const http = require('./http');
const MC = require('./music_cluster');
// 0.4.0: Redline's HUD claim (kit/hud_claim.js): while Redline draws on the HUD (Sport), the lyrics step aside
const { HudClaim } = require('./kit/hud_claim');
// 0.5.0: in Sport, Redline's Ramp tach (after the G80/G82 M3 / M4) on the HUD in place of the lyrics (hud/sport.js)
const { SportHud } = require('./sport');

const VERSION = '0.6.0';
const W = 1600, H = 520;
const IFACES = [
    { iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', instances: ['CarPlayManagerInst1'] },
    { iface: 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer', instances: [] },
    { iface: 'de.bmw.infotainment.hmi.hmimediastate.HmiMediaState', instances: [] },
    { iface: 'de.bmw.infotainment.entertainment.dynamicmediaplayer.DynamicMediaPlayer', instances: [] },
];
// route guidance, as G's Music reads it (CarPlay's comes through nowplaying.js, which already watches CarPlayManager)
const GUIDE = [
    ['de.bmw.infotainment.navigation.navigationstatus.NavigationStatus', '1', 'guidingState', 'nav'],
    ['de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', 'AndroidAutoProjectedManagerInst1', 'projectedGuidanceActive', 'aa'],
];
const LEAD_MS = 250;              // a line shows this much before its time (reading takes a moment)
const NUDGE = 0.3;                // share of the gap to a new time from the car that the clock takes at once
const SNAP_MS = 1500;             // a gap bigger than this (a seek, a skip back) is jumped, not glided
const HOLD_MS = 4000;             // the clock runs at most this far past the car's last time
const FADE_MS = 280;              // the centre screen's line change
const CLAIM_MS = 1000;            // how often the HUD claims are read (Redline touches its claim every 2 s)

/* ---------- the look: Apple-style dark glass, one accent ---------- */
const C = {
    top: '#0d121b', bottom: '#040508', glow: '#2a6df4',
    text: '#ffffff', dim: '#8e8e93', faint: '#5a5d66',
    accent: '#64d2ff',                 // the HUD's light
    green: '#30d158', amber: '#ff9f0a', red: '#ff453a', grey: '#636366',
};
const A = (c, a) => { const s = String(c).replace('#', '').slice(0, 6); return '#' + s + ('0' + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16)).slice(-2); };
const mix = (a, b, f) => {
    const p = (c) => [0, 2, 4].map((k) => parseInt(String(c).replace('#', '').slice(k, k + 2), 16));
    const x = p(a), y = p(b);
    return '#' + x.map((v, i) => ('0' + Math.round(v + (y[i] - v) * f).toString(16)).slice(-2)).join('');
};
const easeOut = (e) => 1 - Math.pow(1 - Math.max(0, Math.min(1, e)), 3);
const mmss = (ms) => { const s2 = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s2 / 60) + ':' + (s2 % 60 < 10 ? '0' : '') + (s2 % 60); };

/** Cut s to fit width w at size (an ellipsis when cut). */
function fit(cv, s, size, w, opt) {
    s = LyricsLib.fold(String(s || ''));
    const o = Object.assign({ literal: true }, opt || {});
    if (cv.textWidth(s, size, o) <= w) return s;
    let lo = 0, hi = s.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cv.textWidth(s.slice(0, mid) + '...', size, o) <= w) lo = mid; else hi = mid - 1; }
    return s.slice(0, lo).replace(/\s+$/, '') + '...';
}
/** Word-wrap s to at most max lines of w px (the last cut). */
function wrap(cv, s, size, w, max, opt) {
    const o = Object.assign({ literal: true }, opt || {});
    const words = LyricsLib.fold(String(s || '')).split(/\s+/).filter(Boolean), out = [];
    let cur = '';
    words.forEach((word) => {
        const next = cur ? cur + ' ' + word : word;
        if (!cur || cv.textWidth(next, size, o) <= w) cur = next; else { out.push(cur); cur = word; }
    });
    if (cur) out.push(cur);
    if (out.length > max) { const rest = out.slice(max - 1).join(' '); out.length = max - 1; out.push(fit(cv, rest, size, w, opt)); }
    return out;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const guard = (name, fn) => function () {
            try { return fn.apply(this, arguments); } catch (e) { log.error('error in ' + name + ': ' + (e && e.stack || e)); return undefined; }
        };
        try {
            const net = http.client(ctx.dataDir);
            const request = (m, h, p, hd) => net.request(m, h, p, hd);
            const lyrics = new LyricsLib.Lyrics(request, log, 'HUDLyrics/' + VERSION + ' (iDrive 7 head-unit app)');
            const np = new NP.NowPlaying(ctx.signals, log, IFACES);
            // Inter (OFL), the open look-alike of Apple's SF Pro, baked in data/fonts (as Car Lyrics)
            let F_BOLD = 'bold', F_MED = 'label';
            try {
                const dirs = [path.join(__dirname, 'fonts'), path.join(__dirname, 'data', 'fonts')];
                const src = pack.open(fs.existsSync(dirs[0] + '.pack') || fs.existsSync(dirs[0]) ? dirs[0] : dirs[1]);
                if (fonts.register('cl_bold', src.json('cl_bold.json'))) F_BOLD = 'cl_bold';
                if (fonts.register('cl_med', src.json('cl_med.json'))) F_MED = 'cl_med';
            } catch (e) { log.warn('fonts: ' + e.message); }
            const B = { font: F_BOLD, literal: true }, M = { font: F_MED, literal: true };
            let toast = null;
            const say = (text, ms) => { toast = { text: text, until: Date.now() + (ms || 3000) }; };

            /* ---------- the track, and the clock that follows the car's time in it (Car Lyrics') ---------- */
            let cur = null;           // { key, title, artist, album, duration, playing }
            let clk = null;           // { pos, at, playing, last }: the song's time pos (ms) at at (ms epoch)
            let startAt = Date.now(); // a source with no time of its own: when the song (probably) began
            let lastState = '';
            const clockAt = (now) => clk.pos + (clk.playing ? Math.min(now - clk.at, HOLD_MS) : 0);
            const follow = () => {
                const t = np.track();
                if (!t) return;
                const key = t.title + '|' + t.artist;
                if (!cur || cur.key !== key) {
                    cur = { key: key, title: t.title, artist: t.artist, album: t.album, duration: t.duration || 0, playing: true };
                    clk = null; startAt = Date.now(); lastState = '';
                    log.info('track: "' + t.title + '" by "' + t.artist + '" (' + Math.round((t.duration || 0) / 1000) + ' s)');
                }
                if (t.duration) cur.duration = t.duration;
                if (t.album) cur.album = t.album;
                const playing = t.direct ? !!t.playing : true;
                cur.playing = playing;
                if (t.position === null || t.position === undefined) return;
                const at = t.positionAt || Date.now();
                if (!clk) { clk = { pos: t.position, at: at, playing: playing, last: t.position }; log.info('time: from the car'); return; }
                if (t.position === clk.last && playing === clk.playing) return;
                const predicted = clockAt(at), gap = t.position - predicted;
                if (!playing || !clk.playing || Math.abs(gap) > SNAP_MS) clk.pos = t.position;
                else clk.pos = predicted + gap * NUDGE;
                clk.at = at; clk.playing = playing; clk.last = t.position;
            };
            const offset = () => Number(settings.get('offset')) || 0;
            const position = (now) => (clk ? clockAt(now || Date.now()) : (now || Date.now()) - startAt) + offset();
            ui.onClick('BTN_SYNC', guard('sync', () => { startAt = Date.now(); say('Synced: the song starts now'); log.info('time: synced by button'); }));
            const lyricsFor = () => (cur ? lyrics.get({ title: cur.title, artist: cur.artist, album: cur.album, duration: cur.duration }) : null);

            /* ---------- the HUD (G's Music's layer, target 'hud') ---------- */
            const mh = new MC.MusicCluster({ log: log, app: 'amn_hudlyrics', Canvas: Canvas, target: 'hud' });
            const sport = new SportHud({ ctx: ctx, app: 'amn_hudlyrics', settings: settings });
            ui.onClick('BTN_SPORT', guard('sport test', () => { sport.demo(8000); say('Sport HUD: an 8 s rev sweep on the HUD'); log.info('sport hud: test sweep'); }));
            const guide = { nav: null, carplay: null, aa: null };      // the latest raw value of each source
            const pushGuide = () => {
                const show = !!settings.get('navShow');
                Object.keys(guide).forEach((src) => {
                    if (guide[src] === null) return;
                    // "Show during navigation": tell the layer no route runs (0 = INACTIVE for BMW's, false for the phones')
                    mh.guidance(src, show ? (src === 'nav' ? 0 : false) : guide[src]);
                });
            };
            // 0.4.0: Redline holds the HUD (its claim, /dev/shm/mgu-hud/redline) while it draws: in Sport by default, its
            // "In Comfort / Eco Pro" set to Don't show. The lyrics then leave the HUD to it and come back when it lets go.
            let yieldTo = [], claimAt = 0;
            const yielding = () => {
                const now = Date.now();
                if (now - claimAt >= CLAIM_MS) {
                    claimAt = now;
                    const o = settings.get('redline') === false ? [] : HudClaim.others('amn_hudlyrics');
                    if (o.join() !== yieldTo.join()) log.info('hud: ' + (o.length ? 'giving way to ' + o.join(', ') : 'back (no other app on the HUD)'));
                    yieldTo = o;
                }
                return yieldTo.length > 0;
            };
            const hudTick = () => {
                const t = cur ? { uri: cur.key, title: cur.title, artist: cur.artist, kind: 'track', duration: cur.duration, ad: false } : null;
                // Sport: the Ramp tach has the HUD, the lyrics step aside (another app holding the HUD outranks both)
                const other = yielding(), tach = !other && sport.tick();
                if (other) sport.close();
                mh.update({ setting: settings.get('hud') && !other && !tach ? 'lyrics' : 'off', ok: !!cur, track: t, playing: !!(cur && cur.playing),
                    pos: position(), posFn: () => position(), lyrics: settings.get('hud') ? lyricsFor() : null,
                    size: settings.get('size'), lines: ({ '2': 2, '3': 3 })[settings.get('lines')] || 1 });
            };
            np.onChange(guard('change', (key) => {
                if (/^CarPlayManager\//.test(key) && /\.projectedGuidanceActive$/.test(key)) {
                    const e = np.store.get(key);
                    guide.carplay = e ? e.value : null;
                    pushGuide();
                    return;
                }
                follow();
            }));
            if (ctx.signals && ctx.signals.watch) GUIDE.forEach((g) => {
                const h = {};
                h[g[2]] = guard('guidance', (v) => { guide[g[3]] = v; pushGuide(); });
                ctx.signals.watch(g[0], g[1], h, log).catch(() => {});
            });
            setInterval(guard('hud', hudTick), 250);
            settings.onChange(guard('settings', (k) => {
                if (k === 'navShow') pushGuide();
                if (k === 'hud') { log.info('hud: ' + (settings.get('hud') ? 'on' : 'off')); say(settings.get('hud') ? 'Lyrics in the HUD: on (experimental)' : 'Lyrics in the HUD: off'); }
                hudTick();
            }));
            process.once('exit', () => { try { mh.close(); } catch (e) { /* closing */ } try { sport.close(); } catch (e) { /* closing */ } });

            /* ---------- the centre screen ---------- */
            let shown = { i: -2, at: 0, prev: -1 };      // the lyric line on screen, and when it changed
            const PAL = { on: C.green, wait: C.amber, off: C.grey, none: C.red, error: C.red };

            function backdrop(cv) {
                cv.gradientRect(0, 0, W, H, [[0, C.top], [1, C.bottom]]);
                for (let r = 420; r > 20; r -= 20) cv.circle(1180, -60, r, A(C.glow, 0.012));
                for (let r = 300; r > 20; r -= 20) cv.circle(180, H + 40, r, A(C.accent, 0.008));
            }
            /** A rounded glass panel. */
            function glass(cv, x, y, w, h, r) {
                cv.roundRect(x, y, w, h, r, A('#ffffff', 0.055));
                cv.strokeRoundRect(x, y, w, h, r, 1, A('#ffffff', 0.09));
            }
            /** The left card: what plays, and how far into it. */
            function songCard(cv, now) {
                const x = 48, y = 36, w = 520, h = 372, ix = x + 36, iw = w - 72;
                glass(cv, x, y, w, h, 28);
                cv.text('NOW PLAYING', ix, y + 52, 14, C.accent, Object.assign({ spacing: 2.2 }, B));
                if (!cur) {
                    cv.text('Nothing playing', ix, y + 128, 34, C.text, B);
                    wrap(cv, 'Play a song on your phone over CarPlay. Its lyrics show here, and in the head-up display when it is on.', 20, iw, 4, M)
                        .forEach((r, k) => cv.text(r, ix, y + 172 + k * 28, 20, C.dim, M));
                    return;
                }
                let size = 34;
                while (size > 26 && cv.textWidth(LyricsLib.fold(cur.title), size, B) > iw) size -= 2;
                const tl = wrap(cv, cur.title, size, iw, 2, B);
                tl.forEach((r, k) => cv.text(r, ix, y + 120 + k * (size + 6), size, C.text, B));
                const ay = y + 120 + tl.length * (size + 6) + 6;
                cv.text(fit(cv, cur.artist || 'Unknown artist', 22, iw, M), ix, ay, 22, C.dim, M);
                if (cur.album) cv.text(fit(cv, cur.album, 17, iw, M), ix, ay + 28, 17, C.faint, M);
                // progress
                const py = y + h - 78, pos = Math.max(0, position(now) - offset()), dur = cur.duration || 0;
                cv.roundRect(ix, py, iw, 6, 3, A('#ffffff', 0.14));
                if (dur) cv.roundRect(ix, py, Math.max(6, Math.min(1, pos / dur) * iw), 6, 3, A('#ffffff', 0.9));
                cv.text(mmss(pos), ix, py + 32, 16, C.dim, M);
                if (dur) cv.text('-' + mmss(dur - pos), ix + iw, py + 32, 16, C.dim, Object.assign({ align: 'right' }, M));
                if (!cur.playing) cv.text('PAUSED', ix + iw / 2, py + 32, 14, C.amber, Object.assign({ align: 'center', spacing: 2 }, B));
            }
            /** The lyrics: the line before (faint), the line sung (large, white), the line after (dim). */
            function lyricsPane(cv, now, lyr) {
                const x = 628, w = W - 48 - x, top = 36, bottom = 408, mid = 222;
                if (!cur) { message(cv, x, mid, 'Lyrics appear here', 'Synced from LRCLIB as the song plays.'); return; }
                if (!lyr || lyr.state !== 'synced' || !lyr.lines.length) {
                    const st = lyr ? lyr.state : 'loading';
                    const T = {
                        loading: ['Finding the lyrics...', ''],
                        plain: ['Lyrics without timing', 'LRCLIB has words for this song but no timing, so they cannot follow the music.'],
                        instrumental: ['Instrumental', 'Nothing to sing along to.'],
                        none: ['No lyrics for this song', 'LRCLIB has no lyrics for this title and artist yet.'],
                        undrawable: ['Lyrics in letters this app cannot draw yet', ''],
                        error: ['Cannot reach the lyrics', net.online() ? 'Trying again in a moment.' : 'The car is offline: turn on the phone hotspot, or Wi-Fi in the Store\'s settings.'],
                    }[st] || [st, ''];
                    message(cv, x, mid, T[0], T[1]);
                    return;
                }
                const lines = lyr.lines, p = position(now) + LEAD_MS, i = LyricsLib.lineAt(lines, p);
                if (i !== shown.i) shown = { i: i, at: now, prev: shown.i };
                const f = easeOut((now - shown.at) / FADE_MS);
                const textOf = (j) => (j >= 0 && j < lines.length ? lines[j].text : null);
                let n = i + 1;
                while (n < lines.length && !lines[n].text) n++;
                cv.clip(x - 8, top, w + 16, bottom - top);
                // the line before
                const before = textOf(i - 1);
                if (before) cv.text(fit(cv, before, 26, w, M), x, mid - 74 + (1 - f) * 20, 26, A(C.text, 0.22 + 0.2 * (1 - f)), M);
                // the line sung: up to two rows, rising into place as it lights up
                const now0 = textOf(i);
                if (now0) {
                    let size = 46;
                    let rows = wrap(cv, now0, size, w, 2, B);
                    if (rows.length > 1) { size = 40; rows = wrap(cv, now0, size, w, 2, B); }
                    const y0 = mid + 14 - (rows.length - 1) * (size + 8) / 2 + (1 - f) * 26;
                    rows.forEach((r, k) => cv.text(r, x, y0 + k * (size + 8), size, A(C.text, 0.4 + 0.6 * f), B));
                } else {
                    // before the first line, or an instrumental gap: three dots that fill as the next line comes
                    const t0 = i >= 0 ? lines[i].t : 0, t1 = n < lines.length ? lines[n].t : t0 + 4000, g = Math.max(0, Math.min(1, (p - t0) / Math.max(1, t1 - t0)));
                    for (let k = 0; k < 3; k++) { const fk = Math.max(0, Math.min(1, g * 3 - k)); cv.circle(x + 14 + k * 38, mid, 10 + fk * 2, A(C.text, 0.3 + 0.7 * fk)); }
                }
                // the line after
                if (n < lines.length) cv.text(fit(cv, lines[n].text, 28, w, M), x, mid + 108 + (1 - f) * 16, 28, A(C.text, 0.42 * f + 0.2), M);
                cv.noclip();
            }
            function message(cv, x, y, a, b) {
                const w = W - 48 - x;
                cv.text(fit(cv, a, 36, w, B), x, y, 36, C.text, B);
                if (b) wrap(cv, b, 21, w, 2, M).forEach((r, k) => cv.text(r, x, y + 42 + k * 28, 21, C.dim, M));
            }
            /** The status row: each part with a coloured dot. */
            function statusRow(cv, lyr) {
                const y = 428, h = 64, gap = 14, x0 = 48, w = (W - 96 - 3 * gap) / 4;
                const hv = mh.view();
                if (hv.kind === 'off') hv.text = 'Off  ·  turn on in Settings';
                if (settings.get('hud') && yieldTo.length) { hv.kind = 'wait'; hv.text = (yieldTo.indexOf('redline') >= 0 ? 'Redline' : yieldTo[0]) + ' has the HUD (Sport)'; }
                const sv = sport.view();
                if (!yieldTo.length && (sport.wants() || (sv.kind === 'error' && settings.get('sportHud') !== false))) { hv.kind = sv.kind; hv.text = 'Sport  ·  ' + sv.text; }
                const lyrS = !cur ? ['grey', 'Waiting for a song'] : !lyr ? ['amber', 'Searching'] : ({
                    synced: ['green', 'Synced  ·  ' + (lyr.lines ? lyr.lines.length : 0) + ' lines'], loading: ['amber', 'Searching LRCLIB'],
                    plain: ['amber', 'Not synced'], instrumental: ['grey', 'Instrumental'], none: ['grey', 'Not on LRCLIB'],
                    undrawable: ['grey', 'Letters not supported'], error: ['red', net.online() ? 'LRCLIB not answering' : 'Car offline'],
                })[lyr.state] || ['grey', lyr.state];
                const items = [
                    ['SONG', cur ? (cur.playing ? 'green' : 'amber') : 'grey', cur ? (cur.playing ? 'Playing' : 'Paused') : 'Nothing playing'],
                    ['TIMING', clk ? 'green' : cur ? 'amber' : 'grey', clk ? 'From the car' : cur ? 'Tap Song just started' : '-'],
                    ['LYRICS', lyrS[0], lyrS[1]],
                    ['HUD  ·  EXPERIMENTAL', ({ on: 'green', wait: 'amber', off: 'grey', none: 'red', error: 'red' })[hv.kind] || 'grey', hv.text],
                ];
                items.forEach((it, k) => {
                    const x = x0 + k * (w + gap);
                    glass(cv, x, y, w, h, h / 2);
                    cv.circle(x + 30, y + h / 2, 7, C[it[1]]);
                    cv.circle(x + 30, y + h / 2, 12, A(C[it[1]], 0.18));
                    cv.text(it[0], x + 52, y + 26, 12, C.dim, Object.assign({ spacing: 1.6 }, B));
                    cv.text(fit(cv, it[2], 19, w - 70, M), x + 52, y + 50, 19, C.text, M);
                });
            }

            ctx.loop('MAIN', 4, guard('draw', async () => {
                const now = Date.now(), cv = ctx.canvas(W, H);
                if (!cur) follow();
                const lyr = lyricsFor();
                if (lyr && lyr.state !== lastState) { lastState = lyr.state; log.info('lyrics: ' + lyr.state); }
                backdrop(cv);
                songCard(cv, now);
                lyricsPane(cv, now, lyr);
                statusRow(cv, lyr);
                // 0.5.1: the Sport HUD's whole status (the renderer's words) across the top while it should show
                // 0.5.3: the Sport HUD's whole status (the renderer's words) as a panel over the lyrics while the tach should
                // show - 0.5.1's line at the top sat under the HMI's title bar in the car
                if (sport.wants()) {
                    const sv2 = sport.view(), px = 600, py = 36, pw = W - 48 - px, ph = 372, col = sv2.kind === 'on' ? C.green : sv2.kind === 'error' ? C.red : C.amber;
                    cv.roundRect(px, py, pw, ph, 28, '#0b0f17');
                    cv.strokeRoundRect(px, py, pw, ph, 28, 1, A(col, 0.5));
                    cv.text('SPORT HUD  ·  RAMP', px + 36, py + 52, 14, col, Object.assign({ spacing: 2.2 }, B));
                    wrap(cv, sv2.text, 26, pw - 72, 6, M).forEach((r, k) => cv.text(r, px + 36, py + 110 + k * 36, 26, C.text, M));
                    // 0.6.0: the readouts as the tach has them (the car's values: a missing one is not sent by the car)
                    cv.text(fit(cv, sport.readings(), 20, pw - 72, M), px + 36, py + ph - 64, 20, C.accent, M);
                    cv.text('Lyrics on the HUD again outside Sport.', px + 36, py + ph - 28, 17, C.dim, M);
                }
                if (toast && now < toast.until) {
                    const s = fit(cv, toast.text, 18, 700, M), tw = cv.textWidth(s, 18, M) + 48;
                    cv.roundRect(W - 48 - tw, 360, tw, 40, 20, '#000000cc');
                    cv.strokeRoundRect(W - 48 - tw, 360, tw, 40, 20, 1, A('#ffffff', 0.2));
                    cv.text(s, W - 48 - tw / 2, 386, 18, C.text, Object.assign({ align: 'center' }, M));
                }
                await ui.image('MAIN_GFX', cv);
            }));

            np.start().then(() => log.info('subscribed: ' + JSON.stringify(np.status())), (e) => log.error('nowplaying start: ' + (e && e.stack || e)));
            log.info('started ' + VERSION + ', fonts ' + F_BOLD + '/' + F_MED + ', HUD ' + (settings.get('hud') ? 'on' : 'off'));
        } catch (e) {
            log.error('start: ' + (e && e.stack || e));
        }
    },
});
