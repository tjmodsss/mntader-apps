'use strict';

// Everything Video Hub draws. Pure drawing from a view model: main.js decides,
// this file only paints (and registers the touch / controller targets it is
// handed). The kit's header carries the page tabs (G.frame), the colours come
// from the theme chosen in the app's settings.
const qrcode = require('./qr_vendor');

const W = 1600, H = 520;
const TABS = ['Library', 'YouTube', 'Player', 'Connection'];
const PAGE = {LIBRARY:0, YOUTUBE:1, PLAYER:2, CONNECTION:3, LOGS:4};
const TOP = 58, FOOT_Y = 452, FOOT_H = 52, EDGE = 24;
const LIST_COLS = 2, LIST_ROWS = 4, PAGE_SIZE = LIST_COLS * LIST_ROWS;
// 16:9, as the decoder delivers it: the renderer fills the rectangle it is given.
const VIDEO = {x:EDGE, y:TOP, w:784, h:441};

const FOLD = {'ä':'ae', 'ö':'oe', 'ü':'ue', 'Ä':'Ae', 'Ö':'Oe', 'Ü':'Ue', 'ß':'ss',
    '‘':"'", '’':"'", '“':'"', '”':'"', '„':'"', '–':'-', '—':'-', '…':'...'};
/** The baked fonts hold ASCII: fold umlauts and accents instead of printing '?'. */
function ascii(value) {
    let s = String(value === undefined || value === null ? '' : value).replace(/[ÄÖÜäöüß–-„…]/g, c => FOLD[c] || c);
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return s.replace(/[^\x20-\x7e\u00b0\u00b1\u00b7\u00d7\u20ac]/g, '?').replace(/\s+/g, ' ').trim();
}
function clock(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
    const two = n => String(n).padStart(2, '0');
    return (h ? h + ':' + two(m) : String(m)) + ':' + two(s % 60);
}
function megabytes(bytes) {
    const mb = (Number(bytes) || 0) / 1048576;
    return mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : mb >= 100 ? Math.round(mb) + ' MB' : mb.toFixed(1) + ' MB';
}

function makeUi(G, colors) {
    const withAlpha = colors.withAlpha, rgba = colors.rgba;
    const LIT = {literal:true};
    /** Readable text colour on a filled shape of colour c. */
    function inkOn(c) {
        const v = rgba(c);
        return (v[0] * 299 + v[1] * 587 + v[2] * 114) / 1000 > 150 ? '#05070a' : '#ffffff';
    }
    function fit(cv, value, size, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        let s = ascii(value);
        if (cv.textWidth(s, size, o) <= width) return s;
        while (s.length > 1 && cv.textWidth(s + '...', size, o) > width) s = s.slice(0, -1);
        return s.trim() + '...';
    }
    /** Text cut to width; returns nothing. opts as cv.text. */
    function label(cv, value, x, y, size, color, width, opts) {
        const o = Object.assign({}, opts || {}, LIT);
        cv.text(width ? fit(cv, value, size, width, opts) : ascii(value), x, y, size, color, o);
    }
    /** Up to `lines` lines of wrapped text; returns the y after the last one. */
    function paragraph(cv, value, x, y, size, color, width, lines, opts) {
        const words = ascii(value).split(' '), o = Object.assign({}, opts || {}, LIT), out = [];
        let line = '';
        words.forEach(word => {
            const next = line ? line + ' ' + word : word;
            if (cv.textWidth(next, size, o) <= width || !line) line = next;
            else { out.push(line); line = word; }
        });
        if (line) out.push(line);
        out.slice(0, lines).forEach((s, i) => {
            const last = i === lines - 1 && out.length > lines;
            cv.text(last ? fit(cv, s + ' ...', size, width, opts) : fit(cv, s, size, width, opts), x, y + i * size * 1.3, size, color, o);
        });
        return y + Math.min(lines, out.length) * size * 1.3;
    }
    /**
     * A button on the page in the kit's style (G.button is only drawn where the kit runs the
     * screen; these controls have no bar button to fall back on, so they are always drawn).
     * opts: { primary, color, off }.
     */
    function button(cv, t, x, y, w, h, text, run, key, opts) {
        const o = opts || {}, S = o.color || t.sel || t.accent;
        if (o.primary && !o.off) cv.roundRect(x, y, w, h, h / 2, withAlpha(S, 0.92));
        else {
            cv.roundRect(x, y, w, h, h / 2, withAlpha('#ffffff', o.off ? 0.03 : 0.07));
            cv.strokeRoundRect(x, y, w, h, h / 2, 1.5, withAlpha(o.color || '#ffffff', o.off ? 0.12 : o.color ? 0.75 : 0.3));
        }
        cv.text(String(text).toUpperCase(), x + w / 2, y + h / 2 + h * 0.14, Math.min(22, h * 0.4),
            o.off ? withAlpha(t.dim, 0.6) : o.primary ? inkOn(S) : o.color || t.text, {align:'center', font:'bold', spacing:1.5});
        if (!o.off && run) cv.target(x, y, w, h, run, key, h / 2);
    }
    function card(cv, x, y, w, h, alpha) { cv.roundRect(x, y, w, h, 10, withAlpha('#b4bccc', alpha === undefined ? 0.07 : alpha)); }
    function playGlyph(cv, cx, cy, r, c) {
        cv.quad([[cx - r * 0.7, cy - r], [cx + r, cy], [cx + r, cy], [cx - r * 0.7, cy + r]], c);
    }
    function qr(cv, t, link, x, y, size, lockedText) {
        let code = null;
        if (link) try { code = qrcode(0, 'M'); code.addData(link); code.make(); } catch (_) { code = null; }
        if (!code) {
            cv.roundRect(x, y, size, size, 12, withAlpha('#000000', 0.45));
            cv.strokeRoundRect(x, y, size, size, 12, 1.5, withAlpha(t.warn, 0.5));
            cv.text('QR LOCKED', x + size / 2, y + size / 2 - 4, 24, t.warn, {align:'center', font:'bold', spacing:1.5});
            paragraph(cv, lockedText || '', x + 24, y + size / 2 + 30, 17, t.dim, size - 48, 3);
            return;
        }
        const n = code.getModuleCount(), quiet = 3, cell = Math.floor(size / (n + quiet * 2)), span = cell * (n + quiet * 2);
        const ox = x + Math.floor((size - span) / 2), oy = y + Math.floor((size - span) / 2);
        cv.roundRect(x, y, size, size, 12, '#ffffff');
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
            if (code.isDark(r, c)) cv.fillRect(ox + (c + quiet) * cell, oy + (r + quiet) * cell, cell, cell, '#05070a');
    }

    /* ---------------- footer: a message or a hint on the left, buttons on the right ---------------- */
    function footer(cv, t, m, hint, buttons) {
        // Laid out from the right edge, drawn left to right: that is the order the controller's knob walks them.
        const shown = (buttons || []).filter(Boolean);
        const left = W - EDGE - shown.reduce((sum, b) => sum + b.w, 0) - 12 * Math.max(0, shown.length - 1);
        let x = left;
        shown.forEach(b => { button(cv, t, x, FOOT_Y, b.w, FOOT_H, b.text, b.run, b.key, b); x += b.w + 12; });
        const room = (shown.length ? left - 12 : W - EDGE) - EDGE;
        if (m.notice) {
            const c = m.notice.level === 'error' ? t.crit : m.notice.level === 'warn' ? t.warn : t.ok || t.accent;
            cv.roundRect(EDGE, FOOT_Y, room, FOOT_H, 10, withAlpha(c, 0.16));
            cv.fillRect(EDGE, FOOT_Y + 8, 4, FOOT_H - 16, c);
            label(cv, m.notice.text, EDGE + 20, FOOT_Y + 33, 21, t.text, room - 36);
        } else if (hint) label(cv, hint, EDGE + 4, FOOT_Y + 33, 19, t.dim, room - 8);
    }

    /* ---------------- Library / YouTube ---------------- */
    function drawList(cv, t, m, a) {
        const youtube = m.page === PAGE.YOUTUBE, list = m.list;
        if (!list.total) {
            card(cv, EDGE, TOP, W - 2 * EDGE, FOOT_Y - TOP - 14);
            cv.text(youtube ? 'No YouTube links yet' : 'No videos found', W / 2, 200, 34, t.text, {align:'center', font:'bold'});
            cv.text(youtube ? 'Scan the QR code on the Connection page and send a link from the phone.' :
                'Plug in a USB drive with MP4, MKV, MOV, WEBM or AVI files, or upload a video from the phone.',
                W / 2, 250, 22, t.dim, {align:'center'});
            button(cv, t, W / 2 - 170, 296, 340, 58, 'Open Connection', () => a.open(PAGE.CONNECTION), 'EMPTY_CONNECT', {primary:true});
        }
        const colW = (W - 2 * EDGE - 16) / LIST_COLS, rowH = 88, gap = 10;
        list.items.forEach((item, k) => {
            const col = k % LIST_COLS, row = Math.floor(k / LIST_COLS);
            const x = EDGE + col * (colW + 16), y = TOP + row * (rowH + gap), current = item.id === m.currentId;
            card(cv, x, y, colW, rowH, current ? 0.13 : 0.07);
            if (current) cv.fillRect(x, y + 12, 4, rowH - 24, t.sel || t.accent);
            const tag = youtube ? 'YT' : item.source === 'USB' ? 'USB' : 'FILE';
            cv.roundRect(x + 16, y + 16, 76, 56, 8, withAlpha(t.accent2 || t.accent, 0.14));
            cv.text(tag, x + 54, y + 52, 21, t.accent2 || t.accent, {align:'center', font:'bold', spacing:1});
            label(cv, item.title, x + 110, y + 39, 24, t.text, colW - 190);
            label(cv, item.detail, x + 110, y + 68, 18, t.dim, colW - 190);
            cv.circle(x + colW - 44, y + rowH / 2, 22, withAlpha('#ffffff', 0.08));
            playGlyph(cv, x + colW - 44, y + rowH / 2, 9, current ? t.sel || t.accent : t.text);
            cv.target(x, y, colW, rowH, () => a.play(item), 'ITEM_' + (list.start + k), 10);
        });
        const paged = list.pages > 1;
        const count = list.total + (youtube ? list.total === 1 ? ' link' : ' links' : list.total === 1 ? ' video' : ' videos') +
            (paged ? '  ·  page ' + (list.page + 1) + ' of ' + list.pages : '');
        footer(cv, t, m, !m.allowed ? m.lockHint : list.total ? count + '  ·  select a video to play it' : '', [
            paged && {text:'Previous', w:190, key:'PREV', run:() => a.turn(-1), off:list.page === 0},
            paged && {text:'Next', w:150, key:'NEXT', run:() => a.turn(1), off:list.page >= list.pages - 1},
            !youtube && {text:'Rescan', w:170, key:'RESCAN', run:a.rescan},
        ]);
    }

    /* ---------------- Player ---------------- */
    function drawPlayer(cv, t, m, a) {
        const p = m.player, v = VIDEO;
        cv.roundRect(v.x, v.y, v.w, v.h, 10, '#000000');
        if (p.picture) a.video(cv, v.x, v.y, v.w, v.h, 10);
        else {
            cv.text(ascii(p.status).toUpperCase(), v.x + v.w / 2, v.y + v.h / 2 - 2, 26, p.error ? t.warn : t.dim, {align:'center', font:'bold', spacing:1.5});
            if (p.busy) cv.text('This can take a few seconds.', v.x + v.w / 2, v.y + v.h / 2 + 34, 19, t.dim, {align:'center'});
        }
        const x = v.x + v.w + 20, w = W - EDGE - x;
        G.panel(cv, t, x, TOP, w, v.h, '');
        const ix = x + 26, iw = w - 52;
        cv.text(p.kind === 'youtube' ? 'YOUTUBE' : p.kind === 'USB' ? 'USB MEDIA' : 'LIBRARY', ix, TOP + 40, 17, t.dim, {font:'bold', spacing:2});
        const stateColor = p.error ? t.warn : p.playing && !p.paused ? t.ok || t.accent : t.dim;
        cv.text(ascii(p.status).toUpperCase(), ix + iw, TOP + 40, 17, stateColor, {align:'right', font:'bold', spacing:1.5});
        paragraph(cv, p.title || 'No video selected', ix, TOP + 84, 28, t.text, iw, 2, {font:'bold'});
        // time and progress
        const ty = TOP + 196;
        cv.text(clock(p.position), ix, ty, 44, t.text, {font:'num'});
        if (p.duration) cv.text(clock(p.duration), ix + iw, ty, 26, t.dim, {align:'right', font:'num'});
        const by = ty + 22, frac = p.duration ? Math.max(0, Math.min(1, p.position / p.duration)) : 0;
        cv.roundRect(ix, by, iw, 8, 4, withAlpha('#ffffff', 0.14));
        if (frac > 0) cv.roundRect(ix, by, Math.max(8, iw * frac), 8, 4, t.sel || t.accent);
        if (p.duration) cv.circle(ix + iw * frac, by + 4, 9, t.text);
        // message line: a transient notice first, else the player's own error
        const msg = m.notice ? m.notice.text : p.error;
        if (msg) paragraph(cv, msg, ix, by + 46, 19, m.notice && m.notice.level === 'info' ? t.dim : t.warn, iw, 2);
        // transport
        const cy = TOP + v.h - 148, side = 150, mid = iw - 2 * side - 24;
        const idle = !p.playing;
        button(cv, t, ix, cy, side, 60, '- 15 s', () => a.seek(-15), 'SEEK_BACK', {off:idle || p.busy});
        button(cv, t, ix + side + 12, cy, mid, 60, p.busy ? 'Starting...' : p.paused ? 'Resume' : p.playing ? 'Pause' : p.ended ? 'Play again' : 'Play',
            a.toggle, 'PLAY_PAUSE', {primary:true, off:p.busy || !m.allowed});
        button(cv, t, ix + side + mid + 24, cy, side, 60, '+ 15 s', () => a.seek(15), 'SEEK_FORWARD', {off:idle || p.busy || p.nearEnd});
        const half = (iw - 12) / 2;
        button(cv, t, ix, cy + 74, half, 52, 'Stop', a.stop, 'STOP', {color:t.crit});
        button(cv, t, ix + half + 12, cy + 74, half, 52, 'Back to list', a.back, 'TO_LIST');
    }

    /* ---------------- Connection / Logs ---------------- */
    function checks(cv, t, rows, x, y, w, rowH) {
        rows.forEach((r, i) => {
            const ry = y + i * rowH, c = r.state === 'ok' ? t.ok || t.accent : r.state === 'off' ? t.dim : r.state === 'bad' ? t.crit : t.warn;
            if (i) cv.fillRect(x, ry - rowH / 2 + 4, w, 1, withAlpha('#ffffff', 0.08));
            if (r.state === 'ok') cv.circle(x + 9, ry - 7, 8, c);
            else cv.arc(x + 9, ry - 7, 5, 8, 0, 360, c);
            label(cv, r.name, x + 32, ry, 20, t.dim, 220);
            label(cv, r.value, x + 262, ry, 21, r.state === 'ok' ? t.text : c === t.dim ? t.dim : t.text, w - 262);
        });
    }
    function drawConnection(cv, t, m, a) {
        const c = m.connection, panelH = FOOT_Y - TOP - 14, qrSize = 300;
        G.panel(cv, t, EDGE, TOP, 372, panelH, '');
        qr(cv, t, c.ready ? c.link : null, EDGE + 36, TOP + 28, qrSize, c.blocked);
        cv.text(c.ready ? 'SCAN WITH THE PHONE' : 'PHONE IMPORT', EDGE + 186, TOP + qrSize + 60, 17, c.ready ? t.text : t.dim, {align:'center', font:'bold', spacing:1.5});
        const x = EDGE + 392, w = W - EDGE - x;
        G.panel(cv, t, x, TOP, w, panelH, '');
        checks(cv, t, c.rows, x + 28, TOP + 50, w - 56, 49);
        footer(cv, t, m, c.ready ? 'Upload videos or send YouTube links from the phone. Same Wi-Fi as the car.' : c.blocked, [
            {text:'Check again', w:220, key:'RECHECK', run:a.recheck},
            {text:'Logs', w:150, key:'LOGS', run:() => a.open(PAGE.LOGS)},
        ]);
    }
    function drawLogs(cv, t, m, a) {
        const c = m.connection, d = m.logs, panelH = FOOT_Y - TOP - 14, qrSize = 300;
        G.panel(cv, t, EDGE, TOP, 372, panelH, '');
        qr(cv, t, c.ready ? d.link : null, EDGE + 36, TOP + 28, qrSize, c.blocked);
        cv.text(c.ready ? 'SCAN TO DOWNLOAD THE LOG' : 'LOG DOWNLOAD', EDGE + 186, TOP + qrSize + 60, 17, c.ready ? t.text : t.dim, {align:'center', font:'bold', spacing:1.5});
        const x = EDGE + 392, w = W - EDGE - x;
        G.panel(cv, t, x, TOP, w, panelH, '');
        if (!d.events.length) cv.text('No events recorded yet.', x + 28, TOP + 60, 21, t.dim);
        d.events.forEach((e, i) => {
            const y = TOP + 44 + i * 34, c2 = e.level === 'ERROR' ? t.crit : e.level === 'WARN' ? t.warn : t.dim;
            cv.text(e.at.slice(11, 19), x + 28, y, 18, t.dim, {font:'num'});
            cv.text(e.level, x + 126, y, 16, c2, {font:'bold', spacing:1});
            label(cv, e.event + (e.detail ? '  ' + e.detail : ''), x + 208, y, 18, e.level === 'INFO' ? t.text : c2, w - 236);
        });
        footer(cv, t, m, d.total + ' saved events from this and earlier sessions  \u00b7  times in UTC', [
            {text:'Back', w:170, key:'LOGS_BACK', run:() => a.open(PAGE.CONNECTION)},
        ]);
    }

    /** Draw the page m.page. m: the view model (main.js viewModel), a: the actions. */
    function draw(cv, t, m, a) {
        cv.clear(t.bg);
        const badge = m.allowed ? {text:'PARKED', color:t.ok || t.accent} : {text:m.lock === 'moving' ? 'MOVING' : 'NO SPEED SIGNAL', color:t.crit};
        G.frame(cv, t, TABS, Math.min(m.page, PAGE.CONNECTION), [badge]);
        if (m.page === PAGE.PLAYER) drawPlayer(cv, t, m, a);
        else if (m.page === PAGE.CONNECTION) drawConnection(cv, t, m, a);
        else if (m.page === PAGE.LOGS) drawLogs(cv, t, m, a);
        else drawList(cv, t, m, a);
        return cv;
    }
    return {draw, fit, inkOn};
}

module.exports = { makeUi, ascii, clock, megabytes, TABS, PAGE, PAGE_SIZE, VIDEO, W, H };
