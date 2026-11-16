// Make the AI judge excited — entry renderer. Dependency-free Node 22.
// Concept: a small retro terminal window floating in a dark navy void; light
// ERUPTS out of it, clipping against the frame and spilling upward/outward,
// leaving a dark weighted ground. Fully deterministic (seeded xorshift PRNG).
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1024, H = 1024, N = W * H;

// ---------------------------------------------------------------- PRNG
let _s = 0x9e3779b9 >>> 0;
function rnd(): number {
  let x = _s;
  x ^= (x << 13) >>> 0; x ^= x >>> 17; x ^= (x << 5) >>> 0;
  _s = x >>> 0;
  return (_s >>> 8) / 16777216;
}
const rf = (a: number, b: number) => a + rnd() * (b - a);
const ri = (a: number, b: number) => Math.floor(rf(a, b + 1));
// integer hash for per-pixel grain / stars (stable, no storage)
function h2(x: number, y: number, z: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 1274126177) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0; h = (h * 1103515245) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- tables
const GMAX = 1200, GN = 4096;                 // soft halo: exp(-(t/GSIG)^2)
const GSIG = 260;
const gf = new Float32Array(GN + 1);
for (let t = 0; t <= GN; t++) {
  const r = (t / GN) * GMAX;
  gf[t] = Math.exp(-(r * r) / (2 * GSIG * GSIG));
}
const SL = 64;                                 // sharp core: linear falloff²
const sf = new Float32Array(SL + 1);
for (let t = 0; t <= SL; t++) { const v = 1 - t / SL; sf[t] = v * v; }
function softAt(d2: number): number {          // d2 = squared distance
  if (d2 >= GMAX * GMAX) return 0;
  const t = (Math.sqrt(d2) / GMAX) * GN | 0;
  return gf[t];
}
function coreAt(d: number): number {
  const t = d | 0; return t >= SL ? 0 : sf[t];
}

// ---------------------------------------------------------------- scene
// window (portrait retro card), 1px = a 12px unit so chrome reads chunky
const WX = 344, WY = 412, WW = 336, WH = 288, BW = 16;      // frame box/border
const SX = WX + BW, SY = WY + BW + 36, SW = WW - 2 * BW, SH = WH - BW - 36 - 18;
// screen glow origin (the eruption source, inside the prompt line)
const AX = SX + 150, AY = SY + SH - 56;

const EMIT: { x: number; y: number; ang: number; len: number; w: number;
  i: number; hue: number; front: number; taper: number }[] = [];
function emitToward(tx: number, ty: number, len: number, w: number, i: number,
  hue: number, front: number, taper = 0) {
  const dx = tx - AX, dy = ty - AY, d = Math.hypot(dx, dy);
  const ex = AX + dx / d * (len * 0.16), ey = AY + dy / d * (len * 0.16);
  EMIT.push({ x: ex, y: ey, ang: Math.atan2(dy, dx), len, w, i, hue, front, taper });
}
// main fan: mostly up and outward, asymmetric (leans viewer-left)
// lateral-beam taper: rays within taperStart (30° in radians) of straight
// left/right are shorter (len *= lateralBeam) and carry reduced weight.
const taperStart = (30 * Math.PI) / 180;
const lateralBeam = 0.6;                        // ramp factor for grazing rays
for (let k = 0; k < 11; k++) {
  const ang = -Math.PI / 2 + rf(-1.32, 1.16);
  let len = rf(560, 940) * (Math.abs(Math.sin(ang)) * 0.3 + 0.7);
  const w0 = rf(5, 9);
  const i0 = rf(0.6, 1.15);
  const hue = rf(0.1, 0.5);
  let w = w0;
  let inten = i0;
  const fromHoriz = Math.asin(Math.min(1, Math.abs(Math.sin(ang))));
  if (fromHoriz < taperStart) {                 // nearly-horizontal breach
    len *= lateralBeam; w *= lateralBeam; inten *= lateralBeam;
  }
  emitToward(AX + Math.cos(ang) * len, AY + Math.sin(ang) * len, len,
    w, inten, hue, 0);
}
// short steep spikes straight out of the card top
for (let k = 0; k < 6; k++) {
  const ang = -Math.PI / 2 + rf(-0.42, 0.5);
  emitToward(AX + Math.cos(ang) * 500, AY + Math.sin(ang) * 500,
    rf(380, 560), rf(4, 7), rf(0.75, 1.2), rf(0.75, 1.0), 0);
}
// a couple of lateral breaches through the side borders (lower energy)
emitToward(WX - 160, WY + 130, 260, 5, 0.55, 0.35, 0, 0.55);
emitToward(WX + WW + 170, WY + 170, 240, 5, 0.5, 0.45, 0, 0.55);
// two dramatic shards of light that fly in FRONT of the window
for (let k = 0; k < 3; k++) {
  const ang = -Math.PI / 2 + rf(-1.0, 0.9);
  const len = rf(300, 620);
  emitToward(AX + Math.cos(ang) * len, AY + Math.sin(ang) * len, len,
    rf(8, 13), rf(0.8, 1.2), rf(0.15, 0.9), 1);
}

// precompute emitter segments (exit -> tip), in flat arrays for the hot loop
const SEGS: { x1: number; y1: number; x2: number; y2: number; w: number;
  i: number; cr: number; cg: number; cb: number; front: number;
  taper: number }[] =
  EMIT.map(e => {
    const c = Math.cos(e.ang), s = Math.sin(e.ang);
    const t = e.hue, [r, g, b] = ramp(t);
    return { x1: e.x, y1: e.y, x2: e.x + c * e.len, y2: e.y + s * e.len,
      w: e.w, i: e.i, cr: r, cg: g, cb: b, front: e.front, taper: e.taper };
  });
function ramp(t: number): [number, number, number] {
  // cyan -> violet-magenta -> warm gold as the beam travels outward
  if (t < 0.45) { const u = t / 0.45;
    return [0.25 + u * 0.75, 0.95 - u * 0.45, 1.0 - u * 0.05]; }
  const u = (t - 0.45) / 0.55;
  return [1.0, 0.5 - u * 0.05, 0.95 - u * 0.7];
}

// flying glass shards (polygons), some in front of the window
type Shard = { pts: number[][]; front: number; dep: number };
const SHARDS: Shard[] = [];
for (let k = 0; k < 22; k++) {
  const front = k < 8 ? 1 : 0;
  const upBias = rnd() * rnd();
  const ang = -Math.PI / 2 + (rnd() - 0.44) * 2.4;
  const dist = rf(120, 520) * (0.5 + upBias);
  const cx = AX + Math.cos(ang) * dist + rf(-30, 30);
  const cy = AY + Math.sin(ang) * dist * (front ? 0.85 : 0.95);
  const size = front ? rf(14, 34) : rf(9, 22);
  const rot = rnd() * Math.PI, nv = ri(3, 5), pts: number[][] = [];
  for (let v = 0; v < nv; v++) {
    const a2 = rot + v / nv * Math.PI * 2 + rf(-0.25, 0.25);
    const rr = size * rf(0.45, 1);
    pts.push([cx + Math.cos(a2) * rr, cy + Math.sin(a2) * rr * 0.7]);
  }
  SHARDS.push({ pts, front, dep: rf(0.25, 1) });
}
// sparks: bright dots with short motion streaks, trailing toward the source
type Spark = { x: number; y: number; a: number; len: number; b: number; front: number };
const SPARKS: Spark[] = [];
for (let k = 0; k < 150; k++) {
  const front = k < 40 ? 1 : 0;
  const ang = -Math.PI / 2 + (rnd() - 0.46) * 2.6;
  const dist = rf(60, 620) * (0.35 + rnd() * rnd());
  SPARKS.push({ x: AX + Math.cos(ang) * dist, y: AY + Math.sin(ang) * dist,
    a: ang, len: rf(6, 20), b: rf(0.4, 1), front });
}
// fine sparks: a denser, smaller class hugging the upward beam axis —
// reads as ember dust in the light column rather than scattered debris
const fineSparks: Spark[] = [];
for (let k = 0; k < 60; k++) {
  const front = k < 16 ? 1 : 0;
  const ang = -Math.PI / 2 + (rnd() - 0.5) * 0.7;   // tight to the axis
  const dist = rf(40, 480) * (0.3 + rnd() * rnd());
  fineSparks.push({ x: AX + Math.cos(ang) * dist + rf(-14, 14),
    y: AY + Math.sin(ang) * dist, a: ang, len: rf(3, 9), b: rf(0.25, 0.6), front });
}

// ---------------------------------------------------------------- 5x7 font
const GL: Record<string, number[]> = {
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 0, 16],
  ">": [4, 8, 16, 0, 16, 8, 4], "-": [0, 0, 0, 31, 0, 0, 0],
  "/": [1, 1, 2, 4, 8, 16, 16], "a": [0, 0, 14, 1, 15, 17, 15],
  "b": [16, 16, 23, 25, 17, 25, 23], "c": [0, 0, 15, 16, 16, 16, 15],
  "d": [1, 1, 13, 19, 17, 19, 13], "e": [0, 0, 15, 17, 31, 16, 15],
  "f": [6, 9, 8, 28, 8, 8, 8], "g": [0, 15, 17, 15, 1, 14, 0],
  "i": [4, 0, 12, 4, 4, 4, 14], "k": [16, 16, 21, 18, 20, 18, 17],
  "i2": [12, 4, 4, 4, 4, 4, 14], "l": [12, 4, 4, 4, 4, 4, 14],
  "m": [0, 0, 26, 21, 21, 17, 17], "n": [0, 0, 23, 25, 17, 17, 17],
  "o": [0, 0, 14, 17, 17, 17, 14], "p": [0, 0, 31, 17, 31, 16, 16],
  "r": [0, 0, 19, 21, 24, 16, 16], "s": [0, 0, 15, 16, 14, 1, 30],
  "t": [8, 8, 28, 8, 8, 9, 6], "u": [0, 0, 17, 17, 17, 19, 13],
  "w": [0, 0, 17, 17, 17, 21, 10], "A": [4, 10, 17, 31, 17, 17, 17],
  "C": [6, 9, 16, 16, 16, 9, 6], "E": [31, 16, 16, 30, 16, 16, 31],
  "F": [31, 16, 16, 30, 16, 16, 16], "I": [14, 4, 4, 4, 4, 4, 14],
  "K": [17, 18, 20, 24, 20, 18, 17], "M": [17, 21, 21, 21, 17, 17, 17],
  "O": [14, 17, 17, 17, 17, 17, 14], "R": [30, 17, 17, 30, 20, 18, 17],
  "S": [15, 16, 16, 14, 1, 1, 30], "T": [31, 4, 4, 4, 4, 4, 4],
};
function text(s: string, x0: number, y0: number, sc: number,
  col: (x: number, y: number) => void) {
  let x = x0;
  for (const ch of s) {
    const g = GL[ch] ?? GL[" "];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++)
      if (g[r] & (16 >> c)) for (let py = 0; py < sc; py++)
        for (let px = 0; px < sc; px++) col(x + c * sc + px, y0 + r * sc + py);
    x += 6 * sc;
  }
  return x;
}

// ---------------------------------------------------------------- buffers
const E = new Float32Array(N);                       // eruption energy (behind)
const CR = new Float32Array(N), CG = new Float32Array(N), CB = new Float32Array(N);
const E2 = new Float32Array(N);                      // front beams (over window)
const CR2 = new Float32Array(N), CG2 = new Float32Array(N), CB2 = new Float32Array(N);
const WR = new Float32Array(N), WG = new Float32Array(N), WB = new Float32Array(N), WA = new Float32Array(N);
WR.fill(0.04); WG.fill(0.05); WB.fill(0.08);                 // layer default (unused while A=0)

// white-hot core factor for a beam-path pixel: innermost 20% of the local
// half-width is pure white, fading to 0 by 50% (extracted verbatim from
// addField so the numerics stay identical)
function coreWhiteAt(d: number, hw: number): number {
  return d <= hw * 0.2 ? 1 : d >= hw * 0.5 ? 0 : (hw * 0.5 - d) / (hw * 0.3);
}
function addField(segs: typeof SEGS, Ea: Float32Array, CRa: Float32Array,
  CGa: Float32Array, CBa: Float32Array, skipScreen: boolean) {
  for (const s of segs) {
    const vx = s.x2 - s.x1, vy = s.y2 - s.y1, L2 = vx * vx + vy * vy;
    const pad = s.w + 4 + GMAX * 0.25;
    const x0 = Math.max(0, Math.min(s.x1, s.x2) - GMAX * 0.6) | 0;
    const x1 = Math.min(W - 1, Math.max(s.x1, s.x2) + GMAX * 0.6) | 0;
    const y0 = Math.max(0, Math.min(s.y1, s.y2) - GMAX * 0.6) | 0;
    const y1 = Math.min(H - 1, Math.max(s.y1, s.y2) + GMAX * 0.6) | 0;
    void pad;
    const invL2 = 1 / (L2 || 1);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - s.y1, row = y * W;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - s.x1;
        let u = (dx * vx + dy * vy) * invL2; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const px = dx - u * vx, py = dy - u * vy;
        const d = Math.sqrt(px * px + py * py);
        let v = coreAt(Math.max(0, d - s.w * (1 - u * 0.65))) * 1.35;
        v += softAt(d * d) * 0.07 * (1 - u * 0.35);
        if (v <= 0.002) continue;
        const i = row + x;
        // back beams only exist OUTSIDE the screen: the window clips them
        if (skipScreen && x >= SX - 2 && x < SX + SW + 2 && y >= SY - 2 && y < SY + SH + 2) continue;
        const amt = v * s.i;
        const dark = 0.72 - 0.35 * u;                 // mid-fan keeps its hue
        Ea[i] += amt;
        // white-hot core: innermost 20% of beam width is pure white,
        // fading white -> accent over the next 30% (no brightness change)
        const hw = s.w * (1 - u * 0.65) || 1;
        const wm = coreWhiteAt(d, hw);
        if (wm > 0 && s.taper === 0) {                // lateral breaches stay tinted
          CRa[i] += amt * ((s.cr * dark) * (1 - wm) + wm);
          CGa[i] += amt * ((s.cg * dark) * (1 - wm) + wm);
          CBa[i] += amt * ((s.cb * dark) * (1 - wm) + wm);
        } else {
          CRa[i] += amt * s.cr * dark; CGa[i] += amt * s.cg * dark; CBa[i] += amt * s.cb * dark;
        }
      }
    }
  }
}
addField(SEGS.filter(s => !s.front), E, CR, CG, CB, true);

// broad glow from the screen itself — breaches the whole card edge
(function screenHalo() {
  const cx = (SX + SW / 2) | 0, cy = (SY + SH / 2) | 0;
  const rad = 520;
  for (let y = Math.max(0, cy - rad); y < Math.min(H, cy + rad); y++) {
    for (let x = Math.max(0, cx - rad); x < Math.min(W, cx + rad); x++) {
      const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy) * 1.35; // squashed
      const v = softAt(d2) * 0.07;
      if (v <= 0.003) continue;
      const i = y * W + x;
      E[i] += v; CR[i] += v * 0.55; CG[i] += v * 0.9; CB[i] += v * 1.0;
    }
  }
})();

drawSparks(0);
drawShards(0);

// ---------------------------------------------------------------- window
box(WX, WY, WX + WW, WY + WH, i => { WA[i] = 1; });
function box(x0: number, y0: number, x1: number, y1: number,
  f: (i: number) => void) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) f(y * W + x);
}
// frame: charcoal metal, top-lit
box(WX, WY, WX + WW, WY + WH, i => {
  WR[i] = 0.13; WG[i] = 0.145; WB[i] = 0.19; WA[i] = 1;
});
box(WX, WY, WX + WW, WY + 6, i => { WR[i] = 0.22; WG[i] = 0.24; WB[i] = 0.3; });
box(WX + 6, WY + 6, WX + WW - 6, WY + WH - 2, i => {
  WR[i] = 0.1; WG[i] = 0.11; WB[i] = 0.15;
});
// inner bevel
box(WX + BW - 3, WY + BW + 33, WX + WW - BW + 3, WY + WH - 12, i => {
  WR[i] = 0.05; WG[i] = 0.06; WB[i] = 0.085;
});
// title bar + traffic lights
box(SX - BW, WY + BW, SX + SW + BW, WY + BW + 36, i => {
  WR[i] = 0.16; WG[i] = 0.175; WB[i] = 0.23;
});
const LIGHTS: [number, number, number, string][] =
  [[0.95, 0.3, 0.55, "r"], [0.98, 0.75, 0.25, "y"], [0.4, 0.9, 0.55, "g"]];
LIGHTS.forEach((c, k) => {
  const cx0 = WX + 22 + k * 26, cy0 = WY + BW + 18;
  box(cx0 - 6, cy0 - 6, cx0 + 6, cy0 + 6, i => {
    const dx = (i % W) - cx0, dy = ((i / W) | 0) - cy0;
    if (dx * dx + dy * dy <= 30) { WR[i] = c[0]; WG[i] = c[1]; WB[i] = c[2]; }
  });
});
// screen: deep navy, scanlines, edge gradient (opaque layer)
box(SX, SY, SX + SW, SY + SH, i => {
  const x = i % W, y = (i / W) | 0;
  const ex = Math.min(x - SX, SX + SW - x), ey = Math.min(y - SY, SY + SH - y);
  const edge = Math.min(1, (ex + ey) / 60);
  WR[i] = 0.015 + 0.03 * edge; WG[i] = 0.025 + 0.06 * edge; WB[i] = 0.05 + 0.12 * edge;
  if ((y % 3) === 0) { WR[i] *= 0.75; WG[i] *= 0.75; WB[i] *= 0.75; }
  WA[i] = 1;
});
// prompt lines inside the screen (dim, so the hero text reads)
const scr = (sx: number, sy: number, len: number, r: number, g: number, b: number) => {
  box(sx, sy, sx + len, sy + 2, i => { WR[i] = r; WG[i] = g; WB[i] = b; });
};
text("> MAKE render --seed 7", SX + 14, SY + 12, 2, (x, y) =>
  { if (x < SX + SW - 4 && y < SY + SH) { const i = y * W + x; WR[i] = 0.35; WG[i] = 0.8; WB[i] = 0.85; } });
text("/output/entry.png", SX + 26, SY + 34, 2, (x, y) =>
  { if (x < SX + SW - 4 && y < SY + SH) { const i = y * W + x; WR[i] = 0.45; WG[i] = 0.3; WB[i] = 0.7; } });
scr(SX + 26, SY + 54, 120, 0.2, 0.45, 0.5);
scr(SX + 26, SY + 62, 76, 0.18, 0.35, 0.42);
// eruption glow washing the screen content — strongest near the source,
// fading upward so the hero text stays crisp against a darker screen
box(SX, SY, SX + SW, SY + SH, i => {
  const x = i % W, y = (i / W) | 0;
  const dd = Math.hypot(x - AX, y - AY);
  const prox = Math.max(0, 1 - dd / 70);
  const t = Math.min(0.5, Math.sqrt(E[i]) * 0.08) * prox * prox;
  if (t < 0.01) return;
  WR[i] += t * 0.8; WG[i] += t * 0.95; WB[i] += t * 1.0;
});
// hero text — big pixel glyphs, warm white core
text("it is awake.", SX + 18, SY + 78, 4, (x, y) => {
  if (x < SX + SW - 4 && y < SY + SH) { const i = y * W + x;
    WR[i] = 1; WG[i] = 0.98; WB[i] = 0.9; WA[i] = 1; }
});
// prompt line at the bottom: "> MAKE" then a cyan cursor block
text("> MAKE", SX + 14, AY - 14, 3, (x, y) => {
  if (y < SY + SH - 6) { const i = y * W + x; WR[i] = 0.5; WG[i] = 0.95; WB[i] = 0.95; }
});
box(SX + 14 + 6 * 18 + 2, AY - 14, SX + 14 + 6 * 18 + 2 + 15, AY - 14 + 21,
  i => { WR[i] = 0.3; WG[i] = 1; WB[i] = 0.95; });
// glow washing the frame edges near each breach point
for (const s of SEGS) {
  const bx = s.x1 | 0, by = s.y1 | 0;
  for (let y = WY - 8; y < WY + WH + 8; y++) {
    for (let x = WX - 8; x < WX + WW + 8; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const inFrame = (x >= WX && x < WX + WW && y >= WY && y < WY + WH);
      if (!inFrame) continue;
      if (x >= SX && x < SX + SW && y >= SY && y < SY + SH) continue;  // screen handled separately
      const d2 = (x - bx) * (x - bx) + (y - by) * (y - by);
      if (d2 > 90 * 90) continue;
      const i = y * W + x;
      if (WA[i] <= 0) continue;                    // only wash the metal frame
      const v = softAt(d2) * 1.1;
      WR[i] += v * 1.0; WG[i] += v * 0.85; WB[i] += v * 0.7;
    }
  }
}

// front beams + sparks on top of the window layer
addField(SEGS.filter(s => s.front), E2, CR2, CG2, CB2, false);

// spark dots with streaks
function drawSparks(front: number) {
  for (const sp of [...SPARKS, ...fineSparks]) {
    if (sp.front !== front) continue;
    const c = Math.cos(sp.a), s = Math.sin(sp.a);
    for (let t = 0; t < sp.len; t += 1.5) {
      const x = (sp.x - c * t) | 0, y = (sp.y - s * t) | 0;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const a = sp.b * (1 - t / sp.len) * 0.9;
      const i = y * W + x;
      if (a > WA[i]) { WA[i] = a; WR[i] = 1; WG[i] = 0.95; WB[i] = 0.8; }
      if (t === 0) { E[i] += sp.b; CR[i] += sp.b; CG[i] += sp.b; CB[i] += sp.b; }
    }
  }
}

// shard polygons: faceted, one bright edge, dark navy glass, back in front
function drawShards(front: number) {
  for (const sh of SHARDS) {
    if (sh.front !== front) continue;
    const pts = sh.pts;
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const p of pts) { minx = Math.min(minx, p[0]); maxx = Math.max(maxx, p[0]); miny = Math.min(miny, p[1]); maxy = Math.max(maxy, p[1]); }
    for (let y = Math.max(0, miny | 0); y <= Math.min(H - 1, maxy | 0); y++) {
      const xs: number[] = [];
      for (let k = 0; k < pts.length; k++) {
        const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length];
        if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y))
          xs.push(x1 + (y - y1) / (y2 - y1) * (x2 - x1));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let x = Math.max(0, xs[k] | 0); x <= Math.min(W - 1, xs[k + 1]); x++) {
          const i = y * W + x;
          const warm = h2(x, y, 31) > 0.86;
          WR[i] = Math.max(WR[i], warm ? 0.95 : 0.12 + sh.dep * 0.1);
          WG[i] = Math.max(WG[i], warm ? 0.9 : 0.25 + sh.dep * 0.15);
          WB[i] = Math.max(WB[i], warm ? 0.6 : 0.42 + sh.dep * 0.2);
          WA[i] = 1;
        }
    }
    for (let k = 0; k < pts.length; k++) {          // bright edge
      const [x1, y1] = pts[k], [x2, y2] = pts[(k + 1) % pts.length];
      const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
      for (let t = 0; t <= steps; t++) {
        const x = (x1 + (x2 - x1) * t / steps) | 0, y = (y1 + (y2 - y1) * t / steps) | 0;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        WR[i] = Math.max(WR[i], 0.9); WG[i] = Math.max(WG[i], 0.95); WB[i] = Math.max(WB[i], 1);
        E[i] += 0.25; CR[i] += 0.1; CG[i] += 0.3; CB[i] += 0.4;
      }
    }
  }
}
drawShards(0);
drawSparks(1);
drawShards(1);

// ---------------------------------------------------------------- compose
// per-frame body of the top-level render pass, wrapped by name so the
// draw loop has an explicit call site (behavior identical)
const out = Buffer.alloc(N * 3);
const BGR = 0.028, BGG = 0.042, BGB = 0.09;          // deep navy void
function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = h2(xi, yi, z), b = h2(xi + 1, yi, z), c = h2(xi, yi + 1, z), d = h2(xi + 1, yi + 1, z);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function mainLoop() {
for (let y = 0; y < H; y++) {
  const fy = y / H, row = y * W;
  // dark weighted ground: everything below the card sinks
  const ground = fy > 0.72 ? Math.max(0.12, 1 - (fy - 0.72) / 0.32 * 1.15) : 1;
  for (let x = 0; x < W; x++) {
    const i = row + x;
    const fx = x / W;
    let vr = BGR, vg = 0.038 + 0.04 * (1 - fy) * (0.6 + 0.4 * Math.abs(fx - 0.5) * 2), vb = BGB;
    // band gradient + dither
    const bands = 0.02 * Math.sin(fy * 46 + vnoise(x * 0.02, y * 0.02, 7) * 4);
    vr += bands * 0.5; vg += bands * 0.8; vb += bands;
    // rare stars
    const sh = h2(x, y, 11);
    if (sh > 0.99975) { vr += 0.5; vg += 0.7; vb += 0.75; }
    else if (sh < 0.00025 && fy > 0.15) { vr += 0.28; vg += 0.14; vb += 0.34; }
    // vignette
    const dx = (x - W / 2) / W, dy = (y - H / 2) / H;
    const vig = Math.max(0.52, 1 - (dx * dx + dy * dy) * 1.7);
    // eruption light
    let e = E[i] * ground;
    const tone = 1 - Math.exp(-e * 1.9);
    let cr = vr, cg = vg, cb = vb;
    if (e > 0.001) {
      const ir = CR[i] / e, ig = CG[i] / e, ib = CB[i] / e;
      const L = 0.25 + 0.5 * Math.min(e, 1.6);
      cr = vr * (1 - tone) + ir * L * tone * 1.45;
      cg = vg * (1 - tone) + ig * L * tone * 1.45;
      cb = vb * (1 - tone) + ib * L * tone * 1.45;
      const over = Math.max(0, e - 2.3) * 0.5; cr += over * 0.7; cg += over * 0.8; cb += over;
    }
    // window layer over everything (already holds breach wash)
    if (WA[i] > 0) {
      cr = cr * (1 - WA[i]) + WR[i] * WA[i]; cg = cg * (1 - WA[i]) + WG[i] * WA[i];
      cb = cb * (1 - WA[i]) + WB[i] * WA[i];
    }
    cr *= vig; cg *= vig; cb *= vig;
    // front beams crossing over the frame (additive, unclipped)
    const e2 = E2[i];
    if (e2 > 0.001) {
      const t2 = Math.min(0.55, e2 * 0.45) + Math.max(0, e2 - 1.2) * 0.5;
      cr += t2 * (0.55 + 0.45 * CR2[i] / e2); cg += t2 * 0.85; cb += t2;
    }
    const d = (h2(x, y, 5) - 0.5) / 255 + (h2(x, y, 97) - 0.5) / 400;
    const o = i * 3;
    out[o] = Math.max(0, Math.min(255, Math.round(cr * 255 + d * 255)));
    out[o + 1] = Math.max(0, Math.min(255, Math.round(cg * 255 + d * 255)));
    out[o + 2] = Math.max(0, Math.min(255, Math.round(cb * 255 + d * 255)));
  }
}
}
// existing top-level draw loop call site -> named mainLoop body
mainLoop();

// ---------------------------------------------------------------- PNG out
const CRC_T = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_T[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let n = 0; n < buf.length; n++) c = CRC_T[(c ^ buf[n]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "ascii");
  data.copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
const bpp = 3, stride = W * bpp;
const raw = Buffer.alloc(H * (stride + 1));
const prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
for (let y = 0; y < H; y++) {
  out.copy(cur, 0, y * stride, (y + 1) * stride);
  let bestF = 0, bestSum = Infinity;
  for (let f = 0; f < 5; f++) {
    let sum = 0;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let p: number;
      if (f === 0) p = cur[x]; else if (f === 1) p = cur[x] - a;
      else if (f === 2) p = cur[x] - b; else if (f === 3) p = cur[x] - ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        p = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      const v = p & 255; sum += v < 128 ? v : 256 - v;
    }
    if (sum < bestSum) { bestSum = sum; bestF = f; }
  }
  const off = y * (stride + 1);
  raw[off] = bestF;
  for (let x = 0; x < stride; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
    let p: number;
    if (bestF === 0) p = cur[x]; else if (bestF === 1) p = cur[x] - a;
    else if (bestF === 2) p = cur[x] - b; else if (bestF === 3) p = cur[x] - ((a + b) >> 1);
    else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      p = cur[x] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
    raw[off + 1 + x] = p & 255;
  }
  prev.set(cur);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const dir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/entry.png`, png);
console.log(`entry.png ${png.length} bytes -> ${dir}`);
