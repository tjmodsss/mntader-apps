'use strict';
// Derived from bimmer-lab/apps shared/shaders.js SHIFTBAR (MIT, pinned upstream).
// Same rounded Retro segments and 3px gaps. u_flash=1/2 selects the
// full-bar bright/dim red warning; zero retains the normal RPM bands.
// Equal slots: the adapted layout supplies eighty 100rpm cells across 0..8000.
module.exports = `
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform float u_segs;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform vec4 u_track;
uniform float u_flash;
uniform vec2 u_skip;
// Default GL value (0,0) is safely disabled before the first application tick.
// x: confirmed active cold restriction; y: its actual RPM boundary / 8000.
uniform vec2 u_coldRange;

void main() {
    if (u_segs < 1.0) { gl_FragColor = vec4(0.0); return; }
    float gapPx = 3.0;
    float px = v_uv.x * u_size.x;
    float local = px;
    float span = u_size.x;
    if (u_skip.y > u_skip.x) {
        if (px >= u_skip.x && px < u_skip.y) { gl_FragColor = vec4(0.0); return; }
        if (px < u_skip.x) span = u_skip.x;
        else { span = u_size.x - u_skip.y; local = u_size.x - px; }
    }
    float slot = span / u_segs;
    float start = floor(local / slot) * slot;
    float inSeg = local - start;
    float segW = slot - gapPx;
    float py = v_uv.y * u_size.y;
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    vec2 q = abs(p) - (hs - vec2(2.0));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 2.0;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    if (inSeg > segW) cover = 0.0;
    if (cover <= 0.0) { gl_FragColor = vec4(0.0); return; }
    if (u_flash > 0.5) {
        gl_FragColor = vec4(u_high, cover * (u_flash > 1.5 ? 0.18 : 1.0));
        return;
    }
    // Prepared display only: this remains absent without a verified source.
    // Six-pixel cap above the restricted range, in the existing Retro cells.
    if (u_coldRange.x > 0.5 && v_uv.x >= u_coldRange.y && py < 6.0) {
        gl_FragColor = vec4(57.0 / 255.0, 139.0 / 255.0, 1.0, cover);
        return;
    }
    float pos = (start + slot * 0.5) / span;
    bool lit = pos <= u_value;
    vec3 c = pos >= u_highAt ? u_high : (pos >= u_midAt ? u_mid : u_low);
    gl_FragColor = lit ? vec4(c, cover) : vec4(u_track.rgb, u_track.a * cover);
}
`;
