'use strict';

// Video Hub: wiring. What is drawn lives in ui.js, the decoder in video_bridge.js,
// the phone page's server in companion.js, the parked-only gate in safety.js.
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const kitCanvas = require('./kit/canvas');
const media = require('./media');
const { VideoBridge, rendererRegister, videoOp, sweepStale, ID } = require('./video_bridge');
const { Companion } = require('./companion');
const { readNetworkStatus } = require('./network_status');
const { StoreUplink } = require('./uplink');
const { Diagnostics, safeText } = require('./diagnostics');
const { ParkedGuard } = require('./safety');
const { LinkStore } = require('./links');
const { openEq } = require('./audio_eq');
const { makeUi, clock, megabytes, PAGE, PAGE_SIZE, W, H } = require('./ui');

const NOTICE_MS = {info:6000, warn:8000, error:10000};

mgu.run({
    async start(ctx) {
        const log = ctx.log;
        const ui = makeUi(G, kitCanvas);
        const diagnostics = new Diagnostics(ctx.dataDir, ctx.spec && ctx.spec.version || '0.2.0');
        const record = (level, event, detail) => diagnostics.add(level, event, detail);
        const guard = new ParkedGuard();
        const links = new LinkStore(ctx.dataDir);
        const uplink = new StoreUplink(ctx.dataDir, log);
        uplink.start();
        const video = new VideoBridge(log, {
            toolDirs: [path.join(ctx.dataDir, 'bin')],
            proxyProvider: () => uplink.ownLease() ? uplink.proxyUrl : null,
            mediaProxyProvider: () => uplink.ownLease() ? uplink.mediaProxyUrl : null,
            onEvent: record,
            onMeta: meta => { try { links.describe(meta.id, meta); } catch (e) { record('WARN', 'youtube.meta_failed', e.message); }
                if (current && current.id === meta.id && meta.title) current.name = meta.title; },
        });

        let page = PAGE.LIBRARY, origin = PAGE.LIBRARY, files = [], current = null, importCount = 0;
        const listPage = {};                  // page -> index of the list page shown
        let notice = null, lastScan = 0, lastVideoBind = 0, boundGpu = null;
        let network = {ready:false, error:'Network tool not responding'};
        let lastNetworkPoll = 0, lastNetworkReply = 0, networkPollPending = false;
        let lastStatePoll = 0, lastPhoneRetry = 0;
        const seen = {};                      // last logged value per diagnostic state

        const swept = sweepStale();
        record('INFO', 'app.started', 'Node ' + process.version + ' / ' + process.arch +
            '; ffmpeg=' + !!video.ffmpeg + '; yt-dlp=' + !!video.resolver + '; aplay=' + !!video.aplay +
            (swept ? '; removed ' + swept + ' stale frame buffer(s)' : ''));
        if (!video.ffmpeg) record('WARN', 'decoder.missing', 'ffmpeg not installed or not executable for OAP user');
        if (!video.resolver) record('WARN', 'youtube.resolver_missing', 'yt-dlp not installed or not executable for OAP user');

        /** A message in the footer (the player shows it in its panel) that goes away by itself. */
        function say(text, level) {
            level = level || 'info';
            notice = text ? {text:String(text), level, until:Date.now() + NOTICE_MS[level]} : null;
        }
        function changed(key, value) {
            if (seen[key] === value) return false;
            seen[key] = value;
            return true;
        }

        /* ---------------- safety: parked only, screen visible and in front ---------------- */
        const busy = () => video.playing || !!video.resolving;
        function halt(text, event) {
            if (!busy()) return;
            stop(); say(text, 'warn');
            record('WARN', event, text);
        }
        ctx.signals.watch('de.bmw.infotainment.vehicle.Vehicle2', '1', {
            statusCarSpeed2: v => {
                if (guard.update(v && v.speedVehicleCentreOfGravity) && !guard.allowed())
                    halt('Playback stopped: the car is moving.', 'safety.playback_stopped');
            },
        }, log, {pollMs:2000}).then(s => {
            if (s && s.error) { log.warn('[VideoHub] speed: ' + s.error); record('WARN', 'vehicle.signal_error', s.error); }
        }).catch(e => {
            log.warn('[VideoHub] speed: ' + e.message);
            record('ERROR', 'vehicle.watch_failed', e.message);
        });
        ctx.ui.onVisible((name, visible) => {
            if (name === 'MAIN' && !visible) halt('Playback stopped when the app was closed.', 'safety.screen_hidden');
        });
        if (ctx.ui.onFocus) ctx.ui.onFocus(() => {
            if (!ctx.ui.hasFocus('MAIN')) halt('Playback stopped: another screen has focus.', 'safety.focus_lost');
        });

        /* ---------------- library ---------------- */
        function rescan() {
            const previous = files.length;
            files = media.scan(ctx.dataDir);
            lastScan = Date.now();
            if (files.length !== previous) record('INFO', 'library.changed', 'files=' + files.length);
        }
        function entries(which) {
            if (which === PAGE.LIBRARY) return files.map(f => ({id:f.id, type:'local', path:f.path, source:f.source,
                title:f.name.replace(/\.[A-Za-z0-9]{2,4}$/, ''), detail:(f.source === 'USB' ? 'USB drive' : 'Uploaded') + '  ·  ' + megabytes(f.size)}));
            if (which === PAGE.YOUTUBE) return links.list().map(l => ({id:l.id, type:'youtube', source:'YouTube',
                title:l.title || 'YouTube video ' + l.id,
                detail:l.title ? (l.duration ? clock(l.duration) + '  ·  ' : '') + 'Online stream' : 'Title appears after the first playback'}));
            return [];
        }
        const listOf = which => media.pageOf(entries(which), listPage[which] || 0, PAGE_SIZE);

        /* ---------------- playback ---------------- */
        function gpuReady() {
            const gpu = ctx.display && ctx.display.gpu;
            return !!(gpu && ctx.display.active('MAIN') && gpu.ready && gpu.native && gpu.info && gpu.info.video);
        }
        function stop() { video.stop(); lastVideoBind = 0; }
        /** Why nothing can be played right now ('' when it can). */
        function blocked() {
            if (!guard.allowed()) return {text:guard.hint(), event:'safety.playback_blocked', level:'WARN'};
            if (!gpuReady()) return {text:'The video renderer is not available. See Connection.', event:'renderer.unavailable', level:'ERROR'};
            if (!video.ffmpeg) return {text:'ffmpeg is missing on the MGU. See Connection.', event:'decoder.missing', level:'ERROR'};
            return null;
        }
        function begin(source, seconds) {
            const why = blocked();
            if (why) { say(why.text, why.level === 'ERROR' ? 'error' : 'warn'); record(why.level, why.event, why.text); return false; }
            record('INFO', 'playback.request', 'source=' + source.type + (source.type === 'youtube' ? ' videoId=' + source.id : '') + ' seek=' + Math.round(seconds || 0));
            current = source;
            video.start(source, seconds || 0, Number(ctx.settings.get('resolution')), ctx.settings.get('audio'));
            origin = source.type === 'youtube' ? PAGE.YOUTUBE : PAGE.LIBRARY;   // where Back leads
            page = PAGE.PLAYER; notice = null; lastVideoBind = 0;
            return true;
        }
        function play(item) {
            if (!item) { say('Choose a video in Library or YouTube.'); return; }
            begin(item.type === 'youtube' ? {type:'youtube', id:item.id, name:item.title, kind:'youtube'} :
                {type:'local', id:item.id, path:item.path, name:item.title, kind:item.source === 'USB' ? 'USB' : 'Library'}, 0);
        }
        function toggle() {
            if (!guard.allowed()) { stop(); say(guard.hint(), 'warn'); return; }
            if (video.resolving) return;
            if (video.playing) video.pause();
            else if (current) begin(current, video.ended || video.error ? 0 : video.position);
            else say('Choose a video in Library or YouTube.');
        }
        function seek(delta) {
            if (!current || !video.playing) return;
            const target = Math.max(0, video.position + delta);
            if (video.duration && target >= video.duration - 1) { say('That is past the end of the video.'); return; }
            begin(current, target);
        }
        function open(next) {
            if (next === PAGE.PLAYER && !current) { say('Choose a video in Library or YouTube.'); return; }
            if (page === PAGE.PLAYER && next !== PAGE.PLAYER) stop();
            if (next !== page) notice = null;
            page = next;
            if (next === PAGE.LIBRARY) rescan();
        }
        function turn(delta) {
            if (page !== PAGE.LIBRARY && page !== PAGE.YOUTUBE) return;
            listPage[page] = media.pageOf(entries(page), (listPage[page] || 0) + delta, PAGE_SIZE).page;
        }
        function recheck() {
            const before = JSON.stringify(video.probeTools());
            rescan(); lastNetworkPoll = 0; lastPhoneRetry = 0;
            say('Checked again: ' + files.length + (files.length === 1 ? ' video' : ' videos') + ', ffmpeg ' + (video.ffmpeg ? 'found' : 'missing') +
                ', yt-dlp ' + (video.resolver ? 'found' : 'missing') + '.');
            record('INFO', 'connection.rechecked', 'files=' + files.length + ' toolsChanged=' + (before !== JSON.stringify(video.probeTools())));
        }
        const actions = {
            play, toggle, seek, open, turn, recheck,
            rescan: () => { rescan(); say(files.length + (files.length === 1 ? ' video found.' : ' videos found.')); },
            stop: () => { stop(); },
            back: () => open(origin),
            video: (cv, x, y, w, h, radius) => {
                const gpu = ctx.display.gpu;
                // The renderer forgets a buffer it is not told about: bind again every 1.3 s.
                if (boundGpu !== gpu || Date.now() - lastVideoBind >= 1300) {
                    if (rendererRegister(gpu, video.path, ID)) { boundGpu = gpu; lastVideoBind = Date.now(); }
                }
                videoOp(cv, ID, x, y, w, h, radius);
            },
        };

        /* ---------------- phone companion ---------------- */
        const phone = new Companion(ctx.dataDir, {
            youtube: id => {
                links.add(id); listPage[PAGE.YOUTUBE] = 0;
                say('YouTube link received from the phone.');
                record('INFO', 'youtube.link_added', 'videoId=' + id);
            },
            upload: name => {
                importCount++; rescan(); say('Imported ' + name);
                record('INFO', 'phone.upload_completed', 'file=' + name);
            },
            links: () => links.list(),
            removeFile: name => {
                const file = path.join(ctx.dataDir, 'videos', name);
                if (current && current.path === file) { stop(); current = null; if (page === PAGE.PLAYER) page = origin; }
                media.removeImported(ctx.dataDir, name);
                rescan(); say('Deleted ' + name);
                record('INFO', 'phone.file_deleted', 'file=' + name);
            },
            removeLink: id => {
                if (!links.remove(id)) throw new Error('Link not found');
                if (current && current.type === 'youtube' && current.id === id) { stop(); current = null; if (page === PAGE.PLAYER) page = origin; }
                record('INFO', 'youtube.link_removed', 'videoId=' + id);
            },
            fileCount: () => files.length,
            linkCount: () => links.length,
            logCount: () => diagnostics.events.length,
            failure: (event, detail) => record('WARN', event, detail),
            diagnostics: () => {
                record('INFO', 'diagnostics.exported', 'Phone diagnostic JSON requested');
                return diagnostics.snapshot(statusSnapshot());
            },
        }, log);
        function startPhone() {
            lastPhoneRetry = Date.now();
            try { phone.start(); }
            catch (e) { phone.error = e.message; log.warn('[VideoHub] phone server: ' + e.message); }
        }
        startPhone();
        record('INFO', 'phone.server_starting', 'port=' + phone.port);
        rescan();
        function refreshNetwork() {
            if (networkPollPending) return;
            networkPollPending = true;
            readNetworkStatus((error, result) => {
                networkPollPending = false;
                network = error ? {ready:false, error:'Network tool unavailable: ' + error.message} : result;
                lastNetworkReply = Date.now();
                const state = network.ready ? 'ready' : network.error ? 'error:' + safeText(network.error) : 'waiting';
                if (changed('network', state)) record(network.ready ? 'INFO' : 'WARN', 'phone.network_state', state);
            });
        }

        /* ---------------- what the pages show ---------------- */
        function connection() {
            const link = phone.link();
            const fresh = Date.now() - lastNetworkReply < 6000;
            const ready = !!(link && phone.listening && network.ready && fresh);
            const blocked = ready ? '' : phone.error ? phone.error :
                !phone.listening ? 'The phone server is starting.' :
                !link ? 'The MGU has no Wi-Fi address yet. Connect the phone to the car\'s Wi-Fi.' :
                network.error ? 'The network helper (mgu-video-net) does not answer. Reinstall Video Hub from the Store.' :
                network.listening ? 'Opening the Wi-Fi firewall for the phone...' : 'Waiting for the network helper.';
            const audio = ctx.settings.get('audio') === 'alsa';
            const up = uplink.ownLease();
            const rows = [
                {name:'Phone import', state:ready ? 'ok' : phone.error || network.error ? 'bad' : 'wait',
                    value:ready ? link.replace(/^http:\/\//, '').replace(/\/\?t=.*/, '') + '  ·  ready' : blocked},
                {name:'Vehicle', state:guard.allowed() ? 'ok' : guard.state() === 'moving' ? 'bad' : 'wait',
                    value:guard.allowed() ? 'Parked  ·  playback allowed' : guard.hint()},
                {name:'Video renderer', state:gpuReady() ? 'ok' : 'bad',
                    value:gpuReady() ? 'Ready' : ctx.settings.get('renderer') === 'software' ? 'Off: Settings > Renderer is set to Software' : 'Not available (needs idrive7-renderd 2.1.6+)'},
                {name:'ffmpeg', state:video.ffmpeg ? 'ok' : 'bad', value:video.ffmpeg || 'Not installed: no video can be decoded'},
                {name:'yt-dlp', state:video.resolver ? 'ok' : 'wait', value:video.resolver || 'Not installed: YouTube links cannot be played'},
                {name:'Internet', state:up && uplink.proxyUrl && uplink.mediaProxyUrl ? 'ok' : 'wait', value:uplink.status()},
                {name:'Audio', state:!audio ? 'off' : video.aplay ? 'ok' : 'bad',
                    value:!audio ? 'Off (Settings > Audio output)' : video.aplay ? 'ALSA  ·  ' + video.aplay : 'aplay is missing: playback stays silent'},
            ];
            return {ready, link, blocked, rows};
        }
        function viewModel() {
            if (notice && Date.now() > notice.until) notice = null;
            const m = {page, allowed:guard.allowed(), lock:guard.state(), lockHint:guard.hint(), notice,
                currentId:current ? current.id : null};
            if (page === PAGE.LIBRARY || page === PAGE.YOUTUBE) {
                m.list = listOf(page); m.list.total = entries(page).length;
                listPage[page] = m.list.page;
            } else if (page === PAGE.PLAYER) {
                const starting = !!video.resolving || (video.playing && video.frames === 0);
                m.player = {title:current ? current.name : '', kind:current ? current.kind : '',
                    status:video.status, error:video.error, position:video.position, duration:video.duration,
                    playing:video.playing, paused:video.paused, ended:video.ended, busy:starting,
                    nearEnd:!!(video.duration && video.position + 15 >= video.duration - 1),
                    picture:gpuReady() && video.fd !== null && video.frames > 0};
            } else {
                m.connection = connection();
                if (page === PAGE.LOGS) m.logs = {link:phone.link('/diagnostics.json'), events:diagnostics.recent(10), total:diagnostics.events.length};
            }
            return m;
        }
        function statusSnapshot() {
            return {
                capabilities:{rendererV4:gpuReady(), ffmpeg:!!video.ffmpeg, ytDlp:!!video.resolver, aplay:!!video.aplay},
                uplink:{state:uplink.status(), appLease:!!uplink.ownLease()},
                phone:{serverListening:phone.listening, hasAddress:!!phone.currentHost(), firewallReady:!!network.ready,
                    firewallError:safeText(network.error || phone.error || '')},
                vehicle:{speedState:guard.hint() || 'Parked and signal fresh', playbackAllowed:guard.allowed()},
                player:{status:safeText(video.status), error:safeText(video.error), frames:video.frames,
                    sourceType:current ? current.type : null, playing:video.playing, paused:video.paused,
                    position:Math.round(video.position), duration:video.duration},
                library:{files:files.length, youtubeLinks:links.length, imports:importCount},
            };
        }
        function logStates() {
            const uplinkState = uplink.status();
            if (changed('uplink', uplinkState)) record(uplink.ownLease() ? 'INFO' : 'WARN', 'uplink.state', uplinkState);
            if (uplink.error && changed('uplinkError', uplink.error)) record('ERROR', 'uplink.proxy_failed', uplink.error);
            if (phone.error && changed('phoneError', phone.error)) record('ERROR', 'phone.server_error', phone.error);
            if (changed('phoneAddress', !!phone.currentHost())) record('INFO', 'phone.address', phone.host ? 'Private address available' : 'No private address');
            const renderer = gpuReady();
            if (changed('renderer', renderer)) record(renderer ? 'INFO' : 'WARN', 'renderer.state', renderer ? 'READY' : 'NOT AVAILABLE');
            const vehicle = guard.allowed() ? 'PARKED' : guard.hint();
            if (changed('vehicle', vehicle)) record(guard.allowed() ? 'INFO' : 'WARN', 'vehicle.speed_state', vehicle);
        }

        /* ---------------- the HMI's bar, the header's tabs ---------------- */
        ctx.ui.onClick('BTN_PAGE', () => {
            const next = (Math.min(page, PAGE.CONNECTION) + 1) % 4;
            open(next === PAGE.PLAYER && !current ? PAGE.CONNECTION : next);
        });
        ctx.ui.onClick('BTN_ACTION', () => {
            if (page === PAGE.PLAYER || current) toggle();
            else play(listOf(page <= PAGE.YOUTUBE ? page : PAGE.LIBRARY).items[0]);
        });
        ctx.ui.onClick('BTN_BACK', () => {
            if (page === PAGE.LOGS) open(PAGE.CONNECTION);
            else if (page === PAGE.PLAYER) open(origin);
            else open(PAGE.LIBRARY);
        });
        ctx.ui.onClick('BTN_AUDIO_EQ', () => openEq(ctx).catch(e => say(String(e.message || e), 'warn')));
        if (typeof ctx.onTab === 'function') ctx.onTab(i => open(i));

        process.on('exit', () => {
            record('INFO', 'app.exiting', 'Stopping video and companion');
            stop(); phone.stop(); uplink.stop(); diagnostics.flush();
        });

        ctx.loop('MAIN', 12, () => {
            const now = Date.now();
            if (now - lastNetworkPoll > 2500) { lastNetworkPoll = now; refreshNetwork(); }
            // The phone server could not listen (port still held by an old instance): try again.
            if (!phone.http && now - lastPhoneRetry > 5000) startPhone();
            // Stale or missing speed must fail closed, even without another signal event.
            if (!guard.allowed()) halt(guard.hint(), 'safety.signal_stale');
            if (now - lastStatePoll > 3000) { lastStatePoll = now; logStates(); }
            if (now - lastScan > 15000 && page === PAGE.LIBRARY) rescan();
            const cv = ui.draw(ctx.canvas(W, H), ctx.theme(), viewModel(), actions);
            return ctx.ui.image('MAIN_GFX', cv);
        });
    },
});
