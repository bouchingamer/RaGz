// Ragdoll - G shoves the character in front of you, Shift+G knocks over everyone nearby.
// The game's own characters can't be bent (their body parts are not exposed), so while a character is knocked down the original is hidden
// and replaced by a ragdoll puppet: an articulated skeleton (Verlet physics) that tumbles off the floor and the maze walls, then gets up.
const g = windz.game, THREE = windz.THREE;
const C = (k, d) => mod.getConfig(k, d);
const KEY = C('key', 'KeyG');
const bus = windz.bus = windz.bus || (() => { const h = {}; return { on(e, f) { (h[e] = h[e] || []).push(f); }, emit(e, ...a) { (h[e] || []).forEach(f => { try { f(...a); } catch (x) { console.error(x); } }); } }; })();

/* =========================== sound =========================== */
let ac = null, lastThud = 0;
function tone(f0, f1, dur, type, vol) {
  if (!C('sound', true) || vol <= .002) return;
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), gn = ac.createGain(), t = ac.currentTime;
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    gn.gain.setValueAtTime(vol, t); gn.gain.exponentialRampToValueAtTime(.0001, t + dur); o.connect(gn); gn.connect(ac.destination); o.start(t); o.stop(t + dur);
  } catch (e) {}
}
function thud(speed, x, z) {
  const now = performance.now(); if (now - lastThud < 70 || speed < 3.5) return; lastThud = now;
  const P = g.player, d = P ? Math.hypot(P.x - x, P.z - z) / g.tileSize : 0;
  tone(95, 38, .16, 'sine', .13 * Math.min(1, speed / 12) * Math.max(0, 1 - d / 12));
}

/* =========================== the skeleton =========================== */
// Standing pose in local units (facing +z, the character's left is +x), about 1.8 tall.
const POSE = {
  head: [0, 1.68, 0], neck: [0, 1.5, 0], shL: [.2, 1.46, 0], shR: [-.2, 1.46, 0], chest: [0, 1.25, .12], back: [0, 1.25, -.12], pelvis: [0, .98, 0], hipL: [.1, .94, 0], hipR: [-.1, .94, 0],
  elL: [.25, 1.18, 0], haL: [.27, .92, 0], elR: [-.25, 1.18, 0], haR: [-.27, .92, 0], knL: [.11, .5, 0], ftL: [.11, .06, 0], knR: [-.11, .5, 0], ftR: [-.11, .06, 0]
};
const NAMES = Object.keys(POSE), IDX = {}; NAMES.forEach((n, i) => IDX[n] = i);
const RADIUS = { head: .13, neck: .08, shL: .07, shR: .07, chest: .09, back: .09, pelvis: .1, hipL: .08, hipR: .08, elL: .05, haL: .06, elR: .05, haR: .06, knL: .06, ftL: .07, knR: .06, ftR: .07 };
const TORSO = ['neck', 'shL', 'shR', 'chest', 'back', 'pelvis', 'hipL', 'hipR'];
const STICKS = [];                                       // [a, b] pairs that keep their length
for (let i = 0; i < TORSO.length; i++) for (let j = i + 1; j < TORSO.length; j++) STICKS.push([TORSO[i], TORSO[j]]);
STICKS.push(['head', 'neck'], ['head', 'shL'], ['head', 'shR'], ['shL', 'elL'], ['elL', 'haL'], ['shR', 'elR'], ['elR', 'haR'], ['hipL', 'knL'], ['knL', 'ftL'], ['hipR', 'knR'], ['knR', 'ftR']);
const MINS = [['shL', 'haL', .3], ['shR', 'haR', .3], ['hipL', 'ftL', .35], ['hipR', 'ftR', .35], ['head', 'pelvis', .75]];   // limbs cannot fold completely
const GRAV = -22, STEP = 1 / 60, ITER = 14;

function standingPoints(cx, gy, cz, yaw, s) {
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  return NAMES.map(n => { const [lx, ly, lz] = POSE[n]; return [cx + (lx * c + lz * sn) * s, gy + ly * s, cz + (-lx * sn + lz * c) * s]; });
}
function wallAt(x, z) { const m = g.map, T = g.tileSize, cx = Math.floor(x / T), cz = Math.floor(z / T); return !m || !m[cz] || m[cz][cx] === undefined || m[cz][cx] !== 0; }
function inMaze(x, z) { const T = g.tileSize, W = g.gridSize, cx = Math.floor(x / T), cz = Math.floor(z / T); return cx >= 0 && cz >= 0 && cx < W && cz < W; }
let ceilCache = null;
function ceilingY() {
  try { if (typeof ce === 'object' && ce && ce.visible !== false) { if (!ceilCache || ceilCache.o !== ce) { ce.updateMatrixWorld(true); ceilCache = { o: ce, y: new THREE.Box3().setFromObject(ce).max.y }; } if (ceilCache.y > 1.5 && ceilCache.y < 40) return ceilCache.y; } } catch (e) {}
  return 40;
}

class Body {
  constructor(cx, gy, cz, yaw, s, vel) {
    this.s = s; this.gy = gy; this.ceil = ceilingY();
    const pos = standingPoints(cx, gy, cz, yaw, s);
    this.p = pos.map((q, i) => ({ x: q[0], y: q[1], z: q[2], px: q[0], py: q[1], pz: q[2], r: RADIUS[NAMES[i]] * s }));
    const P = n => this.p[IDX[n]], len = (a, b) => Math.hypot(P(a).x - P(b).x, P(a).y - P(b).y, P(a).z - P(b).z);
    this.sticks = STICKS.map(([a, b]) => [IDX[a], IDX[b], len(a, b)]);
    this.mins = MINS.map(([a, b, f]) => {
      let full; if (a === 'head') full = len('head', 'pelvis');
      else { const m = { shL: 'elL', shR: 'elR', hipL: 'knL', hipR: 'knR' }[a]; full = len(a, m) + len(m, b); }
      return [IDX[a], IDX[b], f * full];
    });
    this.t = 0;
    if (vel) this.launch(vel);
  }
  launch(v) {                                          // v = [vx, vy, vz] in units/second, plus a random tumble
    this.p.forEach((q, i) => {
      const w = NAMES[i], spin = (w === 'head' || w.startsWith('ha') || w.startsWith('ft')) ? 2.6 : 1.2;
      const vx = v[0] + (Math.random() - .5) * spin * 2, vy = v[1] + (Math.random() - .3) * spin, vz = v[2] + (Math.random() - .5) * spin * 2;
      q.px = q.x - vx * STEP; q.py = q.y - vy * STEP; q.pz = q.z - vz * STEP;
    });
  }
  step() {
    const p = this.p, h2 = STEP * STEP, T = g.tileSize;
    for (const q of p) {                               // verlet integration (with a speed cap so nothing tunnels through a wall)
      let vx = (q.x - q.px) * .998, vy = (q.y - q.py) * .998, vz = (q.z - q.pz) * .998; const sp = Math.hypot(vx, vy, vz), cap = T * .22;
      if (sp > cap) { const k = cap / sp; vx *= k; vy *= k; vz *= k; }
      q.px = q.x; q.py = q.y; q.pz = q.z; q.x += vx; q.y += vy + GRAV * h2; q.z += vz;
    }
    for (let it = 0; it < ITER; it++) {
      for (const [a, b, L] of this.sticks) {
        const A = p[a], B = p[b]; let dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z; const d = Math.hypot(dx, dy, dz) || 1e-6, k = (d - L) / d * .5;
        dx *= k; dy *= k; dz *= k; A.x += dx; A.y += dy; A.z += dz; B.x -= dx; B.y -= dy; B.z -= dz;
      }
      for (const [a, b, mn] of this.mins) {
        const A = p[a], B = p[b]; let dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z; const d = Math.hypot(dx, dy, dz) || 1e-6;
        if (d < mn) { const k = (d - mn) / d * .5; dx *= k; dy *= k; dz *= k; A.x += dx; A.y += dy; A.z += dz; B.x -= dx; B.y -= dy; B.z -= dz; }
      }
      for (const q of p) this.collide(q);
    }
    this.t += STEP;
  }
  collide(q) {
    const fl = this.gy + q.r;
    if (q.y < fl) {                                    // floor: bounce a little, scrub sideways speed
      const impact = q.py - q.y; q.y = fl; q.py = q.y + Math.max(0, impact) * .18;
      q.px = q.x - (q.x - q.px) * .86; q.pz = q.z - (q.z - q.pz) * .86; if (impact > .05) this.hit = Math.max(this.hit || 0, impact / STEP);
    }
    if (q.y > this.ceil - q.r) { q.y = this.ceil - q.r; q.py = q.y; }
    if (!inMaze(q.x, q.z)) return;
    const T = g.tileSize, cx = Math.floor(q.x / T), cz = Math.floor(q.z / T);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = cx + dx, Z = cz + dz; if (!wallAt((X + .5) * T, (Z + .5) * T)) continue;
      const x0 = X * T, x1 = x0 + T, z0 = Z * T, z1 = z0 + T, nx = Math.max(x0, Math.min(q.x, x1)), nz = Math.max(z0, Math.min(q.z, z1)); let ddx = q.x - nx, ddz = q.z - nz, d = Math.hypot(ddx, ddz);
      if (d < q.r) {
        if (d < 1e-6) { const l = q.x - x0, r = x1 - q.x, t = q.z - z0, b = z1 - q.z, m = Math.min(l, r, t, b); ddx = ddz = 0; if (m === l) ddx = -1; else if (m === r) ddx = 1; else if (m === t) ddz = -1; else ddz = 1; d = 0; q.x += ddx * (m + q.r); q.z += ddz * (m + q.r); }
        else { const k = (q.r - d) / d; q.x += ddx * k; q.z += ddz * k; }
        q.px = q.x - (q.x - q.px) * .7; q.pz = q.z - (q.z - q.pz) * .7;
      }
    }
  }
  pelvis() { return this.p[IDX.pelvis]; }
  speed() { let s = 0; for (const q of this.p) s += Math.hypot(q.x - q.px, q.y - q.py, q.z - q.pz); return s / this.p.length / STEP; }
}

/* =========================== puppets (visual models) =========================== */
const LOOKS = {
  player: { skin: 0xf1c9a5, top: 0x2563eb, bottom: 0x1f2937, shoes: 0x111827, hair: 0x5b3a1a, extra: 'backpack' },
  windz: { skin: 0xe8b89a, top: 0x2b2d42, bottom: 0x2b2d42, shoes: 0x111111, extra: 'suit' },
  principal: { skin: 0xd9a066, top: 0x1e3a5f, bottom: 0x1e3a5f, shoes: 0x111111, extra: 'cap' },
  playtime: { skin: 0xf1c9a5, top: 0xf472b6, bottom: 0xfbbf24, shoes: 0xdc2626, hair: 0xf97316, extra: 'pigtails', dress: true },
  nurse: { skin: 0xf5c9a6, top: 0xf8fafc, bottom: 0xf8fafc, shoes: 0xf8fafc, extra: 'nursecap', dress: true },
  scout: { skin: 0xd9a066, top: 0x4d7c0f, bottom: 0x4d7c0f, shoes: 0x78350f, extra: 'scouthat' },
  sam: { skin: 0xf1c9a5, top: 0x7c3aed, bottom: 0x4c1d95, shoes: 0x111827, extra: 'cap2' },
  sal: { skin: 0xf1c9a5, top: 0xf97316, bottom: 0xc2410c, shoes: 0x111827, extra: 'bow', dress: true }
};
const mat = (c, e) => new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: e == null ? .3 : e, roughness: .85 });
const basic = c => new THREE.MeshBasicMaterial({ color: c });
const mesh = (geo, m, x, y, z) => { const o = new THREE.Mesh(geo, m); o.position.set(x || 0, y || 0, z || 0); return o; };
const Y = new THREE.Vector3(0, 1, 0), V = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4() };

function makePuppet(look, s) {
  const root = new THREE.Group(), skin = mat(look.skin), top = mat(look.top), bot = mat(look.bottom);
  const cyl = (r, m) => { const c = mesh(new THREE.CylinderGeometry(r * s, r * s * .9, 1, 10), m); root.add(c); return c; };
  const ball = (r, m) => { const b = mesh(new THREE.SphereGeometry(r * s, 10, 8), m); root.add(b); return b; };
  const parts = {
    uArmL: cyl(.055, top), fArmL: cyl(.048, top), uArmR: cyl(.055, top), fArmR: cyl(.048, top),
    thL: cyl(.075, bot), shL: cyl(.062, bot), thR: cyl(.075, bot), shR: cyl(.062, bot),
    handL: ball(.06, skin), handR: ball(.06, skin), footL: ball(.075, mat(look.shoes)), footR: ball(.075, mat(look.shoes)),
    elL: ball(.052, top), elR: ball(.052, top), knL: ball(.066, bot), knR: ball(.066, bot)
  };
  // torso group (aligned with the body, so tie / backpack / whistle can be attached in real units)
  const torso = new THREE.Group(); root.add(torso);
  const tb = mesh(look.dress ? new THREE.CylinderGeometry(.62, 1, 1, 14) : new THREE.BoxGeometry(1, 1, 1), top); torso.add(tb);
  if (look.dress) torso.userData.dressBottom = mat(look.bottom);
  const head = new THREE.Group(); root.add(head);
  head.add(mesh(new THREE.SphereGeometry(.13 * s, 16, 12), skin));
  [-1, 1].forEach(d => { head.add(mesh(new THREE.SphereGeometry(.028 * s, 8, 6), basic(0xffffff), d * .05 * s, .02 * s, .115 * s)); head.add(mesh(new THREE.SphereGeometry(.014 * s, 8, 6), basic(0x111111), d * .05 * s, .02 * s, .14 * s)); });
  head.add(mesh(new THREE.BoxGeometry(.07 * s, .012 * s, .01 * s), basic(0x7a2a2a), 0, -.05 * s, .125 * s));
  if (look.hair) head.add(mesh(new THREE.SphereGeometry(.14 * s, 14, 10, 0, Math.PI * 2, 0, Math.PI * .58), mat(look.hair), 0, .008 * s, -.006 * s));
  const ex = look.extra;
  if (ex === 'backpack') torso.add(mesh(new THREE.BoxGeometry(.3 * s, .38 * s, .15 * s), mat(0xdc2626), 0, -.02 * s, -.19 * s));
  if (ex === 'suit') { torso.add(mesh(new THREE.BoxGeometry(.06 * s, .34 * s, .02 * s), mat(0xdc2626), 0, .02 * s, .125 * s)); torso.add(mesh(new THREE.BoxGeometry(.13 * s, .12 * s, .015 * s), mat(0xf8fafc), 0, .21 * s, .124 * s)); }
  if (ex === 'cap') { head.add(mesh(new THREE.CylinderGeometry(.12 * s, .14 * s, .08 * s, 14), mat(0x0f2742), 0, .13 * s, 0)); head.add(mesh(new THREE.BoxGeometry(.2 * s, .012 * s, .1 * s), mat(0x0f2742), 0, .1 * s, .14 * s)); torso.add(mesh(new THREE.BoxGeometry(.04 * s, .05 * s, .02 * s), mat(0xcbd5e1), .05 * s, .1 * s, .125 * s)); }
  if (ex === 'pigtails') [-1, 1].forEach(d => head.add(mesh(new THREE.SphereGeometry(.05 * s, 8, 6), mat(0xf97316), d * .16 * s, -.03 * s, -.02 * s)));
  if (ex === 'nursecap') { head.add(mesh(new THREE.CylinderGeometry(.1 * s, .12 * s, .07 * s, 14), mat(0xffffff), 0, .13 * s, 0)); head.add(mesh(new THREE.BoxGeometry(.05 * s, .02 * s, .01 * s), basic(0xdc2626), 0, .13 * s, .12 * s)); head.add(mesh(new THREE.BoxGeometry(.02 * s, .05 * s, .01 * s), basic(0xdc2626), 0, .13 * s, .12 * s)); }
  if (ex === 'scouthat') { head.add(mesh(new THREE.CylinderGeometry(.2 * s, .2 * s, .015 * s, 16), mat(0xa16207), 0, .1 * s, 0)); head.add(mesh(new THREE.CylinderGeometry(.1 * s, .12 * s, .09 * s, 14), mat(0xa16207), 0, .15 * s, 0)); }
  if (ex === 'cap2') head.add(mesh(new THREE.CylinderGeometry(.13 * s, .14 * s, .06 * s, 14), mat(0x4c1d95), 0, .12 * s, 0));
  if (ex === 'bow') [-1, 1].forEach(d => head.add(mesh(new THREE.ConeGeometry(.05 * s, .1 * s, 8), mat(0xfb7185), d * .06 * s, .15 * s, 0)));
  let ruler = null; if (ex === 'suit') { ruler = mesh(new THREE.BoxGeometry(.03 * s, 1, .008 * s), mat(0xb45309)); root.add(ruler); }
  const skirt = look.dress ? mesh(new THREE.CylinderGeometry(.9, 1.35, 1, 14), bot) : null; if (skirt) torso.add(skirt);
  return { root, parts, torso, tb, head, ruler, skirt, s, look };
}
function seg(m, a, b) {                                  // stretch a unit-height cylinder from point a to point b
  V.a.set(b.x - a.x, b.y - a.y, b.z - a.z); const len = V.a.length() || 1e-4;
  m.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2); m.quaternion.setFromUnitVectors(Y, V.a.multiplyScalar(1 / len)); m.scale.set(1, len, 1);
}
function basis(group, up, across, flipForward) {          // orient a group: y = up, x = across, z = forward
  V.b.copy(up).normalize(); V.a.copy(across); V.c.crossVectors(V.a, V.b).normalize(); V.a.crossVectors(V.b, V.c).normalize();
  V.m.makeBasis(V.a, V.b, V.c); group.quaternion.setFromRotationMatrix(V.m);
}
function updatePuppet(pu, body) {
  const p = body.p, g3 = n => p[IDX[n]], s = pu.s, P = pu.parts;
  seg(P.uArmL, g3('shL'), g3('elL')); seg(P.fArmL, g3('elL'), g3('haL')); seg(P.uArmR, g3('shR'), g3('elR')); seg(P.fArmR, g3('elR'), g3('haR'));
  seg(P.thL, g3('hipL'), g3('knL')); seg(P.shL, g3('knL'), g3('ftL')); seg(P.thR, g3('hipR'), g3('knR')); seg(P.shR, g3('knR'), g3('ftR'));
  [['handL', 'haL'], ['handR', 'haR'], ['footL', 'ftL'], ['footR', 'ftR'], ['elL', 'elL'], ['elR', 'elR'], ['knL', 'knL'], ['knR', 'knR']].forEach(([m, n]) => P[m].position.set(g3(n).x, g3(n).y, g3(n).z));
  const neck = g3('neck'), pel = g3('pelvis'), shL = g3('shL'), shR = g3('shR');
  V.a.set(neck.x - pel.x, neck.y - pel.y, neck.z - pel.z); const tl = V.a.length(), up = V.a.clone(), across = new THREE.Vector3(shL.x - shR.x, shL.y - shR.y, shL.z - shR.z);
  pu.torso.position.set((neck.x + pel.x) / 2, (neck.y + pel.y) / 2, (neck.z + pel.z) / 2); basis(pu.torso, up, across);
  pu.tb.scale.set(across.length() + .08 * s, tl + .12 * s, .24 * s);
  if (pu.skirt) { pu.skirt.position.set(0, -tl / 2 - .14 * s, 0); pu.skirt.scale.set(.2 * s, .36 * s, .2 * s); }
  const hd = g3('head'); V.a.set(hd.x - neck.x, hd.y - neck.y, hd.z - neck.z); pu.head.position.set(hd.x, hd.y, hd.z); basis(pu.head, V.a.clone(), across);
  if (pu.ruler) { const h = g3('haR'), e = g3('elR'); V.a.set(h.x - e.x, h.y - e.y, h.z - e.z).normalize(); const end = { x: h.x + V.a.x * .35 * s, y: h.y + V.a.y * .35 * s, z: h.z + V.a.z * .35 * s }; seg(pu.ruler, h, end); }
}
function disposePuppet(pu) { if (pu.root.parent) pu.root.parent.remove(pu.root); pu.root.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }

/* =========================== targets, ragdolls in progress =========================== */
const active = [];                                       // { kind, tgt, body, puppet, dur, phase, riseT, yaw, home, s }
let cooldown = 0, shockCooldown = 0, clock = 0;
function gameTargets() {
  const out = [];
  [['windz', g.mrWindz], ['principal', g.principal], ['playtime', g.playtime]].forEach(([k, o]) => { if (o && o.position && o.visible !== false) out.push({ kind: k, obj: o, game: true, get x() { return o.position.x; }, get z() { return o.position.z; } }); });
  if (windz.characters && windz.characters.list) windz.characters.list.forEach(c => { if (c.active && c.obj && c.obj.visible !== false) out.push({ kind: c.id, obj: c.obj, res: c, x: c.x, z: c.z }); });
  return out.filter(t => !active.some(a => a.tgt.obj === t.obj));
}
function heightOf(obj) { try { obj.updateMatrixWorld(true); const sz = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3()); if (sz.y > .3 && sz.y < 20) return sz.y; } catch (e) {} return 1.8; }
function groundY() { return (g.mrWindz && Number.isFinite(g.mrWindz.position.y)) ? g.mrWindz.position.y : 0; }
function knockDown(t, dir, strength) {
  const P = g.player, stun = t.kind === 'windz' ? C('windzStun', 5) : C('otherStun', 6), s = Math.max(.5, Math.min(3, heightOf(t.obj) / 1.8)), f = C('force', 1) * strength;
  const body = new Body(t.x, groundY(), t.z, Math.atan2(dir.x, dir.z) + Math.PI, s, [dir.x * 9 * f * Math.sqrt(s), 5.5 * f * Math.sqrt(s), dir.z * 9 * f * Math.sqrt(s)]);
  const pu = makePuppet(LOOKS[t.kind] || LOOKS.player, s); (g.scene).add(pu.root);
  if (t.res) { t.res.lead = null; }
  active.push({ kind: t.kind, tgt: t, body, puppet: pu, dur: stun, phase: 'fall', riseT: 0, yaw: t.obj.rotation ? t.obj.rotation.y : 0, home: { x: t.x, z: t.z }, s });
  tone(220, 70, .3, 'sawtooth', .07 * Math.max(0, 1 - Math.hypot(P.x - t.x, P.z - t.z) / (g.tileSize * 12)));
  bus.emit('ragdoll-start', t.kind, t.obj);
}
function shove() {
  if (g.state !== 'play' || cooldown > 0) return;
  const P = g.player, T = g.tileSize, range = C('shoveRange', 3) * T; g.camera.getWorldDirection(fwd); const hl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / hl, fz = fwd.z / hl;
  let best = null, bd = 1e9;
  gameTargets().forEach(t => { const dx = t.x - P.x, dz = t.z - P.z, d = Math.hypot(dx, dz); if (d > range) return; const cos = d < T * .8 ? 1 : (dx * fx + dz * fz) / d; if (cos > .6 && d < bd) { bd = d; best = t; } });
  if (!best) { windz.ui.toast('Nobody in front of you to shove', 900); cooldown = .4; return; }
  if (best.kind === 'windz' && windz.items && windz.items.eating) { windz.ui.toast('He is busy eating - leave him alone', 1200); return; }
  const dx = best.x - P.x, dz = best.z - P.z, d = Math.hypot(dx, dz) || 1;
  knockDown(best, { x: dx / d, z: dz / d }, 1); cooldown = C('shoveCooldown', 2.5); windz.ui.toast('SHOVE!', 700);
}
function shockwave() {
  if (g.state !== 'play' || shockCooldown > 0) return;
  const P = g.player, R = C('shockwaveRadius', 9) * g.tileSize; let n = 0;
  gameTargets().forEach(t => { const dx = t.x - P.x, dz = t.z - P.z, d = Math.hypot(dx, dz); if (d > R) return; const dd = d || 1; knockDown(t, { x: dx / dd, z: dz / dd }, 1.1 * (1 - d / R * .5)); n++; });
  if (!n) { windz.ui.toast('Nobody close enough', 900); shockCooldown = 1; return; }
  shockCooldown = C('shockwaveCooldown', 12); windz.ui.toast('SHOCKWAVE! ' + n + ' knocked down', 1200); tone(140, 35, .5, 'sine', .15);
}
const fwd = new THREE.Vector3();

function finish(a, silent) {
  const t = a.tgt, pel = a.body.pelvis();
  if (!silent) {
    let x = pel.x, z = pel.z; if (t.game && wallAt(x, z)) { x = a.home.x; z = a.home.z; }
    t.obj.position.x = x; t.obj.position.z = z;
    if (t.res) { t.res.x = x; t.res.z = z; }
  }
  disposePuppet(a.puppet); const i = active.indexOf(a); if (i >= 0) active.splice(i, 1);
  bus.emit('ragdoll-end', a.kind, t.obj);
  if (!silent && a.kind === 'windz') { bus.emit('rage'); }                           // he gets up angry (Animations + Radar react)
}

/* =========================== per-frame =========================== */
// advance one ragdoll: physics while it is falling, a blend back to standing once its time is up. Returns true when it has finished getting up.
function advance(a, dt) {
  if (a.phase === 'fall') {
    a.acc = (a.acc || 0) + dt; let steps = 0; a.body.hit = 0;
    while (a.acc >= STEP && steps < 4) { a.body.step(); a.acc -= STEP; steps++; }
    if (a.body.hit) thud(a.body.hit, a.body.pelvis().x, a.body.pelvis().z);
    if (a.body.t > a.dur) { a.phase = 'rise'; a.riseT = 0; const pel = a.body.pelvis(); a.from = a.body.p.map(q => [q.x, q.y, q.z]); a.stand = standingPoints(pel.x, a.body.gy, pel.z, a.yaw, a.s); }
  } else {
    a.riseT += dt; const k = Math.min(1, a.riseT / .7), e = k * k * (3 - 2 * k);
    a.body.p.forEach((q, i) => { q.x = a.from[i][0] + (a.stand[i][0] - a.from[i][0]) * e; q.y = a.from[i][1] + (a.stand[i][1] - a.from[i][1]) * e; q.z = a.from[i][2] + (a.stand[i][2] - a.from[i][2]) * e; });
    if (k >= 1) return true;
  }
  updatePuppet(a.puppet, a.body); return false;
}

/* =========================== ragdolling yourself =========================== */
let me = null, selfCool = 0; const pv = { x: 0, z: 0, lx: 0, lz: 0, init: false };      // pv = your own velocity, so you tumble the way you were running
function selfOn(opt) {
  if (me || g.state !== 'play' || selfCool > 0) return false;
  opt = opt || {}; const P = g.player; g.camera.getWorldDirection(fwd); const hl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / hl, fz = fwd.z / hl, f = C('selfForce', 1);
  const gy = groundY(), s = Math.max(.6, Math.min(1.8, (g.camera.position.y - gy) / 1.65));
  let vel = opt.vel; if (!vel) { const sp = Math.hypot(pv.x, pv.z); vel = sp > .5 ? [pv.x * .9 + fx * 2 * f, 3.2 * f, pv.z * .9 + fz * 2 * f] : [fx * 5 * f, 3.5 * f, fz * 5 * f]; }
  const yaw = Math.atan2(fx, fz), body = new Body(P.x, gy, P.z, yaw, s, vel), pu = makePuppet(LOOKS.player, s); g.scene.add(pu.root);
  me = { body, puppet: pu, dur: opt.dur || C('selfSeconds', 8), phase: 'fall', riseT: 0, yaw, s };
  tone(200, 80, .25, 'sawtooth', .06); bus.emit('ragdoll-start', 'player'); windz.ui.toast('Ragdoll! Press ' + String(C('selfKey', 'KeyX')).replace('Key', '') + ' to get up', 1500);
  return true;
}
function selfOff(force) { if (!me || me.phase !== 'fall') return; if (!force && me.body.t < .6) return; me.dur = Math.min(me.dur, me.body.t); }
function selfEnd(silent) {
  if (!me) return; const pel = me.body.pelvis(); disposePuppet(me.puppet); const was = me; me = null; selfCool = 1;
  bus.emit('ragdoll-end', 'player'); return was;
}
// camera while you are a ragdoll: orbit around the body (mouse turns the view), or look out of its head
function selfCamera(cam) {
  const saved = { x: cam.position.x, y: cam.position.y, z: cam.position.z, ex: cam.rotation.x, ey: cam.rotation.y, ez: cam.rotation.z, eo: cam.rotation.order };
  const pel = me.body.pelvis(), s = me.s, headMesh = me.puppet.head;
  if (C('selfCam', 'orbit') === 'head') {
    const p = me.body.p, hd = p[IDX.head], nk = p[IDX.neck], shL = p[IDX.shL], shR = p[IDX.shR];
    const up = new THREE.Vector3(hd.x - nk.x, hd.y - nk.y, hd.z - nk.z).normalize(), across = new THREE.Vector3(shL.x - shR.x, shL.y - shR.y, shL.z - shR.z);
    const face = new THREE.Vector3().crossVectors(across, up).normalize(), z = face.clone().negate(), x = new THREE.Vector3().crossVectors(up, z).normalize();
    cam.position.set(hd.x, hd.y + .02 * s, hd.z); cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, new THREE.Vector3().crossVectors(z, x).normalize(), z)); headMesh.visible = false;
  } else {
    cam.getWorldDirection(fwd); const dist = C('selfCamDistance', 3.6) * Math.max(.8, s), dx = -fwd.x * dist, dy = -fwd.y * dist + .5, dz = -fwd.z * dist;
    const len = Math.hypot(dx, dy, dz); let t = 1;
    if (inMaze(pel.x, pel.z)) { const n = Math.max(4, Math.ceil(len / (g.tileSize * .12))); for (let i = 1; i <= n; i++) { const k = i / n; if (wallAt(pel.x + dx * k, pel.z + dz * k)) { t = Math.max(0, (i - 1) / n - .35 / len); break; } } }
    const top = Math.min(ceilingY() - .2, 40); cam.position.set(pel.x + dx * t, Math.max(.3, Math.min(top, pel.y + dy * t)), pel.z + dz * t); cam.lookAt(pel.x, pel.y + .25 * s, pel.z);
  }
  return () => { cam.position.set(saved.x, saved.y, saved.z); cam.rotation.set(saved.ex, saved.ey, saved.ez, saved.eo); headMesh.visible = true; };
}
// knocked over by Mr. Windz when he catches you with the apple (off by default - it takes your control away for a moment)
bus.on('apple-start', (en) => {
  if (!C('knockdownOnApple', false) || !en || !en.position || !g.player) return;
  const P = g.player, dx = P.x - en.position.x, dz = P.z - en.position.z, d = Math.hypot(dx, dz) || 1;
  selfOn({ vel: [dx / d * 9, 5.5, dz / d * 9], dur: C('knockdownSeconds', 2.5) });
});

/* =========================== per-frame =========================== */
windz.on('tick', dt => {
  if (!(dt >= 0)) dt = .016; dt = Math.min(dt, .05);
  clock += dt;
  if (g.state !== 'play') { pv.init = false; return; }  // ragdolls freeze while the game is paused / in a quiz
  if (cooldown > 0) cooldown -= dt; if (shockCooldown > 0) shockCooldown -= dt; if (selfCool > 0) selfCool -= dt;
  const P = g.player, T = g.tileSize;
  if (!me && P) {                                       // track how fast you are moving (for the tumble direction)
    if (pv.init) { pv.x += ((P.x - pv.lx) / Math.max(dt, .001) - pv.x) * .4; pv.z += ((P.z - pv.lz) / Math.max(dt, .001) - pv.z) * .4; }
    pv.lx = P.x; pv.lz = P.z; pv.init = true;
  }
  for (const a of active.slice()) {
    if (advance(a, dt)) { finish(a); continue; }
    // keep the hidden original (and the game's AI) parked at the body - but never close enough to catch you
    const pel = a.body.pelvis(); let x = pel.x, z = pel.z;
    if (a.tgt.game && P) { const d = Math.hypot(x - P.x, z - P.z), safe = T * 1.15; if (d < safe) { const dd = d || 1, nx = P.x + (x - P.x) / dd * safe, nz = P.z + (z - P.z) / dd * safe; if (!wallAt(nx, nz)) { x = nx; z = nz; } } }
    a.tgt.obj.position.x = x; a.tgt.obj.position.z = z; if (a.tgt.res) { a.tgt.res.x = x; a.tgt.res.z = z; }
  }
  if (me) {                                             // you are carried by your own body
    if (advance(me, dt)) { selfEnd(); }
    else if (P) { const pel = me.body.pelvis(); P.x = pel.x; P.z = pel.z; }
  }
});
addEventListener('keydown', e => {
  if (e.repeat || g.state === 'quiz' || g.state === 'over') return;
  if (e.code === C('selfKey', 'KeyX') && !e.shiftKey) { if (me) selfOff(); else selfOn(); }
  else if (e.code === KEY) { if (e.shiftKey) shockwave(); else shove(); }
});
windz.on('statechange', n => { if (n === 'menu' || n === 'over') { active.slice().forEach(a => finish(a, true)); if (me) selfEnd(true); } });

/* hide the originals while their puppet is on the floor, and aim the camera at you when you are the ragdoll (both undone right after each draw) */
const rd = g.renderer;
if (rd && typeof rd.render === 'function' && !rd.__ragdollWrapped) {
  const prev = rd.render; rd.__ragdollWrapped = true;
  rd.render = function (scene, camera) {
    const useCam = me && camera === g.camera && (g.state === 'play' || g.state === 'paused');
    if (!active.length && !useCam) return prev.call(rd, scene, camera);
    const saved = active.map(a => a.tgt.obj.visible); active.forEach(a => { a.tgt.obj.visible = false; });
    const undo = useCam ? selfCamera(camera) : null;
    try { return prev.call(rd, scene, camera); } finally { active.forEach((a, i) => { a.tgt.obj.visible = saved[i]; }); if (undo) undo(); }
  };
}
windz.ragdoll = { get active() { return active.length; }, get list() { return active; }, get selfActive() { return !!me; }, get me() { return me; }, shove, shockwave, knockDown, gameTargets, self: on => (on === false ? selfOff(true) : selfOn()) };
mod.log('ready - ' + KEY + ' shoves, Shift+' + KEY + ' knocks everyone over, ' + C('selfKey', 'KeyX') + ' ragdolls YOU');
