/* Caladan Worlds — landing scene.
   A bird's-eye flight over an endless wireframe sea.
   - The map scrolls beneath the viewer; the pointer (or a finger) steers the flight.
   - A scanning reticle follows the pointer and lifts the surface under it.
   - Click or tap to send a pulse; contacts answer as it passes. */
(function () {
  document.getElementById('year').textContent = new Date().getFullYear();

  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var ORANGE = '255, 122, 26', GREEN = '109, 255, 142', GRID = '140, 215, 232', WHITE = '225, 246, 252';
  var MONO = '500 10px ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace';

  /* ---------- Camera ---------- */
  var CAM_Y = 8, FAR = 60, FAR_FADE = 40, LINE_EVERY = 4;
  var w = 0, h = 0, dpr = 1, f = 0, ox = 0, oy = 0, SP = 0, CP = 1;
  var camX = 0, camZ = 0;                 // where the viewer is over the (endless) map
  var velX = 0, velZ = 1.6;               // flight velocity, world units per second
  var view = { xHalf: 30, zMin: 0, zMax: 60, cz: 20 };   // visible ground window, relative to the camera
  var STEP = 0.5, NX = 0, NZ = 0, px, py, pz;
  var P = { x: 0, y: 0, z: 0 };

  function project(wx, y, wz) {
    var X = wx - camX, Z = wz - camZ, Y = y - CAM_Y;
    var zr = -Y * SP + Z * CP;
    if (zr < 0.6) return false;
    P.x = ox + f * X / zr;
    P.y = oy - f * (Y * CP + Z * SP) / zr;
    P.z = zr;
    return true;
  }

  // Screen point -> ground point relative to the camera (resting plane, y = 0)
  function groundAt(sx, sy) {
    var a = (sx - ox) / f, b = (oy - sy) / f;
    var dirY = b * CP - SP;
    if (dirY > -0.02) return null;
    var t = CAM_Y / -dirY;
    return { x: a * t, z: (b * SP + CP) * t };
  }

  function fog(zr) { return Math.min(1, Math.max(0, (FAR - zr) / FAR_FADE)); }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var wide = Math.min(1, Math.max(0, (w - 600) / 400));   // 0 on phones, 1 on desktop
    var pitch = 0.46 - 0.05 * wide;                         // a low, flat look across the map
    SP = Math.sin(pitch); CP = Math.cos(pitch);
    f = Math.max(w * 0.95, h * (0.75 + 0.40 * wide));       // phones get a wider lens
    ox = w * (0.5 + 0.06 * wide);
    var horizon = h * (0.38 - 0.10 * wide);                 // the map fades out toward this line
    oy = horizon + f * Math.tan(pitch);

    // Work out which patch of ground is on screen, and size the grid to cover it
    var top = groundAt(w / 2, 0), bottom = groundAt(w / 2, h), centre = groundAt(ox, horizon + (h - horizon) * 0.45);
    view.zMax = Math.min(top ? top.z : FAR, FAR) + 1;
    view.zMin = (bottom ? bottom.z : 0) - 2;
    view.cz = centre ? centre.z : 15;
    var a = Math.max(ox, w - ox) / f, tFar = view.zMax / CP;
    view.xHalf = Math.min(46, a * tFar + 2);
    STEP = Math.max(0.5, Math.sqrt((2 * view.xHalf) * (view.zMax - view.zMin) / 13000));
    NX = Math.ceil(2 * view.xHalf / STEP) + 2;
    NZ = Math.ceil((view.zMax - view.zMin) / STEP) + 2;
    px = new Float32Array(NX * NZ); py = new Float32Array(NX * NZ); pz = new Float32Array(NX * NZ);

    // Let the page scroll normally if the content is taller than the screen; otherwise touches steer
    document.body.style.touchAction = document.documentElement.scrollHeight > h + 1 ? 'pan-y' : 'none';
  }

  /* ---------- World ---------- */
  var tSec = 0;
  var ripples = [];                        // { x, z, t0, c, amp, rad, a } in world space
  var RIPPLE_LIFE = 5200, RIPPLE_SPEED = 9;
  var ret = { x: 0, z: 15 };               // scanning reticle, world space
  var ptr = { sx: 0, sy: 0, last: -1e9 };
  var nextAuto = 1200;

  function surf(x, z) {
    var y = 0.75 * Math.sin(0.28 * x + 0.18 * z + tSec * 0.6)
          + 0.45 * Math.sin(-0.15 * x + 0.42 * z + tSec * 0.85 + 1.3)
          + 0.20 * Math.sin(0.70 * x + 0.60 * z + tSec * 1.4);
    var dx = x - ret.x, dz = z - ret.z, d2 = dx * dx + dz * dz;
    if (d2 < 30) y += Math.exp(-d2 / 5);
    for (var i = 0; i < ripples.length; i++) {
      var r = ripples[i], ex = x - r.x, ez = z - r.z;
      var d = Math.sqrt(ex * ex + ez * ez) - r.rad;
      if (d > -4 && d < 4) y += r.amp * Math.exp(-d * d / 2.2) * Math.cos(d * 1.6);
    }
    return y;
  }

  // Contacts are generated from their map cell, so the map is endless but always the same
  // One contact at most per cell keeps them evenly spread: never crowded, rarely empty
  var CELL = 9, pinCache = new Map();
  var KINDS = {
    node:    { tag: 'A', word: 'LINKED',   stem: 2.4 },   // friendly
    relay:   { tag: 'R', word: 'RELAY',    stem: 3.6 },
    patrol:  { tag: 'P', word: 'PATROL',   stem: 0.9 },
    zone:    { tag: 'Z', word: 'SECURED',  stem: 0 },
    tracker: { tag: 'T', word: 'TRACKING', stem: 2.4 },   // hostile
    mover:   { tag: 'M', word: 'MOVING',   stem: 0.9 },
    hazard:  { tag: 'H', word: 'HAZARD',   stem: 0 },
    unknown: { tag: 'U', word: 'UNKNOWN',  stem: 1.8 }
  };
  function hash(a, b) {
    var n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function pinAt(cx, cz) {
    var key = cx + ',' + cz, p = pinCache.get(key);
    if (p !== undefined) return p;
    p = null;
    if (hash(cx, cz) < 0.6) {
      var friend = hash(cx + 101, cz - 57) < 0.5, t = hash(cx + 31, cz + 77), kind;
      if (friend) kind = t < 0.48 ? 'node' : t < 0.68 ? 'relay' : t < 0.88 ? 'patrol' : 'zone';
      else kind = t < 0.42 ? 'tracker' : t < 0.68 ? 'mover' : t < 0.86 ? 'hazard' : 'unknown';
      var K = KINDS[kind], num = 10 + Math.floor(hash(cx - 9, cz + 4) * 89);
      var x0 = (cx + 0.22 + 0.56 * hash(cx * 3 + 1, cz * 7 + 2)) * CELL;
      var z0 = (cz + 0.22 + 0.56 * hash(cx * 5 - 3, cz * 2 + 9)) * CELL;
      p = {
        x0: x0, z0: z0, x: x0, z: z0, cx: cx, cz: cz,
        friend: friend, kind: kind, c: friend ? GREEN : ORANGE, stem: K.stem,
        linkable: kind === 'node' || kind === 'relay',
        text: K.tag + '-' + num + ' · ' + K.word,
        phase: hash(cx + 7, cz + 7) * 6.2832, ang: hash(cx - 40, cz + 13) * 6.2832,
        flash: -1e9, frame: -1
      };
    }
    if (pinCache.size > 800) pinCache.clear();
    pinCache.set(key, p);
    return p;
  }

  /* ---------- Drawing helpers ---------- */
  function strokeWorld(points, closed) {
    var started = false;
    ctx.beginPath();
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      if (!project(p[0], p[1], p[2])) { started = false; continue; }
      if (started) ctx.lineTo(P.x, P.y); else { ctx.moveTo(P.x, P.y); started = true; }
    }
    if (closed) ctx.closePath();
    ctx.stroke();
  }

  function surfaceRing(cx, cz, r, lift, seg) {
    var pts = [];
    seg = seg || 64;
    for (var k = 0; k < seg; k++) {
      var t = k / seg * 6.2832, x = cx + Math.cos(t) * r, z = cz + Math.sin(t) * r;
      pts.push([x, surf(x, z) + lift, z]);
    }
    strokeWorld(pts, true);
  }

  function diamond(x, y, r) {
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y);
    ctx.closePath();
  }

  function triangle(x, y, ang, len) {
    var c = Math.cos(ang), s = Math.sin(ang), b = len * 0.55;
    ctx.beginPath();
    ctx.moveTo(x + c * len, y + s * len);
    ctx.lineTo(x - c * b - s * b, y - s * b + c * b);
    ctx.lineTo(x - c * b + s * b, y - s * b - c * b);
    ctx.closePath();
  }

  function label(x, y, text, rgb, dir, alpha) {
    if (alpha <= 0.02) return;
    var ex = x + 18 * dir, ey = y - 18;
    ctx.strokeStyle = 'rgba(' + rgb + ', ' + (0.55 * alpha).toFixed(3) + ')';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 5 * dir, y - 5); ctx.lineTo(ex, ey); ctx.lineTo(ex + 10 * dir, ey); ctx.stroke();
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    ctx.textAlign = dir > 0 ? 'left' : 'right';
    ctx.fillStyle = 'rgba(' + rgb + ', ' + (0.95 * alpha).toFixed(3) + ')';
    ctx.fillText(text, ex + 15 * dir, ey);
  }

  function addRipple(x, z, time, c, amp) {
    if (ripples.length > 5) ripples.shift();
    ripples.push({ x: x, z: z, t0: time, c: c, amp0: amp, amp: amp, rad: 0, a: 1 });
  }

  function mod(n, m) { return ((n % m) + m) % m; }

  /* ---------- Frame ---------- */
  var lastTime = 0, frame = 0, visible = [];

  function draw(time, still) {
    var dt = Math.min(64, time - lastTime) / 1000; lastTime = time;
    tSec = time / 1000; frame++;
    var steering = time - ptr.last < 5000;
    var i, j, n, a, k;

    // Flight: steer toward the pointer; with no input, cruise forward on a lazy weave
    if (!still) {
      var tx, tz;
      if (steering) {
        var sx = Math.max(-1, Math.min(1, (ptr.sx - w / 2) / (w / 2)));
        var sy = Math.max(-1, Math.min(1, (h / 2 - ptr.sy) / (h / 2)));
        tx = sx * 5.5; tz = sy * 5.5 + 1.0;
      } else {
        tx = 1.5 * Math.sin(tSec * 0.07); tz = 1.9;
      }
      var steerEase = 1 - Math.exp(-dt * 1.6);
      velX += (tx - velX) * steerEase; velZ += (tz - velZ) * steerEase;
      camX += velX * dt; camZ += velZ * dt;
    }

    // Reticle: follows the pointer, otherwise patrols ahead of the viewer
    var g = steering ? groundAt(ptr.sx, ptr.sy) : null, target;
    if (g) {
      target = {
        x: camX + Math.max(-view.xHalf, Math.min(view.xHalf, g.x)),
        z: camZ + Math.max(view.zMin + 2, Math.min(Math.min(view.zMax, 46), g.z))
      };
    } else {
      var span = Math.min(11, view.xHalf * 0.35);
      target = { x: camX + span * Math.cos(tSec * 0.21), z: camZ + view.cz + 2 + 5 * Math.sin(tSec * 0.29) };
    }
    var ease = still ? 1 : 1 - Math.pow(0.0005, dt);
    ret.x += (target.x - ret.x) * ease; ret.z += (target.z - ret.z) * ease;

    // Pulses
    for (i = ripples.length - 1; i >= 0; i--) {
      var r = ripples[i], age = time - r.t0;
      if (age > RIPPLE_LIFE) { ripples.splice(i, 1); continue; }
      r.rad = RIPPLE_SPEED * age / 1000;
      r.a = 1 - age / RIPPLE_LIFE;
      r.amp = r.amp0 * r.a;
    }

    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Surface: the grid is anchored to the world, so it slides past as we fly
    var wi0 = Math.floor((camX - view.xHalf) / STEP), wj0 = Math.floor((camZ + view.zMin) / STEP);
    for (j = 0; j < NZ; j++) {
      var z = (wj0 + j) * STEP;
      for (i = 0; i < NX; i++) {
        n = j * NX + i;
        var x = (wi0 + i) * STEP;
        if (project(x, surf(x, z), z)) { px[n] = P.x; py[n] = P.y; pz[n] = P.z; }
        else pz[n] = 0;
      }
    }

    // Grid lines, faded with distance
    var midI = NX >> 1, jOff = mod(-wj0, LINE_EVERY), iOff = mod(-wi0, LINE_EVERY);
    ctx.lineWidth = 1;
    for (j = jOff; j < NZ; j += LINE_EVERY) {
      a = fog(pz[j * NX + midI]) * 0.14;
      if (a < 0.01) continue;
      ctx.strokeStyle = 'rgba(' + GRID + ', ' + a.toFixed(3) + ')';
      ctx.beginPath();
      for (i = 0; i < NX; i++) { n = j * NX + i; if (!pz[n]) continue; if (i) ctx.lineTo(px[n], py[n]); else ctx.moveTo(px[n], py[n]); }
      ctx.stroke();
    }
    for (i = iOff; i < NX; i += LINE_EVERY) {
      for (j = 0; j < NZ - LINE_EVERY; j += LINE_EVERY) {
        n = j * NX + i; var n2 = n + LINE_EVERY * NX;
        if (!pz[n] || !pz[n2]) continue;
        a = fog(pz[n]) * 0.12;
        if (a < 0.01 || px[n] < -200 || px[n] > w + 200) continue;
        ctx.strokeStyle = 'rgba(' + GRID + ', ' + a.toFixed(3) + ')';
        ctx.beginPath(); ctx.moveTo(px[n], py[n]);
        for (var q = 1; q <= LINE_EVERY; q++) ctx.lineTo(px[n + q * NX], py[n + q * NX]);
        ctx.stroke();
      }
    }

    // Surface points
    for (j = 0; j < NZ; j++) {
      var mid = pz[j * NX + midI];
      if (!mid) continue;
      a = fog(mid) * 0.6;
      if (a < 0.02) continue;
      var size = Math.min(2.2, Math.max(0.9, f / mid * 0.028));
      ctx.fillStyle = 'rgba(' + GRID + ', ' + a.toFixed(3) + ')';
      for (i = 0; i < NX; i++) {
        n = j * NX + i;
        if (!pz[n] || px[n] < 0 || px[n] > w || py[n] < 0 || py[n] > h) continue;
        ctx.fillRect(px[n], py[n], size, size);
      }
    }

    ctx.globalCompositeOperation = 'lighter';

    // Pulse fronts
    for (i = 0; i < ripples.length; i++) {
      var rp = ripples[i];
      if (rp.rad < 0.3) continue;
      ctx.strokeStyle = 'rgba(' + rp.c + ', ' + (0.55 * rp.a).toFixed(3) + ')'; ctx.lineWidth = 1.4;
      surfaceRing(rp.x, rp.z, rp.rad, 0.05, 96);
      ctx.strokeStyle = 'rgba(' + rp.c + ', ' + (0.10 * rp.a).toFixed(3) + ')'; ctx.lineWidth = 7;
      surfaceRing(rp.x, rp.z, rp.rad, 0.05, 96);
    }

    // Contacts in view: resolve screen positions (they ride the swell) and let pulses wake them
    visible.length = 0;
    var cx0 = Math.floor((camX - view.xHalf) / CELL), cx1 = Math.floor((camX + view.xHalf) / CELL);
    var cz0 = Math.floor((camZ + view.zMin) / CELL), cz1 = Math.floor((camZ + view.zMax) / CELL);
    for (var cz = cz0; cz <= cz1; cz++) for (var cx = cx0; cx <= cx1; cx++) {
      var p = pinAt(cx, cz);
      if (!p) continue;
      if (p.kind === 'patrol') {
        var beat = tSec * 0.5 + p.phase;
        p.x = p.x0 + Math.cos(beat) * 1.7; p.z = p.z0 + Math.sin(beat) * 1.7;
      } else if (p.kind === 'mover') {
        var run = 2.6 * Math.sin(tSec * 0.32 + p.phase);
        p.x = p.x0 + Math.cos(p.ang) * run; p.z = p.z0 + Math.sin(p.ang) * run;
      }
      var gy = surf(p.x, p.z);
      if (!project(p.x, gy, p.z)) continue;
      p.bx = P.x; p.by = P.y; p.fog = Math.pow(fog(P.z), 1.4);
      if (p.fog < 0.03 || !project(p.x, gy + p.stem, p.z)) continue;
      p.hx = P.x; p.hy = P.y; p.hz = P.z; p.gy = gy; p.frame = frame;
      for (k = 0; k < ripples.length; k++) {
        var ddx = p.x - ripples[k].x, ddz = p.z - ripples[k].z;
        if (Math.abs(Math.sqrt(ddx * ddx + ddz * ddz) - ripples[k].rad) < 0.9) p.flash = time;
      }
      p.glow = still ? (p.friend ? 0 : 1) : Math.max(0, 1 - (time - p.flash) / 2800);
      visible.push(p);
    }

    // Friendly nodes ping on their own, so the scene is never still
    if (!still && time > nextAuto) {
      var onScreen = visible.filter(function (v) { return v.linkable && v.hx > 0 && v.hx < w && v.hy > 0 && v.hy < h; });
      if (onScreen.length) {
        var src = onScreen[Math.floor(Math.random() * onScreen.length)];
        addRipple(src.x, src.z, time, GREEN, 0.45);
      }
      nextAuto = time + 3600;
    }

    // Links: most friendly nodes and relays talk to a neighbour; a few hostile trackers are paired
    visible.forEach(function (p1) {
      if (!p1.linkable && p1.kind !== 'tracker') return;
      [[1, 0], [0, 1], [1, 1], [1, -1]].forEach(function (d) {
        var p2 = pinAt(p1.cx + d[0], p1.cz + d[1]);
        if (!p2 || p2.frame !== frame) return;
        var chance = hash(p1.cx * 2 + d[0] + 5, p1.cz * 2 + d[1] - 5), fa = Math.min(p1.fog, p2.fog);
        if (p1.linkable && p2.linkable && chance < 0.7) {
          ctx.strokeStyle = 'rgba(' + GREEN + ', ' + (0.3 * fa).toFixed(3) + ')'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p1.hx, p1.hy); ctx.lineTo(p2.hx, p2.hy); ctx.stroke();
          ctx.setLineDash([2, 20]); ctx.lineDashOffset = -time * 0.02;
          ctx.strokeStyle = 'rgba(220, 255, 228, ' + (0.85 * fa).toFixed(3) + ')'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(p1.hx, p1.hy); ctx.lineTo(p2.hx, p2.hy); ctx.stroke();
          ctx.setLineDash([]);
        } else if (p1.kind === 'tracker' && p2.kind === 'tracker' && chance < 0.5) {
          ctx.setLineDash([3, 7]);
          ctx.strokeStyle = 'rgba(' + ORANGE + ', ' + (0.4 * fa).toFixed(3) + ')'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(p1.hx, p1.hy); ctx.lineTo(p2.hx, p2.hy); ctx.stroke();
          ctx.setLineDash([]);
        }
      });
    });

    // Contacts: each kind has its own mark
    visible.forEach(function (p) {
      var fa = p.fog, s = Math.max(2.2, f / p.hz * 0.1), k2, pts, ang;
      var col = function (alpha) { return 'rgba(' + p.c + ', ' + (alpha * fa).toFixed(3) + ')'; };

      if (p.stem > 0) {
        ctx.strokeStyle = col(0.5); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.bx, p.by); ctx.lineTo(p.hx, p.hy); ctx.stroke();
        ctx.fillStyle = col(0.9);
        ctx.fillRect(p.bx - 1, p.by - 1, 2, 2);
      }

      if (p.kind === 'node') {
        // friendly node: solid diamond in a ring
        ctx.fillStyle = col(0.9); diamond(p.hx, p.hy, s); ctx.fill();
        ctx.strokeStyle = col(0.45); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(p.hx, p.hy, s * 2.2, 0, 6.2832); ctx.stroke();

      } else if (p.kind === 'relay') {
        // friendly relay: tall mast, triangle head, broadcasting rings
        ctx.strokeStyle = col(0.95); ctx.lineWidth = 1.3;
        triangle(p.hx, p.hy, -Math.PI / 2, s * 1.9); ctx.stroke();
        ctx.fillStyle = col(0.95); ctx.fillRect(p.hx - 1.2, p.hy - 1.2, 2.4, 2.4);
        for (k2 = 0; k2 < 2; k2++) {
          var bp = (tSec * 0.5 + p.phase + k2 * 0.5) % 1;
          ctx.strokeStyle = col(0.5 * (1 - bp)); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p.hx, p.hy, s * 2 + bp * s * 5, 0, 6.2832); ctx.stroke();
        }

      } else if (p.kind === 'patrol') {
        // friendly patrol: arrowhead circling its beat, leaving a trail
        var pa = tSec * 0.5 + p.phase;
        pts = [];
        for (k2 = 0; k2 < 14; k2++) {
          var ta = pa - k2 * 0.1, tx2 = p.x0 + Math.cos(ta) * 1.7, tz2 = p.z0 + Math.sin(ta) * 1.7;
          pts.push([tx2, surf(tx2, tz2) + 0.05, tz2]);
        }
        ctx.strokeStyle = col(0.35); ctx.lineWidth = 1; strokeWorld(pts);
        ang = project(p.x0 + Math.cos(pa + 0.2) * 1.7, p.gy + p.stem, p.z0 + Math.sin(pa + 0.2) * 1.7) ? Math.atan2(P.y - p.hy, P.x - p.hx) : 0;
        ctx.fillStyle = col(0.95); triangle(p.hx, p.hy, ang, s * 1.8); ctx.fill();

      } else if (p.kind === 'zone') {
        // friendly zone: a secured circle on the surface
        ctx.strokeStyle = col(0.6); ctx.lineWidth = 1.2;
        surfaceRing(p.x, p.z, 1.8, 0.05, 40);
        ctx.setLineDash([3, 6]); ctx.lineDashOffset = -time * 0.01;
        ctx.strokeStyle = col(0.45); ctx.lineWidth = 1;
        surfaceRing(p.x, p.z, 1.15, 0.05, 28);
        ctx.setLineDash([]);
        ctx.strokeStyle = col(0.9);
        ctx.beginPath(); ctx.moveTo(p.hx - 4, p.hy); ctx.lineTo(p.hx + 4, p.hy); ctx.moveTo(p.hx, p.hy - 4); ctx.lineTo(p.hx, p.hy + 4); ctx.stroke();

      } else if (p.kind === 'tracker') {
        // hostile, tracked: slowly turning wireframe octahedron over a pulsing ring
        var e = 0.42, th = tSec * 0.7 + p.phase, c = Math.cos(th) * e, sn = Math.sin(th) * e, hy = p.gy + p.stem;
        var eq = [[p.x + c, hy, p.z + sn], [p.x - sn, hy, p.z + c], [p.x - c, hy, p.z - sn], [p.x + sn, hy, p.z - c]];
        ctx.strokeStyle = col(0.95); ctx.lineWidth = 1.2;
        ctx.shadowColor = 'rgba(' + ORANGE + ', 0.9)'; ctx.shadowBlur = 8;
        strokeWorld(eq, true);
        for (k2 = 0; k2 < 4; k2++) strokeWorld([[p.x, hy + e * 1.3, p.z], eq[k2], [p.x, hy - e * 1.3, p.z]]);
        ctx.shadowBlur = 0;
        var pulse = (tSec * 0.45 + p.phase) % 1;
        ctx.strokeStyle = col(0.5 * (1 - pulse)); ctx.lineWidth = 1;
        surfaceRing(p.x, p.z, 0.5 + pulse * 1.6, 0.04, 28);

      } else if (p.kind === 'mover') {
        // hostile, on the move: hollow arrowhead running along its projected track
        var dxm = Math.cos(p.ang), dzm = Math.sin(p.ang);
        pts = [];
        for (k2 = -5; k2 <= 5; k2++) { var mx = p.x0 + dxm * k2 * 0.62, mz = p.z0 + dzm * k2 * 0.62; pts.push([mx, surf(mx, mz) + 0.05, mz]); }
        ctx.setLineDash([4, 6]); ctx.strokeStyle = col(0.4); ctx.lineWidth = 1; strokeWorld(pts); ctx.setLineDash([]);
        var dirSign = Math.cos(tSec * 0.32 + p.phase) >= 0 ? 1 : -1;
        ang = project(p.x + dxm * 0.4 * dirSign, p.gy + p.stem, p.z + dzm * 0.4 * dirSign) ? Math.atan2(P.y - p.hy, P.x - p.hx) : 0;
        ctx.strokeStyle = col(0.95); ctx.lineWidth = 1.4; triangle(p.hx, p.hy, ang, s * 2); ctx.stroke();

      } else if (p.kind === 'hazard') {
        // hostile area: dashed ring with flickering returns inside
        ctx.setLineDash([6, 5]); ctx.lineDashOffset = time * 0.008;
        ctx.strokeStyle = col(0.6); ctx.lineWidth = 1.2;
        surfaceRing(p.x, p.z, 1.9, 0.05, 40);
        ctx.setLineDash([]);
        for (k2 = 0; k2 < 7; k2++) {
          var ha = hash(p.cx * 11 + k2, p.cz * 13 - k2) * 6.2832, hr = 0.3 + hash(p.cx - k2 * 3, p.cz + k2 * 5) * 1.3;
          var hx2 = p.x + Math.cos(ha) * hr, hz2 = p.z + Math.sin(ha) * hr;
          if (!project(hx2, surf(hx2, hz2) + 0.05, hz2)) continue;
          ctx.fillStyle = col(0.45 + 0.45 * Math.sin(tSec * 2.2 + k2 * 1.9 + p.phase));
          ctx.fillRect(P.x - 1, P.y - 1, 2.2, 2.2);
        }

      } else {
        // unidentified: blinking corner brackets
        var blink = Math.sin(tSec * 3 + p.phase) > -0.3 ? 1 : 0.3, bs = s * 1.9, bl = bs * 0.45;
        ctx.strokeStyle = col(0.9 * blink); ctx.lineWidth = 1.3;
        ctx.beginPath();
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (q) {
          ctx.moveTo(p.hx + q[0] * bs, p.hy + q[1] * (bs - bl)); ctx.lineTo(p.hx + q[0] * bs, p.hy + q[1] * bs); ctx.lineTo(p.hx + q[0] * (bs - bl), p.hy + q[1] * bs);
        });
        ctx.stroke();
        ctx.fillStyle = col(0.9 * blink); ctx.fillRect(p.hx - 1.2, p.hy - 1.2, 2.4, 2.4);
      }

      if (p.glow > 0 && !still) {
        ctx.strokeStyle = col(0.8 * p.glow); ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.hx, p.hy, s * 2 + (1 - p.glow) * 26, 0, 6.2832); ctx.stroke();
      }
    });

    // Reticle
    var ry = surf(ret.x, ret.z), RR = 2.5, rcx = 0, rcy = 0, rOk = false;
    ctx.strokeStyle = 'rgba(' + WHITE + ', 0.85)'; ctx.lineWidth = 1.2;
    ctx.setLineDash([10, 7]); ctx.lineDashOffset = time * 0.012;
    surfaceRing(ret.x, ret.z, RR, 0.06);
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(' + WHITE + ', 0.35)'; ctx.lineWidth = 1;
    surfaceRing(ret.x, ret.z, RR * 0.45, 0.06, 32);
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
      strokeWorld([[ret.x + d[0] * RR * 0.8, ry, ret.z + d[1] * RR * 0.8], [ret.x + d[0] * RR * 1.3, ry, ret.z + d[1] * RR * 1.3]]);
    });
    if (project(ret.x, ry, ret.z)) {
      rcx = P.x; rcy = P.y; rOk = true;
      ctx.fillStyle = 'rgba(' + WHITE + ', 0.95)'; ctx.fillRect(rcx - 1.5, rcy - 1.5, 3, 3);
      var beam = ctx.createLinearGradient(0, rcy - 90, 0, rcy);
      beam.addColorStop(0, 'rgba(' + WHITE + ', 0)'); beam.addColorStop(1, 'rgba(' + WHITE + ', 0.5)');
      ctx.strokeStyle = beam; ctx.beginPath(); ctx.moveTo(rcx, rcy - 90); ctx.lineTo(rcx, rcy); ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';

    // Labels
    visible.forEach(function (p) { label(p.hx, p.hy, p.text, p.c, p.hx > w * 0.72 ? -1 : 1, p.fog > 0.42 ? p.glow * p.fog : 0); });   // distant contacts stay unlabelled
    if (rOk && project(ret.x + RR, ry, ret.z)) {
      var sign = function (v) { return (v < 0 ? '-' : '+') + Math.abs(v).toFixed(1); };
      label(P.x, P.y, 'SCAN ' + sign(ret.x) + ' / ' + sign(ret.z), WHITE, rcx > w * 0.7 ? -1 : 1, 0.8);
    }
  }

  /* ---------- Input ---------- */
  function onMove(e) { ptr.sx = e.clientX; ptr.sy = e.clientY; ptr.last = performance.now(); }
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', function (e) {
    onMove(e);
    if (e.target.closest && e.target.closest('a')) return;
    var g = groundAt(e.clientX, e.clientY);
    if (g) addRipple(camX + g.x, camZ + g.z, performance.now(), WHITE, 0.9);
  }, { passive: true });

  /* ---------- Loop ---------- */
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var raf = 0;

  function loop(t) { draw(t, false); raf = requestAnimationFrame(loop); }

  window.addEventListener('resize', function () { resize(); if (reduce) draw(9000, true); });
  document.addEventListener('visibilitychange', function () {
    if (reduce) return;
    cancelAnimationFrame(raf);
    if (!document.hidden) raf = requestAnimationFrame(loop);
  });

  resize();
  if (reduce) draw(9000, true);
  else raf = requestAnimationFrame(loop);
})();
