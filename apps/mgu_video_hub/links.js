'use strict';

// Saved YouTube links: video ID plus the title and length yt-dlp reported the
// first time the video was played. Stored in data/youtube.json; the 0.1.x
// format (a plain array of IDs) is still read.
const fs = require('fs');
const path = require('path');
const FILE = 'youtube.json', MAX_LINKS = 100;
const ID = /^[A-Za-z0-9_-]{11}$/;

function clean(entry) {
    const id = typeof entry === 'string' ? entry : entry && entry.id;
    if (typeof id !== 'string' || !ID.test(id)) return null;
    const out = {id};
    if (entry && typeof entry.title === 'string' && entry.title.trim())
        out.title = entry.title.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 120);
    if (entry && typeof entry.duration === 'number' && entry.duration > 0 && entry.duration < 360000)
        out.duration = Math.round(entry.duration);
    return out;
}

class LinkStore {
    constructor(dir) {
        this.file = path.join(dir, FILE);
        this.items = [];
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (Array.isArray(raw)) raw.forEach(entry => {
                const item = clean(entry);
                if (item && !this.find(item.id)) this.items.push(item);
            });
            this.items = this.items.slice(-MAX_LINKS);
        } catch (_) {}
    }
    find(id) { return this.items.find(item => item.id === id) || null; }
    get length() { return this.items.length; }
    /** Newest first, as the lists show them. */
    list() { return this.items.slice().reverse(); }
    /** Add a link (again): it moves to the newest place and keeps what is known about it. */
    add(id) {
        if (!ID.test(String(id))) throw new Error('Invalid YouTube video ID');
        const known = this.find(id) || {id};
        this.items = this.items.filter(item => item.id !== id).concat([known]).slice(-MAX_LINKS);
        this.save();
        return known;
    }
    remove(id) {
        const before = this.items.length;
        this.items = this.items.filter(item => item.id !== id);
        if (this.items.length === before) return false;
        this.save();
        return true;
    }
    /** Title and length from the resolver; false when nothing changed (no write). */
    describe(id, meta) {
        const item = this.find(id), next = item && clean(Object.assign({}, item, meta || {}));
        if (!next || (next.title === item.title && next.duration === item.duration)) return false;
        if (next.title) item.title = next.title;
        if (next.duration) item.duration = next.duration;
        this.save();
        return true;
    }
    save() {
        fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.items));
        fs.renameSync(this.file + '.tmp', this.file);
    }
}
module.exports = { LinkStore, FILE, MAX_LINKS };
