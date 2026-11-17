'use strict';
/*
 * Phone status line: one thin, soft-ended line that is green after the
 * iPhone reported "app opened" and red after "app closed" (phone_bridge.js).
 * No line while nothing has been reported.
 *
 * Where it sits:
 *   - normally: bottom centre of the map window (target `map`, 1088x480),
 *     non-contending, so it only appears where an app such as Waze already
 *     shows the map window. Its rows (469..472) are below Cluster Lyrics'
 *     text bands and above nothing else.
 *   - during a parked KOMBI test: inside the tested layout, on the left cover
 *     area below the speed instrument, where no layout draws anything.
 * It is never drawn in the top telltale row, the bottom strip or over a dial.
 */
const LINE_FS = `#version 100
precision mediump float;
varying vec2 v_uv;
uniform vec4 u_color;
void main(){
  float e=min(v_uv.x,1.0-v_uv.x);
  gl_FragColor=vec4(u_color.rgb,u_color.a*smoothstep(0.0,0.06,e));
}`;
const COLORS = { opened: [0.20, 0.82, 0.48, 0.9], closed: [0.86, 0.20, 0.18, 0.9] };
const Z = 900;
const W = 160, H = 4;
const MAP_RECT = { x: 464, y: 469, w: W, h: H };
// Round and contour designs: centred under the speed instrument (centre x 248).
// Rectangular designs: aligned with the left end of their own rule (x 123).
const CENTRED = { x: 168, y: 540, w: W, h: H }, ALIGNED = { x: 123, y: 540, w: W, h: H };
const PANEL_RECTS = { sixwb: CENTRED, oem: CENTRED, g80: CENTRED, classic: CENTRED, sport: ALIGNED, minimal: ALIGNED };

function panelRect(layout) { return PANEL_RECTS[layout] || CENTRED; }
function color(state) { return COLORS[state] || null; }
function valid(state) { return state === 'opened' || state === 'closed'; }

module.exports = { LINE_FS, COLORS, Z, MAP_RECT, PANEL_RECTS, panelRect, color, valid };
