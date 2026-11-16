'use strict';

// MGU render protocol v4: I420 ring buffer, not an HTML5 video/web browser.
// Decoder is deliberately external: the BMW OAP Node 8 runtime has no video codec.
//
// Pacing (0.2.0): ffmpeg decodes as fast as the pipe allows and this module
// hands one frame to the renderer every 1/FPS s. ffmpeg's own "-re" pacing
// follows the wall clock, so a decoder resumed after SIGSTOP raced through
// everything it had "missed" (a 3 s pause played 4 s of video in half a
// second). Pausing now simply stops handing out frames; the full pipe holds
// ffmpeg back.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const FPS = 15, SLOTS = 3, HEADER = 64, ID = 73;
const MAGIC = 0x4656474d;
const QUEUE_FRAMES = 3;
const FRAME_MS = 1000 / FPS;
const SHM_DIR = '/dev/shm', SHM_PREFIX = 'mgu-video-vhub-';
const RESOLVE_TIMEOUT_MS = 25000, RESOLVE_CACHE_MS = 10 * 60 * 1000;

function executable(name, extraDirs) {
    const dirs = String(process.env.PATH || '').split(':').filter(Boolean).concat(extraDirs || []);
    const parts = name.indexOf('/') >= 0 ? [name] : dirs.map(p => path.join(p, name));
    return parts.find(p => {
        try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch (_) { return false; }
    }) || null;
}
function frameHeader(w, h, seq, slot) {
    const b = Buffer.alloc(HEADER);
    [MAGIC, 1, w, h, seq, slot, SLOTS, 1, 0].forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4));
    return b;
}
function videoOp(cv, id, x, y, w, h, radius) {
    cv._grow(7);
    const i = cv.n;
    cv.u[i] = 19;
    cv.f[i + 1] = x; cv.f[i + 2] = y;
    cv.f[i + 3] = w; cv.f[i + 4] = h;
    cv.f[i + 5] = radius || 0;
    cv.u[i + 6] = id;
    cv.n += 7;
}
function rendererRegister(gpu, file, id) {
    if (!gpu || !gpu.ready || !gpu.native || !gpu.info || !gpu.info.video || !gpu._write) return false;
    const p = Buffer.from(file + '\0', 'utf8');
    const len = (p.length + 3) & ~3;
    const b = Buffer.alloc(8 + 4 + len);
    b.writeUInt32LE(13, 0); b.writeUInt32LE(4 + len, 4);
    b.writeUInt32LE(id, 8); p.copy(b, 12);
    return !!gpu._write(b);
}

/** "3:25", "1:02:03" or "45" (yt-dlp --get-duration) -> seconds, else null. */
function parseClock(text) {
    const m = /^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,5})(?:\.\d+)?$/.exec(String(text || '').trim());
    if (!m) return null;
    const parts = [m[1], m[2], m[3]].filter(x => x !== undefined).map(Number);
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return seconds > 0 && seconds < 360000 ? seconds : null;
}
/** yt-dlp prints title, stream URL and duration on separate lines (title and duration are optional). */
function parseResolver(stdout) {
    const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim());
    const urls = lines.filter(s => /^https:\/\/\S+$/.test(s));
    if (urls.length !== 1) return null;
    const at = lines.indexOf(urls[0]);
    const title = at > 0 ? lines[at - 1].replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120) : '';
    return {url:urls[0], title, duration:parseClock(lines[at + 1])};
}
function resolveYoutube(id, resolver, callback, proxyUrl) {
    let done = false, timer = null, p = null;
    function finish(error, value) {
        if (done) return;
        done = true; clearTimeout(timer);
        if (error && p) { try { p.kill('SIGKILL'); } catch (_) {} }
        callback(error, value);
    }
    if (!resolver) {
        // Asynchronous like every other outcome, so the caller's handle is already stored.
        setImmediate(() => finish(new Error('yt-dlp is missing on the MGU')));
        return {kill() { done = true; }};
    }
    const url = 'https://www.youtube.com/watch?v=' + id;
    const args = ['--no-playlist', '--no-warnings', '--encoding', 'utf-8',
        '--get-title', '--get-url', '--get-duration', '-f', 'best[height<=720]/best', url];
    if (proxyUrl) args.unshift('--proxy', proxyUrl);
    try { p = cp.spawn(resolver, args, {stdio: ['ignore', 'pipe', 'pipe']}); }
    catch (e) { setImmediate(() => finish(e)); return {kill() { done = true; }}; }
    let stdout = '', stderr = '';
    timer = setTimeout(() => finish(new Error('YouTube resolver timed out')), RESOLVE_TIMEOUT_MS);
    p.stdout.on('data', b => { stdout += b.toString('utf8'); if (stdout.length > 8192) finish(new Error('Resolver output too large')); });
    p.stderr.on('data', b => { if (stderr.length < 1500) stderr += b.toString('utf8'); });
    p.on('error', e => finish(e));
    p.on('close', code => {
        const found = code === 0 ? parseResolver(stdout) : null;
        if (!found) finish(new Error((stderr.trim() || 'No playable single-stream format').slice(0, 180)));
        else finish(null, found);
    });
    return {kill(signal) { done = true; clearTimeout(timer); try { p.kill(signal || 'SIGKILL'); } catch (_) {} }};
}

/** Length of a local file in seconds: ffmpeg prints it for an input without any output. */
function probeDuration(ffmpeg, file, callback) {
    let done = false, text = '', p;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); callback(value); };
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} finish(null); }, 6000);
    try { p = cp.spawn(ffmpeg, ['-nostdin', '-hide_banner', '-i', file], {stdio: ['ignore', 'ignore', 'pipe']}); }
    catch (_) { return finish(null); }
    p.stderr.on('data', b => { if (text.length < 16384) text += b.toString('utf8'); });
    p.on('error', () => finish(null));
    p.on('close', () => {
        const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
        const seconds = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
        finish(seconds > 0 ? seconds : null);
    });
}

/** Frame buffers of earlier runs that were killed before they could clean up (1-2 MB of RAM each). */
function sweepStale(dir, ownPid) {
    let removed = 0, names;
    try { names = fs.readdirSync(dir || SHM_DIR); } catch (_) { return 0; }
    names.forEach(name => {
        const m = /^mgu-video-vhub-(\d+)-[0-9a-f]{8}$/.exec(name);
        if (!m) return;
        const pid = Number(m[1]);
        if (pid === (ownPid || process.pid)) return;
        try { process.kill(pid, 0); return; }                    // still running
        catch (e) { if (e.code !== 'ESRCH') return; }             // EPERM: somebody else's live process
        try { fs.unlinkSync(path.join(dir || SHM_DIR, name)); removed++; } catch (_) {}
    });
    return removed;
}

class VideoBridge {
    constructor(log, opts) {
        this.log = log || console;
        opts = opts || {};
        this.opts = opts;
        this.proxyProvider = opts.proxyProvider || (() => null);
        this.mediaProxyProvider = opts.mediaProxyProvider || (() => null);
        this.onEvent = opts.onEvent || (() => {});
        this.onMeta = opts.onMeta || (() => {});
        this.path = path.join(opts.shmDir || SHM_DIR, SHM_PREFIX + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
        this.fd = null;
        this.status = 'Idle'; this.error = '';
        this.position = 0; this.duration = null;
        this.playing = false; this.paused = false; this.ended = false;
        this.child = null; this.audioDec = null; this.audioOut = null; this.resolving = null;
        this.audioFilter = null; this.dspClient = opts.dspClient || null; this.dspRuntime = opts.dspRuntime;
        this.source = null; this.generation = 0; this.frames = 0; this.tail = Buffer.alloc(0);
        this.width = 640; this.height = 360; this.frameSize = 0;
        this.queue = []; this.timer = null; this.due = 0; this.startedAt = 0;
        this.decoderDone = false; this.exitCode = null; this.stderrText = '';
        this.resolved = null;                 // {id, url, title, duration, at}: seeking does not ask yt-dlp again
        this.durations = new Map();           // local path -> seconds
        this.probeTools();
    }
    /** Look for the helper programs (again): they may be installed while the app runs. */
    probeTools() {
        const o = this.opts, dirs = o.toolDirs || [];
        this.ffmpeg = o.ffmpeg === undefined ? executable(process.env.MGU_FFMPEG || 'ffmpeg', dirs) : o.ffmpeg;
        this.aplay = o.aplay === undefined ? executable('aplay', dirs) : o.aplay;
        this.resolver = o.resolver === undefined ? executable(process.env.MGU_YTDLP || 'yt-dlp', dirs) : o.resolver;
        return {ffmpeg:this.ffmpeg, aplay:this.aplay, resolver:this.resolver};
    }
    event(level, code, detail) {
        try { this.onEvent(level, code, detail || ''); } catch (_) {}
    }
    compatible() { return !!this.ffmpeg; }
    /** A decoder is running, paused, or still being prepared. */
    get active() { return !!(this.playing || this.resolving); }
    _open(w, h) {
        this._closeFile();
        this.width = w; this.height = h;
        this.frameSize = w * h * 3 / 2;
        this.fd = fs.openSync(this.path, 'w+', 0o600);
        fs.ftruncateSync(this.fd, HEADER + this.frameSize * SLOTS);
        fs.writeSync(this.fd, frameHeader(w, h, 0, 0), 0, HEADER, 0);
    }
    _closeFile() {
        if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = null; }
        try { fs.unlinkSync(this.path); } catch (_) {}
    }
    _writeFrame(frame) {
        if (this.fd === null) return;
        const next = (this.frames + 1) % SLOTS;
        fs.writeSync(this.fd, frame, 0, this.frameSize, HEADER + next * this.frameSize);
        // Commit order: slot first, then sequence. The renderer samples newest sequence.
        const b = Buffer.allocUnsafe(8);
        b.writeUInt32LE(next, 0); b.writeUInt32LE(this.frames + 1, 4);
        fs.writeSync(this.fd, b.slice(0, 4), 0, 4, 20);
        fs.writeSync(this.fd, b.slice(4), 0, 4, 16);
        this.frames++;
        this.position = this.startedAt + this.frames / FPS;
        if (this.frames === 1) this.event('INFO', 'decoder.first_frame', this.width + 'x' + this.height);
    }
    _onData(data) {
        if (!this.playing) return;
        let b = this.tail.length ? Buffer.concat([this.tail, data]) : data;
        while (b.length >= this.frameSize) {
            this.queue.push(b.slice(0, this.frameSize));
            b = b.slice(this.frameSize);
        }
        this.tail = b;
        // A full queue stops reading; the pipe then holds the decoder at the playback rate.
        if (this.queue.length >= QUEUE_FRAMES && this.child && this.child.stdout) this.child.stdout.pause();
        if (this.status === 'Buffering...' && this.queue.length) this.status = 'Playing';
        this._schedule();
    }
    _schedule() {
        if (this.timer !== null || !this.playing || this.paused) return;
        const now = Date.now();
        // After a pause, a stall or the very first frame the clock starts again from now.
        if (!this.due || now - this.due > 4 * FRAME_MS) this.due = now;
        this.timer = setTimeout(() => this._tick(), Math.max(0, this.due - now));
    }
    _tick() {
        this.timer = null;
        if (!this.playing || this.paused) return;
        const frame = this.queue.shift();
        if (frame) {
            try { this._writeFrame(frame); }
            catch (e) { return this._fail('Frame buffer failed', e.message, 'decoder.framebuffer'); }
            this.due += FRAME_MS;
            if (this.queue.length < QUEUE_FRAMES && this.child && this.child.stdout) this.child.stdout.resume();
        }
        if (!this.queue.length && this.decoderDone) return this._finish();
        // A frame was shown: the next one is due a frame time later, queued already or not.
        if (frame) return this._schedule();
        // Nothing decoded in time (slow USB stick, network): the next frame restarts the clock.
        this.due = 0;
        if (this.frames) this.status = 'Buffering...';
    }
    _fail(status, error, code) {
        this.event('ERROR', code, error);
        this._halt();
        this.status = status; this.error = error;
    }
    /** Stop decoding but keep the last picture and the position (end of file, decoder error). */
    _halt() {
        if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
        if (this.child) { try { this.child.kill('SIGKILL'); } catch (_) {} this.child = null; }
        this._stopAudio();
        this.queue = []; this.tail = Buffer.alloc(0);
        this.playing = false; this.paused = false;
    }
    _finish() {
        const code = this.exitCode, ok = code === 0 && this.frames > 0;
        this._halt();
        this.ended = ok;
        this.status = ok ? 'Finished' : code === 0 ? 'Nothing to play' : 'Decoder stopped';
        if (!ok && !this.error)
            this.error = code === 0 ? 'No video frames at this position' : this.stderrText.trim().slice(0, 180) || 'ffmpeg exited ' + code;
        // A stream URL that produced nothing is not asked for again (expired or refused).
        if (!ok && this.source && this.source.type === 'youtube') this.resolved = null;
        this.event(ok ? 'INFO' : 'ERROR', 'decoder.exited',
            'code=' + code + ' frames=' + this.frames + (this.error ? ' error=' + this.error : ''));
    }
    start(source, seconds, width, audio) {
        this.stop();
        this.source = source;
        const gen = this.generation;
        this.position = Math.max(0, Number(seconds) || 0);
        this.duration = null;
        this.error = ''; this.ended = false;
        this.status = 'Preparing video...';
        this.event('INFO', 'playback.start', 'source=' + source.type + ' seek=' + this.position + 's');
        if (!this.ffmpeg) {
            this.status = 'Decoder unavailable'; this.error = 'ffmpeg is not installed';
            this.event('ERROR', 'decoder.missing', this.error);
            return;
        }
        if (source.type !== 'youtube') {
            this._localDuration(source.path, gen);
            return this._decode(source.path, this.position, width, audio, gen);
        }
        if (!this.resolver) {
            this.status = 'YouTube unavailable'; this.error = 'yt-dlp is not installed on the MGU';
            this.event('ERROR', 'youtube.resolver_missing', this.error);
            return;
        }
        const proxyUrl = this.proxyProvider();
        if (!proxyUrl) {
            this.status = 'Internet unavailable';
            this.error = 'MGU Store uplink proxy not ready; see Connection';
            this.event('WARN', 'uplink.unavailable', this.error);
            return;
        }
        const cached = this.resolved;
        if (cached && cached.id === source.id && Date.now() - cached.at < RESOLVE_CACHE_MS) {
            this.duration = cached.duration;
            return this._decode(cached.url, this.position, width, audio, gen);
        }
        this.status = 'Resolving YouTube stream...';
        this.event('INFO', 'youtube.resolve', 'Starting yt-dlp for video ID ' + source.id);
        this.resolving = resolveYoutube(source.id, this.resolver, (err, found) => {
            if (gen !== this.generation) return;
            this.resolving = null;
            if (err) {
                this.status = 'YouTube unavailable'; this.error = err.message;
                this.event('ERROR', 'youtube.resolve_failed', this.error);
                return;
            }
            this.resolved = {id:source.id, url:found.url, title:found.title, duration:found.duration, at:Date.now()};
            this.duration = found.duration;
            this.event('INFO', 'youtube.resolved', 'HTTPS video stream URL resolved (URL not logged)');
            try { this.onMeta({id:source.id, title:found.title, duration:found.duration}); } catch (_) {}
            this._decode(found.url, this.position, width, audio, gen);
        }, proxyUrl);
    }
    _localDuration(file, gen) {
        if (this.durations.has(file)) { this.duration = this.durations.get(file); return; }
        probeDuration(this.ffmpeg, file, seconds => {
            if (this.durations.size >= 64) this.durations.clear();
            this.durations.set(file, seconds);
            if (gen === this.generation) this.duration = seconds;
        });
    }
    _decode(input, seconds, width, audio, gen) {
        if (gen !== this.generation) return;
        const online = /^https:\/\//i.test(input), mediaProxy = online ? this.mediaProxyProvider() : null;
        if (online && !mediaProxy) {
            this.status = 'Internet unavailable';
            this.error = 'MGU Store video-stream proxy not ready';
            this.event('ERROR', 'uplink.stream_unavailable', this.error);
            return;
        }
        const w = width === 960 ? 960 : 640, h = w * 9 / 16;
        try { this._open(w, h); } catch (e) {
            this.status = 'Frame buffer failed'; this.error = e.message;
            this.event('ERROR', 'decoder.framebuffer', this.error);
            return;
        }
        this.frames = 0; this.startedAt = seconds; this.tail = Buffer.alloc(0);
        this.queue = []; this.due = 0; this.decoderDone = false; this.exitCode = null; this.stderrText = '';
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error'];
        if (seconds) args.push('-ss', String(seconds));
        if (mediaProxy) args.push('-http_proxy', mediaProxy);
        args.push('-i', input, '-an', '-vf', 'fps=' + FPS + ',scale=' + w + ':' + h + ',format=yuv420p',
            '-f', 'rawvideo', '-pix_fmt', 'yuv420p', 'pipe:1');
        let child;
        try { child = this.child = cp.spawn(this.ffmpeg, args, {stdio: ['ignore', 'pipe', 'pipe']}); }
        catch (e) {
            this.status = 'Decoder failed'; this.error = e.message; this._closeFile();
            this.event('ERROR', 'decoder.spawn_failed', this.error);
            return;
        }
        this.playing = true; this.paused = false; this.status = 'Playing';
        this.event('INFO', 'decoder.started', 'output=' + w + 'x' + h + ' fps=' + FPS + ' audio=' + audio);
        child.stdout.on('data', b => { if (gen === this.generation) this._onData(b); });
        child.stderr.on('data', b => { if (gen === this.generation && this.stderrText.length < 1200) this.stderrText += b.toString('utf8'); });
        child.on('error', e => {
            if (gen !== this.generation) return;
            this.child = null;
            this._fail('Decoder error', e.message, 'decoder.error');
        });
        child.on('close', code => {
            if (gen !== this.generation || this.child !== child) return;
            this.child = null; this.decoderDone = true; this.exitCode = code;
            // The frames still queued are shown first; a paused player finishes after it resumes.
            if (!this.queue.length && !this.paused) this._finish();
        });
        if (audio === 'alsa') this._startAudio(input, seconds);
    }
    _startAudio(input, seconds) {
        if (!this.aplay) {
            this.error = 'aplay missing; playback is silent';
            this.event('WARN', 'audio.missing', this.error);
            return;
        }
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-re'];
        if (seconds) args.push('-ss', String(seconds));
        if (/^https:\/\//i.test(input) && this.mediaProxyProvider()) args.push('-http_proxy', this.mediaProxyProvider());
        args.push('-i', input, '-vn', '-ac', '2', '-ar', '44100', '-f', 's16le', 'pipe:1');
        try {
            this.audioDec = cp.spawn(this.ffmpeg, args, {stdio: ['ignore', 'pipe', 'ignore']});
            this.audioOut = cp.spawn(this.aplay, ['-q', '-f', 'S16_LE', '-c', '2', '-r', '44100'], {stdio: ['pipe', 'ignore', 'ignore']});
            const Dsp = this.dspClient || require('./kit/dsp-client');
            this.audioFilter = new Dsp.PcmFilter({ sampleRate: 44100, channels: 2, source: 'mgu_video_hub', runtime: this.dspRuntime,
                onFallback: (why) => {
                    this.log.warn('Video Hub: DSP bypass: ' + why);
                    this.event('WARN', 'audio.dsp_bypass', why);
                } });
            this.audioDec.stdout.pipe(this.audioFilter).pipe(this.audioOut.stdin);
            this.audioOut.stdin.on('error', e => {
                this.error = 'Audio output: ' + e.message; this.event('ERROR', 'audio.output_error', this.error);
            });
            this.audioFilter.on('error', e => {
                this.error = 'Audio EQ: ' + e.message;
                this.event('ERROR', 'audio.filter_error', this.error); this._stopAudio();
            });
            this.audioDec.on('error', e => {
                this.error = 'Audio decoder: ' + e.message; this.event('ERROR', 'audio.decoder_error', this.error);
            });
            this.audioOut.on('error', e => {
                this.error = 'Audio output: ' + e.message; this.event('ERROR', 'audio.output_error', this.error);
            });
        } catch (e) {
            this.error = 'Audio unavailable: ' + e.message;
            this.event('ERROR', 'audio.start_failed', this.error); this._stopAudio();
        }
    }
    /** Pause or resume. The decoder is never signalled: it waits on its full output pipe. */
    pause() {
        if (!this.playing) return;
        this.paused = !this.paused;
        // The audio sink plays whatever it is given, so the audio pair is stopped and continued.
        const signal = this.paused ? 'SIGSTOP' : 'SIGCONT';
        [this.audioDec, this.audioOut].forEach(p => { if (p) try { p.kill(signal); } catch (_) {} });
        if (this.paused) {
            if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
            this.status = 'Paused';
        } else {
            this.status = 'Playing'; this.due = 0;
            if (this.queue.length) this._schedule();
            else if (this.decoderDone) this._finish();
        }
        this.event('INFO', this.paused ? 'playback.paused' : 'playback.resumed', '');
    }
    seek(delta, width, audio) {
        if (!this.source) return;
        this.start(this.source, Math.max(0, this.position + delta), width, audio);
    }
    _stopAudio() {
        if (this.audioFilter) { try { this.audioFilter.destroy(); } catch (_) {} this.audioFilter = null; }
        if (this.audioDec) { try { this.audioDec.kill('SIGCONT'); this.audioDec.kill('SIGKILL'); } catch (_) {} this.audioDec = null; }
        if (this.audioOut) { try { this.audioOut.kill('SIGCONT'); this.audioOut.kill('SIGKILL'); } catch (_) {} this.audioOut = null; }
    }
    stop() {
        const wasActive = !!(this.playing || this.resolving || this.child);
        this.generation++;
        if (this.resolving) { try { this.resolving.kill('SIGKILL'); } catch (_) {} this.resolving = null; }
        this._halt();
        this._closeFile();
        this.ended = false;
        this.status = 'Stopped';
        if (wasActive) this.event('INFO', 'playback.stopped', 'frames=' + this.frames);
    }
    dispose() { this.stop(); }
}
module.exports = { VideoBridge, executable, frameHeader, rendererRegister, videoOp, resolveYoutube,
    parseResolver, parseClock, probeDuration, sweepStale, FPS, HEADER, SLOTS, ID, MAGIC, QUEUE_FRAMES };
