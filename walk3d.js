// 間取りデータ（plan JSON）から人の目線で歩ける3Dを組み立てるエンジン
// 使い方: const v = Walk3D.mount(container, plan, { title, onClose }); v.dispose();
(function () {
  const CSS = `
.w3d{position:fixed;inset:0;z-index:40;background:#cfe3f3;color:#eef1f4;font:13px/1.5 system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;--panel:rgba(22,26,32,.84);--sub:#a9b3bd;--accent:#f0a14a;--line:rgba(255,255,255,.12)}
.w3d *{box-sizing:border-box}
.w3d-c{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab}
.w3d-panel{position:absolute;top:calc(12px + env(safe-area-inset-top,0px));left:12px;width:272px;background:var(--panel);border-radius:12px;padding:12px 14px;backdrop-filter:blur(6px);box-shadow:0 6px 20px rgba(0,0,0,.25);max-height:calc(100% - 24px);overflow:auto}
.w3d-hd{display:flex;align-items:center;justify-content:space-between;gap:8px}
.w3d-hd b{font-size:15px}
.w3d-panel.min .w3d-body{display:none}
.w3d-sec{margin:12px 0 6px;font-size:11px;letter-spacing:.08em;color:var(--sub)}
.w3d-jumps{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.w3d button{font:inherit;color:#eef1f4;background:rgba(255,255,255,.08);border:1px solid var(--line);border-radius:8px;padding:6px 4px;cursor:pointer}
.w3d button:hover{background:rgba(255,255,255,.16)}
.w3d button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.w3d .w3d-primary{width:100%;background:var(--accent);color:#1d1d1d;border-color:transparent;font-weight:600;padding:8px}
.w3d .w3d-close{width:100%;margin-top:10px;padding:8px}
.w3d-min{width:28px;padding:2px 0!important}
.w3d-home{color:var(--accent);text-decoration:none}
.w3d-home:hover{text-decoration:underline}
.w3d label{display:block;margin-top:8px}
.w3d input[type=range]{width:100%;accent-color:var(--accent)}
.w3d-help{margin-top:12px;padding-top:10px;border-top:1px solid var(--line);color:var(--sub);font-size:12px}
.w3d-room{position:absolute;top:calc(14px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);background:var(--panel);padding:6px 16px;border-radius:999px;font-size:14px;white-space:nowrap;pointer-events:none}
.w3d-room small{color:var(--sub);margin-left:8px}
.w3d-map{position:absolute;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));background:#fff;border-radius:10px;padding:6px;box-shadow:0 6px 20px rgba(0,0,0,.25)}
.w3d-map canvas{display:block;cursor:crosshair}
.w3d-cross{position:absolute;left:50%;top:50%;width:6px;height:6px;margin:-3px 0 0 -3px;border-radius:50%;background:rgba(255,255,255,.85);box-shadow:0 0 0 1px rgba(0,0,0,.4);pointer-events:none}
.w3d-toast{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:var(--panel);padding:6px 14px;border-radius:8px;opacity:0;transition:opacity .3s;pointer-events:none}
.w3d-joy{position:absolute;left:24px;bottom:24px;width:120px;height:120px;border-radius:50%;background:rgba(0,0,0,.18);border:2px solid rgba(255,255,255,.5);display:none;touch-action:none}
.w3d-joy div{position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;border-radius:50%;background:rgba(255,255,255,.75)}
.w3d.touch .w3d-joy{display:block}
@media (max-width:640px){.w3d-panel{width:calc(100% - 24px);font-size:12px}.w3d-room{top:auto;bottom:160px}}
`;
  function injectCSS() {
    if (document.getElementById('w3d-css')) return;
    const st = document.createElement('style'); st.id = 'w3d-css'; st.textContent = CSS; document.head.appendChild(st);
  }

  const KINDS = {
    wood: { y: 0, tex: 'wood' }, cf: { y: 0.002, tex: 'cf' }, tatami: { y: 0.004, tex: 'tatami' },
    bath: { y: 0.004, tex: 'bath' }, genkan: { y: -0.12, tex: 'genkan' }, balcony: { y: -0.15, tex: 'balcony', outdoor: true },
  };
  const JO = 1.62;  // 1帖 = 1.62㎡

  function mount(root, plan, opts = {}) {
    injectCSS();
    root.classList.add('w3d');
    root.innerHTML = `
<canvas class="w3d-c"></canvas><div class="w3d-cross"></div><div class="w3d-room"></div><div class="w3d-toast"></div>
<div class="w3d-panel"><div class="w3d-hd"><b>${opts.home ? '<a class="w3d-home" href="./">一覧</a> › ' : ''}<span class="w3d-title"></span></b><button class="w3d-min" title="折りたたむ">–</button></div>
<div class="w3d-body">
<div class="w3d-sec">部屋へ移動</div><div class="w3d-jumps"></div>
<div class="w3d-sec">表示</div><button class="w3d-primary w3d-mode">俯瞰（上から）で見る</button>
<label>目線の高さ <b class="w3d-eyev">155</b> cm<input type="range" class="w3d-eye" min="90" max="190" value="155"></label>
<label>視野角 <b class="w3d-fovv">75</b>°<input type="range" class="w3d-fov" min="50" max="105" value="75"></label>
<div class="w3d-help">W A S D / ↑↓：移動　← →：向きを変える<br>マウスドラッグ：見回す　Shift：早歩き<br>ドア・窓をクリック（または E）で開閉<br>右下の間取り図をクリックでその場所へ移動</div>
${opts.onClose ? '<button class="w3d-close">編集に戻る</button>' : ''}
</div></div>
<div class="w3d-map"><canvas></canvas></div><div class="w3d-joy"><div></div></div>`;
    const $ = sel => root.querySelector(sel);
    $('.w3d-title').textContent = opts.title || plan.title || '3Dウォークスルー';
    const listeners = [];
    const on = (t, type, fn, o) => { t.addEventListener(type, fn, o); listeners.push([t, type, fn, o]); };

    // ---------- 座標 ----------
    const S = plan.scale, HC = plan.ceiling || 2.4, DOOR_H = 2.0;
    const pts = [];
    plan.walls.forEach(w => pts.push(w.a, w.b));
    plan.rooms.forEach(r => pts.push([r.x1, r.y1], [r.x2, r.y2]));
    if (!pts.length) pts.push([0, 0], [100, 100]);
    const bb = { x1: Math.min(...pts.map(p => p[0])), y1: Math.min(...pts.map(p => p[1])), x2: Math.max(...pts.map(p => p[0])), y2: Math.max(...pts.map(p => p[1])) };
    const ox = (bb.x1 + bb.x2) / 2, oy = (bb.y1 + bb.y2) / 2;
    const X = p => (p - ox) * S, Z = p => (p - oy) * S;
    const toPX = x => x / S + ox, toPY = z => z / S + oy;
    const span = Math.max((bb.x2 - bb.x1) * S, (bb.y2 - bb.y1) * S, 4);

    // ---------- three.js ----------
    const canvas = $('.w3d-c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xbcd7ee);
    scene.fog = new THREE.Fog(0xbcd7ee, 40, 160);
    const camera = new THREE.PerspectiveCamera(75, 1, 0.03, 400);
    camera.rotation.order = 'YXZ';

    const col = h => new THREE.Color(h).convertSRGBToLinear();
    const mat = (h, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: col(h), roughness: .85 }, o));
    const rnd = (a, b) => a + Math.random() * (b - a);
    function canvasTex(w, h, draw, sizeM) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      draw(cv.getContext('2d'), w, h);
      const t = new THREE.CanvasTexture(cv);
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding;
      t.anisotropy = renderer.capabilities.getMaxAnisotropy(); t.sizeM = sizeM;
      return t;
    }
    function woodTex() {
      return canvasTex(512, 512, (g, w, h) => {
        const rows = 8, rh = h / rows;
        for (let r = 0; r < rows; r++) {
          let x = -rnd(0, 300);
          while (x < w) {
            const len = rnd(220, 420);
            g.fillStyle = `hsl(${30 + rnd(-3, 3)},${rnd(35, 45)}%,${58 + rnd(-6, 5)}%)`; g.fillRect(x, r * rh, len, rh);
            for (let k = 0; k < 16; k++) {
              g.strokeStyle = `rgba(90,55,25,${rnd(.04, .12)})`; g.lineWidth = rnd(.8, 2);
              const yy = r * rh + rnd(2, rh - 2);
              g.beginPath(); g.moveTo(x, yy); g.bezierCurveTo(x + len * .3, yy + rnd(-4, 4), x + len * .6, yy + rnd(-4, 4), x + len, yy + rnd(-3, 3)); g.stroke();
            }
            g.fillStyle = 'rgba(55,32,15,.45)'; g.fillRect(x, r * rh, 2, rh); x += len;
          }
          g.fillStyle = 'rgba(55,32,15,.45)'; g.fillRect(0, r * rh, w, 2);
        }
      }, 1.2);
    }
    function tileTex(base, line, n, sizeM, lw = 3) {
      return canvasTex(256, 256, (g, w, h) => {
        g.fillStyle = base; g.fillRect(0, 0, w, h);
        const s = w / n;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { g.fillStyle = `rgba(${Math.random() < .5 ? '255,255,255' : '0,0,0'},${rnd(0, .06)})`; g.fillRect(i * s, j * s, s, s); }
        g.strokeStyle = line; g.lineWidth = lw;
        for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, h); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(w, i * s); g.stroke(); }
      }, sizeM);
    }
    const TEX = {
      wood: woodTex(), cf: tileTex('#e6e0d3', '#d3cab8', 3, .45, 2), tatami: tileTex('#b9bf86', '#8f9662', 1, 1.8, 6),
      bath: tileTex('#dfe4e8', '#b3bcc4', 4, .6, 4), genkan: tileTex('#8e8980', '#615c55', 2, .6), balcony: tileTex('#b9b4aa', '#8e897f', 2, .6),
    };
    const M = {
      wall: mat('#f3f0ea', { roughness: .95 }), ceil: mat('#f7f6f2', { roughness: .95 }), ext: mat('#e2ddd3', { roughness: .95 }),
      base: mat('#6d4c30', { roughness: .6 }), frame: mat('#8a643f', { roughness: .6 }), door: mat('#d9c29b', { roughness: .6 }),
      metal: mat('#c8ccd0', { roughness: .3, metalness: .7 }), darkMetal: mat('#555a60', { roughness: .35, metalness: .6 }),
      black: mat('#1f2123', { roughness: .4 }), white: mat('#f7f7f5', { roughness: .35 }), cab: mat('#ece6db', { roughness: .55 }),
      pan: mat('#dfe3e5', { roughness: .4 }), alum: mat('#b9bec2', { roughness: .35, metalness: .6 }), dark: mat('#5a4331'),
      glass: new THREE.MeshStandardMaterial({ color: col('#bcd8e6'), transparent: true, opacity: .22, roughness: .05, depthWrite: false }),
      water: new THREE.MeshStandardMaterial({ color: col('#9fd0e6'), transparent: true, opacity: .55, roughness: .1 }),
      mirror: mat('#c9d6de', { roughness: .08, metalness: .2 }), sofa: mat('#6f7b86'), bedding: mat('#8fa6b8'),
      lamp: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: col('#fff6e6'), emissiveIntensity: 1 }),
    };

    const cols = [], clickables = [], openables = [], floors = [], ceilings = [];
    function boxW(cx, cy, cz, w, h, d, m, parent = scene, rotY = 0) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, .001), Math.max(h, .001), Math.max(d, .001)), m);
      mesh.position.set(cx, cy, cz); mesh.rotation.y = rotY; mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
    }
    function cylW(cx, cy, cz, r, h, m, parent = scene) {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), m);
      mesh.position.set(cx, cy, cz); mesh.castShadow = mesh.receiveShadow = true; parent.add(mesh); return mesh;
    }
    const ease = t => t * t * (3 - 2 * t);
    const angOf = (vx, vz) => Math.atan2(-vz, vx);

    // ---------- 床・天井 ----------
    const roomsSorted = plan.rooms.map(r => ({ ...r, x1: Math.min(r.x1, r.x2), x2: Math.max(r.x1, r.x2), y1: Math.min(r.y1, r.y2), y2: Math.max(r.y1, r.y2) }))
      .sort((a, b) => (a.x2 - a.x1) * (a.y2 - a.y1) - (b.x2 - b.x1) * (b.y2 - b.y1));
    const floorList = roomsSorted.filter(r => !r.noFloor).concat((plan.floorRects || []).map(r => ({ ...r, kind: 'wood', floorOnly: true })));
    for (const r of floorList) {
      const k = KINDS[r.kind] || KINDS.wood;
      const w = (r.x2 - r.x1) * S, d = (r.y2 - r.y1) * S;
      const g = new THREE.PlaneGeometry(w, d); g.rotateX(-Math.PI / 2);
      const t = TEX[k.tex].clone(); t.needsUpdate = true; t.repeat.set(w / TEX[k.tex].sizeM, d / TEX[k.tex].sizeM);
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: t, roughness: .6 }));
      m.position.set(X((r.x1 + r.x2) / 2), k.y, Z((r.y1 + r.y2) / 2)); m.receiveShadow = true; scene.add(m); floors.push(m);
      if (!k.outdoor) {
        const e = r.floorOnly ? 0.01 : 0.08;
        ceilings.push(boxW(X((r.x1 + r.x2) / 2), HC + 0.06, Z((r.y1 + r.y2) / 2), w + e * 2, 0.12, d + e * 2, M.ceil));
      }
    }
    // 部屋と部屋のすき間（壁の下など）を埋める下地
    const under = new THREE.Mesh(new THREE.PlaneGeometry((bb.x2 - bb.x1) * S + 1, (bb.y2 - bb.y1) * S + 1).rotateX(-Math.PI / 2), mat('#8b8378'));
    under.position.set(X((bb.x1 + bb.x2) / 2), -0.2, Z((bb.y1 + bb.y2) / 2)); under.receiveShadow = true; scene.add(under);

    // ---------- 壁・開口 ----------
    const openingsOf = id => plan.openings.filter(o => o.wall === id);
    for (const w of plan.walls) {
      const ax = X(w.a[0]), az = Z(w.a[1]), bx = X(w.b[0]), bz = Z(w.b[1]);
      const L = Math.hypot(bx - ax, bz - az); if (L < 0.02) continue;
      const dx = (bx - ax) / L, dz = (bz - az) / L, nx = -dz, nz = dx;
      const th = w.t || 0.12, low = w.h === 'low', top = low ? 1.1 : HC;
      const rotY = -Math.atan2(dz, dx);
      const at = u => [ax + dx * u, az + dz * u];
      const yb = w.bottom ?? -0.2, yt = w.top ?? top;
      if (w.glass) {
        const [cx, cz] = at(L / 2);
        boxW(cx, (yb + yt) / 2, cz, L, yt - yb, 0.012, M.glass, scene, rotY).castShadow = false;
        boxW(cx, yb - 0.01, cz, L, 0.02, th + 0.01, M.alum, scene, rotY);
        if (yb < 1.0) cols.push({ seg: [ax, az, bx, bz], r: th / 2 });
        continue;
      }
      const piece = (u0, u1, y0, y1, m = low ? M.ext : M.wall, collide = true) => {
        if (u1 - u0 < 0.005 || y1 - y0 < 0.005) return;
        const [cx, cz] = at((u0 + u1) / 2);
        boxW(cx, (y0 + y1) / 2, cz, u1 - u0, y1 - y0, th, m, scene, rotY);
        if (collide && y0 < 1.0) { const [x1, z1] = at(u0), [x2, z2] = at(u1); cols.push({ seg: [x1, z1, x2, z2], r: th / 2 }); }
        if (!low && y0 <= 0) for (const s of [-1, 1]) boxW(cx + nx * s * (th / 2 + 0.006), 0.035, cz + nz * s * (th / 2 + 0.006), u1 - u0, 0.07, 0.012, M.base, scene, rotY);
      };
      if (low) {
        const [cx, cz] = at(L / 2);
        boxW(cx, 1.115, cz, L + 0.02, 0.03, th + 0.03, M.alum, scene, rotY);
      }
      const ops = openingsOf(w.id).map(o => ({ ...o, u0: Math.max(0, Math.min(o.s, o.e)) * L, u1: Math.min(1, Math.max(o.s, o.e)) * L })).sort((p, q) => p.u0 - q.u0);
      let cur = 0;
      for (const o of ops) {
        if (o.u0 > cur) piece(cur, o.u0, -0.2, top);
        const W = o.u1 - o.u0;
        if (o.type === 'window') {
          const sill = o.sill ?? 0.9, head = Math.min(o.head ?? 2.0, top);
          piece(o.u0, o.u1, -0.2, sill); piece(o.u0, o.u1, head, top);
          const [cx, cz] = at((o.u0 + o.u1) / 2);
          boxW(cx, (sill + head) / 2, cz, W, head - sill, 0.01, M.glass, scene, rotY).castShadow = false;
          boxW(cx, sill - 0.01, cz, W, 0.02, th + 0.02, M.alum, scene, rotY);
        } else {
          piece(o.u0, o.u1, DOOR_H, top);
          const [cx, cz] = at((o.u0 + o.u1) / 2);
          boxW(cx, -0.095, cz, W, 0.21, th, o.type === 'slide' ? M.alum : M.frame, scene, rotY);
          if (o.type === 'door') makeDoor(o, at, dx, dz, nx, nz, W, th);
          if (o.type === 'slide') makeSlider(o, at, dx, dz, nx, nz, W, rotY);
        }
        cur = Math.max(cur, o.u1);
      }
      if (cur < L) piece(cur, L, cur > 0 ? -0.2 : yb, cur > 0 ? top : yt);
    }

    function makeDoor(o, at, dx, dz, nx, nz, W, th) {
      const hingeEnd = o.hinge === 'e';
      const [hx, hz] = at(hingeEnd ? o.u1 : o.u0);
      const cdx = hingeEnd ? -dx : dx, cdz = hingeEnd ? -dz : dz;
      const side = o.side === -1 ? -1 : 1;
      const tc = angOf(cdx, cdz), to0 = angOf(nx * side, nz * side);
      let delta = to0 - tc; while (delta > Math.PI) delta -= 2 * Math.PI; while (delta <= -Math.PI) delta += 2 * Math.PI;
      const g = new THREE.Group(); g.position.set(hx, 0, hz); scene.add(g);
      const h = DOOR_H - 0.01, t = 0.035;
      const leaf = boxW(W / 2, h / 2, 0, W - 0.012, h, t, o.entry ? mat('#4f5b66', { roughness: .45, metalness: .3 }) : M.door, g);
      for (const s of [-1, 1]) { const k = new THREE.Mesh(new THREE.SphereGeometry(0.028, 14, 10), M.metal); k.position.set(W - 0.07, 0.95, s * (t / 2 + 0.03)); g.add(k); }
      const d = { name: o.label || 'ドア', open: false, t: 0, apply(t) { g.rotation.y = tc + delta * ease(t); } };
      d.apply(0);
      leaf.userData.openable = d; clickables.push(leaf); openables.push(d);
      cols.push({ seg: [hx, hz, hx + cdx * W, hz + cdz * W], r: 0.03, on: () => d.t < 0.35 });
    }
    function makeSlider(o, at, dx, dz, nx, nz, W, rotY) {
      const d = { name: o.label || '窓', open: false, t: 0 };
      const half = W / 2, h = 1.96;
      const pane = (uc, off) => {
        const g = new THREE.Group();
        const [cx, cz] = at(uc);
        g.position.set(cx + nx * off, 0.025, cz + nz * off); g.rotation.y = rotY;
        const w = half + 0.04;
        for (const s of [-1, 1]) boxW(s * (w / 2 - 0.02), h / 2, 0, 0.04, h, 0.03, M.alum, g);
        boxW(0, h - 0.025, 0, w, 0.05, 0.03, M.alum, g); boxW(0, 0.035, 0, w, 0.07, 0.03, M.alum, g);
        const gl = boxW(0, h / 2, 0, w - 0.07, h - 0.1, 0.006, M.glass, g); gl.castShadow = false;
        g.children.forEach(c => { c.userData.openable = d; clickables.push(c); });
        scene.add(g); return g;
      };
      pane(o.u0 + half / 2, -0.02);
      const mov = pane(o.u0 + half * 1.5, 0.02), base = mov.position.clone();
      d.apply = t => { const s = half * ease(t); mov.position.set(base.x - dx * s, base.y, base.z - dz * s); };
      const [x0, z0] = at(o.u0), [xm, zm] = at(o.u0 + half), [x1, z1] = at(o.u1);
      cols.push({ seg: [x0, z0, xm, zm], r: 0.03 });
      cols.push({ seg: [xm, zm, x1, z1], r: 0.03, on: () => d.t < 0.5 });
      openables.push(d);
    }

    // ---------- 設備・家具 ----------
    for (const it of plan.items || []) {
      const x1 = Math.min(it.x1, it.x2), x2 = Math.max(it.x1, it.x2), y1 = Math.min(it.y1, it.y2), y2 = Math.max(it.y1, it.y2);
      const k = ((it.rot || 0) % 4 + 4) % 4;
      const g = new THREE.Group(); g.position.set(X((x1 + x2) / 2), 0, Z((y1 + y2) / 2)); g.rotation.y = -k * Math.PI / 2; scene.add(g);
      const RW = (x2 - x1) * S, RD = (y2 - y1) * S;
      const w = k % 2 ? RD : RW, d = k % 2 ? RW : RD;  // ローカル：幅 w（左右）・奥行き d（背面は -z）
      buildItem(it.type, g, w, d);
      if (it.type !== 'rug') cols.push({ rect: [X(x1), Z(y1), X(x2), Z(y2)] });
    }
    function buildItem(type, g, w, d) {
      const B = (x, y, z, bw, bh, bd, m) => boxW(x, y, z, bw, bh, bd, m, g);
      const C = (x, y, z, r, h, m) => cylW(x, y, z, r, h, m, g);
      switch (type) {
        case 'kitchen': {
          B(0, 0.415, 0, w, 0.83, d, M.cab); B(0, 0.845, 0, w + 0.01, 0.03, d + 0.01, M.metal);
          const sw = Math.min(0.6, w * 0.35);
          B(-w / 4, 0.87, 0.02, sw, 0.02, d * 0.6, M.black);
          C(-w / 4 - sw / 4, 0.885, 0.02, 0.08, 0.01, M.darkMetal); C(-w / 4 + sw / 4, 0.885, 0.02, 0.08, 0.01, M.darkMetal);
          B(w / 4, 0.862, 0.02, sw, 0.006, d * 0.6, M.darkMetal);
          C(w / 4, 0.99, -d / 2 + 0.06, 0.014, 0.26, M.metal); B(w / 4, 1.11, -d / 2 + 0.12, 0.025, 0.025, 0.12, M.metal);
          for (let x = -w / 2 + 0.3; x < w / 2; x += 0.6) B(x, 0.62, d / 2 + 0.006, 0.12, 0.02, 0.01, M.metal);
          break;
        }
        case 'tub': {
          const t = 0.06;
          B(0, 0.06, 0, w, 0.12, d, M.white);
          B(0, 0.275, -d / 2 + t / 2, w, 0.55, t, M.white); B(0, 0.275, d / 2 - t / 2, w, 0.55, t, M.white);
          B(-w / 2 + t / 2, 0.275, 0, t, 0.55, d, M.white); B(w / 2 - t / 2, 0.275, 0, t, 0.55, d, M.white);
          B(0, 0.27, 0, w - 2 * t, 0.3, d - 2 * t, M.water).castShadow = false;
          break;
        }
        case 'basin': {
          B(0, 0.39, 0, w, 0.78, d, M.cab); B(0, 0.795, 0, w + 0.01, 0.03, d + 0.01, M.white);
          C(0, 0.812, 0.02, Math.min(w, d) * 0.32, 0.004, M.pan);
          C(0, 0.88, -d / 2 + 0.05, 0.012, 0.14, M.metal);
          B(0, 1.35, -d / 2 + 0.006, w * 0.85, 0.6, 0.012, M.mirror);
          break;
        }
        case 'toilet': {
          const td = Math.min(0.22, d * 0.3);
          B(0, 0.44, -d / 2 + td / 2, Math.min(w, 0.45), 0.88, td, M.white);
          const r = Math.min(w, 0.4) / 2;
          const bowl = C(0, 0.2, td / 2, r * 0.85, 0.4, M.white); bowl.scale.z = 1.35;
          const seat = C(0, 0.415, td / 2, r, 0.03, M.white); seat.scale.z = 1.35;
          break;
        }
        case 'washer': {
          B(0, 0.03, 0, w, 0.06, d, M.pan);
          const s = Math.min(w, d) - 0.08;
          B(0, 0.5, 0, s, 0.9, s, M.white); C(0, 0.955, 0, s * 0.33, 0.01, M.pan);
          break;
        }
        case 'fridge': B(0, 0.875, 0, w, 1.75, d, mat('#e9ecee', { roughness: .4 })); B(0, 1.2, d / 2 + 0.003, w * 0.96, 0.005, 0.006, M.pan); break;
        case 'shelf': B(0, 0.9, 0, w, 1.8, d, M.cab); if (w > 0.6) B(0, 0.9, d / 2 + 0.003, 0.006, 1.7, 0.006, M.pan); break;
        case 'bed': {
          B(0, 0.15, 0, w, 0.3, d, M.frame); B(0, 0.4, 0, w - 0.04, 0.2, d - 0.04, M.white);
          B(0, 0.55, -d / 2 + 0.18, w * 0.8, 0.1, 0.3, M.white); B(0, 0.53, d * 0.12, w - 0.03, 0.06, d * 0.7, M.bedding);
          break;
        }
        case 'table': {
          B(0, 0.715, 0, w, 0.03, d, M.frame);
          for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B(sx * (w / 2 - 0.05), 0.35, sz * (d / 2 - 0.05), 0.05, 0.7, 0.05, M.frame);
          break;
        }
        case 'sofa': B(0, 0.21, 0.05, w, 0.42, d - 0.1, M.sofa); B(0, 0.6, -d / 2 + 0.1, w, 0.5, 0.2, M.sofa); break;
        case 'tv': B(0, 0.21, 0, w, 0.42, d, M.dark); B(0, 0.8, 0, w * 0.8, 0.6, 0.04, M.black); break;
        case 'rug': B(0, 0.006, 0, w, 0.012, d, mat('#c9b99d', { roughness: 1 })); break;
        default: B(0, 0.4, 0, w, 0.8, d, M.cab);
      }
    }

    // ---------- 照明・屋外 ----------
    scene.add(new THREE.HemisphereLight(col('#ffffff'), col('#8a7a66'), 0.55));
    scene.add(new THREE.AmbientLight(0xffffff, 0.12));
    const sun = new THREE.DirectionalLight(0xfff0d8, 2.2);
    sun.position.set(span * 0.9, span * 0.8 + 4, span * 0.5);
    sun.castShadow = true;
    const sh = span * 0.8 + 2;
    Object.assign(sun.shadow.camera, { left: -sh, right: sh, top: sh, bottom: -sh, near: 1, far: span * 4 + 20 });
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    scene.add(sun);
    const indoor = roomsSorted.filter(r => !(KINDS[r.kind] || {}).outdoor).sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
    indoor.slice(0, 8).forEach(r => {
      const area = (r.x2 - r.x1) * (r.y2 - r.y1) * S * S;
      const cx = X(r.cx ?? (r.x1 + r.x2) / 2), cz = Z(r.cy ?? (r.y1 + r.y2) / 2);
      cylW(cx, HC - 0.03, cz, Math.min(0.25, 0.08 + area * 0.012), 0.05, M.lamp).castShadow = false;
      const L = new THREE.PointLight(0xfff3e0, Math.min(2.6, 0.6 + area * 0.14), Math.sqrt(area) * 2.2 + 2, 2);
      L.position.set(cx, HC - 0.25, cz); scene.add(L);
    });
    indoor.slice(8).forEach(r => cylW(X((r.x1 + r.x2) / 2), HC - 0.03, Z((r.y1 + r.y2) / 2), 0.1, 0.05, M.lamp).castShadow = false);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), mat('#a7ab9f', { roughness: 1 }));
    ground.position.y = -0.3; ground.receiveShadow = true; scene.add(ground);
    (function () {
      const colors = ['#ddd6c8', '#c9c6be', '#e8e2d6', '#b8b4ab', '#d2c5b0'];
      let seed = 17; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 36; i++) {
        const a = r() * Math.PI * 2, dd = span + 12 + r() * 40;
        const w = 6 + r() * 8, h = 4 + r() * 14, d2 = 6 + r() * 8;
        boxW(Math.cos(a) * dd, -0.3 + h / 2, Math.sin(a) * dd, w, h, d2, mat(colors[i % 5])).castShadow = false;
      }
      for (let i = 0; i < 10; i++) {
        const a = r() * Math.PI * 2, dd = span / 2 + 6 + r() * 6;
        cylW(Math.cos(a) * dd, 0.7, Math.sin(a) * dd, 0.12, 2, mat('#6b5037'));
        const t = new THREE.Mesh(new THREE.SphereGeometry(1.2 + r() * .6, 14, 10), mat('#5f8a4e', { roughness: 1 }));
        t.position.set(Math.cos(a) * dd, 2.2, Math.sin(a) * dd); scene.add(t);
      }
    })();

    // ---------- 俯瞰用ラベル・人物 ----------
    const labels = new THREE.Group(); labels.visible = false; scene.add(labels);
    for (const r of roomsSorted) {
      if (!r.name) continue;
      const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128;
      const g = cv.getContext('2d');
      const text = r.name + (r.jo ? ` ${r.jo}帖` : '');
      g.font = 'bold 60px "Hiragino Sans","Noto Sans JP",sans-serif';
      const tw = Math.min(500, g.measureText(text).width + 56);
      g.fillStyle = 'rgba(20,24,30,.78)'; g.beginPath(); g.roundRect ? g.roundRect((512 - tw) / 2, 14, tw, 100, 50) : g.rect((512 - tw) / 2, 14, tw, 100); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 66, 480);
      const t = new THREE.CanvasTexture(cv); t.encoding = THREE.sRGBEncoding;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
      const sz = Math.max(0.6, Math.min(1.3, Math.sqrt((r.x2 - r.x1) * (r.y2 - r.y1)) * S / 3));
      sp.scale.set(1.6 * sz, 0.4 * sz, 1); sp.position.set(X(r.cx ?? (r.x1 + r.x2) / 2), HC + 0.5, Z(r.cy ?? (r.y1 + r.y2) / 2)); sp.renderOrder = 10;
      labels.add(sp);
    }
    const avatar = new THREE.Group(); avatar.visible = false; scene.add(avatar);
    { const am = mat('#f08a3a', { roughness: .5 }); cylW(0, 0.62, 0, 0.17, 1.0, am, avatar);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 20, 14), am); head.position.y = 1.32; avatar.add(head);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 16), mat('#ffd24a')); cone.rotation.x = -Math.PI / 2; cone.position.set(0, 1.0, -0.32); avatar.add(cone); }

    // ---------- 歩行 ----------
    const RADIUS = 0.2;
    function blocked(x, z) {
      for (const c of cols) {
        if (c.on && !c.on()) continue;
        if (c.seg) {
          const [x1, z1, x2, z2] = c.seg, vx = x2 - x1, vz = z2 - z1, l2 = vx * vx + vz * vz;
          const t = l2 ? Math.max(0, Math.min(1, ((x - x1) * vx + (z - z1) * vz) / l2)) : 0;
          if (Math.hypot(x - (x1 + vx * t), z - (z1 + vz * t)) < c.r + RADIUS) return true;
        } else {
          const [x1, z1, x2, z2] = c.rect;
          if (x > x1 - RADIUS && x < x2 + RADIUS && z > z1 - RADIUS && z < z2 + RADIUS) return true;
        }
      }
      return false;
    }
    function roomAt(px, py) { return roomsSorted.find(r => px >= r.x1 && px <= r.x2 && py >= r.y1 && py <= r.y2); }
    function freeNear(x, z) {
      if (!blocked(x, z)) return [x, z];
      for (let rad = 0.1; rad < 3; rad += 0.1) for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        const tx = x + Math.cos(a) * rad, tz = z + Math.sin(a) * rad;
        if (!blocked(tx, tz)) return [tx, tz];
      }
      return [x, z];
    }
    const player = { x: 0, z: 0, yaw: 0, pitch: -0.05, eye: 1.55, y: 1.55, fy: 0 };
    function placeTo(x, z, yaw) {
      const [fx, fz] = freeNear(x, z);
      player.x = fx; player.z = fz; if (yaw !== undefined) player.yaw = yaw;
      const r = roomAt(toPX(fx), toPY(fz)); player.fy = r ? (KINDS[r.kind] || KINDS.wood).y : 0;
      player.y = player.fy + player.eye;
    }
    function roomView(r) {
      const w = (r.x2 - r.x1) * S, d = (r.y2 - r.y1) * S;
      if (r.cx != null) {
        // 部屋の中心から少し下がって、長い方向を見渡す（真上の照明で白飛びしないように）
        const wide = w >= d, back = Math.min(1.5, (wide ? w : d) * 0.3);
        placeTo(X(r.cx) - (wide ? back : 0), Z(r.cy) + (wide ? 0 : back), wide ? -Math.PI / 2 : 0);
        return;
      }
      const cx = X((r.x1 + r.x2) / 2), cz = Z((r.y1 + r.y2) / 2);
      // 部屋の端寄りに立って、長い方向を見渡す
      if (w >= d) placeTo(cx - w * 0.3, cz, -Math.PI / 2); else placeTo(cx, cz + d * 0.3, 0);
    }

    // 部屋ボタン
    const jumpsEl = $('.w3d-jumps'), seen = {};
    for (const r of plan.rooms) {
      if (!r.name) continue;
      seen[r.name] = (seen[r.name] || 0) + 1;
      const b = document.createElement('button');
      b.textContent = seen[r.name] > 1 ? `${r.name}${seen[r.name]}` : r.name;
      const rr = roomsSorted.find(x => x.id === r.id) || r;
      b.onclick = () => { roomView(rr); if (mode === 'over') setMode('walk'); };
      jumpsEl.appendChild(b);
    }
    if (plan.start) placeTo(X(plan.start.x), Z(plan.start.y), plan.start.yaw ?? 0);
    else if (indoor.length) roomView(indoor[0]);

    // ---------- モード ----------
    let mode = 'walk';
    const orbit = { theta: -0.3, phi: 0.6, dist: span * 1.3 + 3 };
    function setMode(m) {
      mode = m; const over = m === 'over';
      ceilings.forEach(c => c.visible = !over); labels.visible = avatar.visible = over;
      $('.w3d-cross').style.display = over ? 'none' : '';
      $('.w3d-mode').textContent = over ? '人の目線で歩く' : '俯瞰（上から）で見る';
    }
    $('.w3d-mode').onclick = () => setMode(mode === 'walk' ? 'over' : 'walk');
    $('.w3d-min').onclick = () => { const p = $('.w3d-panel'); p.classList.toggle('min'); $('.w3d-min').textContent = p.classList.contains('min') ? '+' : '–'; };
    if (innerWidth < 640) { $('.w3d-panel').classList.add('min'); $('.w3d-min').textContent = '+'; }
    if (opts.onClose) $('.w3d-close').onclick = () => opts.onClose();

    // ---------- 入力 ----------
    const keys = {};
    on(window, 'keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      keys[e.code] = true;
      if (e.code === 'KeyE') toggleAt(innerWidth / 2, innerHeight / 2);
      if (e.code === 'KeyV') setMode(mode === 'walk' ? 'over' : 'walk');
      if (e.code === 'Escape' && opts.onClose) opts.onClose();
      if (e.code.startsWith('Arrow')) e.preventDefault();
    });
    on(window, 'keyup', e => { keys[e.code] = false; });
    on(window, 'blur', () => { for (const k in keys) keys[k] = false; });
    const ray = new THREE.Raycaster();
    function pick(cx, cy, list) {
      const r = canvas.getBoundingClientRect();
      ray.setFromCamera({ x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 }, camera);
      return ray.intersectObjects(list, false);
    }
    const toastEl = $('.w3d-toast'); let toastT;
    function toast(msg) { toastEl.textContent = msg; toastEl.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => toastEl.style.opacity = 0, 1400); }
    function toggleAt(cx, cy) {
      const hit = pick(cx, cy, clickables)[0];
      if (hit && (mode === 'over' || hit.distance < 3.2)) {
        const d = hit.object.userData.openable; d.open = !d.open;
        toast(`${d.name}を${d.open ? '開けました' : '閉めました'}`); return true;
      }
      return false;
    }
    let drag = null;
    on(canvas, 'pointerdown', e => { drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false }; canvas.setPointerCapture(e.pointerId); });
    on(canvas, 'pointermove', e => {
      if (!drag || drag.id !== e.pointerId) {
        if (e.pointerType === 'mouse') { const h = pick(e.clientX, e.clientY, clickables)[0]; canvas.style.cursor = h && (mode === 'over' || h.distance < 3.2) ? 'pointer' : ''; }
        return;
      }
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) drag.moved = true;
      const k = e.pointerType === 'touch' ? 0.006 : 0.0042;
      if (mode === 'walk') { player.yaw -= dx * k; player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch - dy * k)); }
      else { orbit.theta -= dx * 0.008; orbit.phi = Math.max(0.05, Math.min(1.45, orbit.phi - dy * 0.006)); }
    });
    on(canvas, 'pointerup', e => {
      if (!drag || drag.id !== e.pointerId) return;
      if (!drag.moved && !toggleAt(e.clientX, e.clientY) && mode === 'over') {
        const h = pick(e.clientX, e.clientY, floors)[0];
        if (h) placeTo(h.point.x, h.point.z);
      }
      drag = null;
    });
    on(canvas, 'pointercancel', () => { drag = null; });
    on(canvas, 'wheel', e => {
      e.preventDefault();
      if (mode === 'over') orbit.dist = Math.max(3, Math.min(span * 4 + 10, orbit.dist * (1 + e.deltaY * 0.001)));
      else setFov(Math.max(50, Math.min(105, fov + Math.sign(e.deltaY) * 3)));
    }, { passive: false });
    const joyEl = $('.w3d-joy'), knob = joyEl.firstElementChild, joy = { x: 0, y: 0, id: null };
    if (matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window) root.classList.add('touch');
    const joyMove = e => {
      const r = joyEl.getBoundingClientRect(), R = r.width / 2;
      let dx = e.clientX - (r.left + R), dy = e.clientY - (r.top + R);
      const l = Math.hypot(dx, dy); if (l > R) { dx *= R / l; dy *= R / l; }
      knob.style.transform = `translate(${dx}px,${dy}px)`; joy.x = dx / R; joy.y = -dy / R;
    };
    on(joyEl, 'pointerdown', e => { joy.id = e.pointerId; joyEl.setPointerCapture(e.pointerId); joyMove(e); });
    on(joyEl, 'pointermove', e => { if (e.pointerId === joy.id) joyMove(e); });
    const joyEnd = e => { if (e.pointerId !== joy.id) return; joy.id = null; joy.x = joy.y = 0; knob.style.transform = ''; };
    on(joyEl, 'pointerup', joyEnd); on(joyEl, 'pointercancel', joyEnd);
    let fov = 75;
    const setFov = v => { fov = v; $('.w3d-fov').value = v; $('.w3d-fovv').textContent = v; };
    $('.w3d-fov').oninput = e => setFov(+e.target.value);
    $('.w3d-eye').oninput = e => { player.eye = e.target.value / 100; $('.w3d-eyev').textContent = e.target.value; };

    // ---------- ミニマップ ----------
    const mapCv = root.querySelector('.w3d-map canvas'), mctx = mapCv.getContext('2d');
    const img = new Image(); if (plan.image) img.src = plan.image;
    const pad = 30, CROP = { x: bb.x1 - pad, y: bb.y1 - pad, w: bb.x2 - bb.x1 + pad * 2, h: bb.y2 - bb.y1 + pad * 2 };
    const MW = innerWidth < 640 ? 180 : 260;
    const mw = CROP.w >= CROP.h ? MW : MW * CROP.w / CROP.h, mh = mw * CROP.h / CROP.w;
    const dpr = Math.min(devicePixelRatio, 2);
    mapCv.style.width = mw + 'px'; mapCv.style.height = mh + 'px'; mapCv.width = mw * dpr; mapCv.height = mh * dpr;
    on(mapCv, 'click', e => {
      const r = mapCv.getBoundingClientRect();
      const px = CROP.x + (e.clientX - r.left) / r.width * CROP.w, py = CROP.y + (e.clientY - r.top) / r.height * CROP.h;
      placeTo(X(px), Z(py));
    });
    function drawMap() {
      const W = mapCv.width, Hh = mapCv.height, k = W / CROP.w;
      mctx.fillStyle = '#fff'; mctx.fillRect(0, 0, W, Hh);
      if (img.complete && img.naturalWidth) mctx.drawImage(img, CROP.x, CROP.y, CROP.w, CROP.h, 0, 0, W, Hh);
      const px = (toPX(player.x) - CROP.x) * k, py = (toPY(player.z) - CROP.y) * k;
      const a = Math.atan2(-Math.cos(player.yaw), -Math.sin(player.yaw));
      const hf = Math.atan(Math.tan(THREE.MathUtils.degToRad(fov) / 2) * camera.aspect);
      const R = 1.6 / S * k;
      const grd = mctx.createRadialGradient(px, py, 0, px, py, R);
      grd.addColorStop(0, 'rgba(240,138,58,.55)'); grd.addColorStop(1, 'rgba(240,138,58,0)');
      mctx.fillStyle = grd; mctx.beginPath(); mctx.moveTo(px, py); mctx.arc(px, py, R, a - hf, a + hf); mctx.closePath(); mctx.fill();
      mctx.fillStyle = '#f08a3a'; mctx.strokeStyle = '#fff'; mctx.lineWidth = 2 * dpr;
      mctx.beginPath(); mctx.arc(px, py, 5 * dpr, 0, Math.PI * 2); mctx.fill(); mctx.stroke();
    }

    // ---------- ループ ----------
    const roomEl = $('.w3d-room'); let lastRoom = '';
    function resize() {
      const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    on(window, 'resize', resize); resize();
    const clock = new THREE.Clock(); let bob = 0, raf = 0, alive = true;
    function tick() {
      if (!alive) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      let f = 0, s = 0, turn = 0;
      if (keys.KeyW || keys.ArrowUp) f += 1; if (keys.KeyS || keys.ArrowDown) f -= 1;
      if (keys.KeyD) s += 1; if (keys.KeyA) s -= 1;
      if (keys.ArrowLeft || keys.KeyQ) turn += 1; if (keys.ArrowRight) turn -= 1;
      f += joy.y; s += joy.x;
      const len = Math.hypot(f, s); if (len > 1) { f /= len; s /= len; }
      if (mode === 'walk') {
        player.yaw += turn * 1.8 * dt;
        const sp = (keys.ShiftLeft || keys.ShiftRight ? 2.4 : 1.25) * dt;
        const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw), rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
        const mx = (fx * f + rx * s) * sp, mz = (fz * f + rz * s) * sp;
        if (mx && !blocked(player.x + mx, player.z)) player.x += mx;
        if (mz && !blocked(player.x, player.z + mz)) player.z += mz;
        if (mx || mz) bob += dt * 9; else bob *= 0.9;
      } else { orbit.theta -= s * 1.5 * dt; orbit.phi = Math.max(0.05, Math.min(1.45, orbit.phi - f * dt)); }
      const rm = roomAt(toPX(player.x), toPY(player.z));
      if (rm) player.fy = (KINDS[rm.kind] || KINDS.wood).y;
      player.y += (player.fy + player.eye - player.y) * Math.min(1, dt * 8);
      for (const d of openables) {
        const tgt = d.open ? 1 : 0;
        if (d.t !== tgt) { d.t = Math.max(0, Math.min(1, d.t + Math.sign(tgt - d.t) * dt * 1.8)); d.apply(d.t); }
      }
      if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
      if (mode === 'walk') { camera.position.set(player.x, player.y + Math.sin(bob) * 0.012, player.z); camera.rotation.set(player.pitch, player.yaw, 0); }
      else {
        camera.position.set(orbit.dist * Math.sin(orbit.phi) * Math.sin(orbit.theta), orbit.dist * Math.cos(orbit.phi), orbit.dist * Math.sin(orbit.phi) * Math.cos(orbit.theta));
        camera.lookAt(0, 0.5, 0);
        avatar.position.set(player.x, player.y - player.eye, player.z); avatar.rotation.y = player.yaw;
      }
      const txt = rm ? `${rm.name || '部屋'}\n${rm.jo ? rm.jo + '帖・' : ''}約 ${((rm.x2 - rm.x1) * S).toFixed(1)}m × ${((rm.y2 - rm.y1) * S).toFixed(1)}m` : '';
      if (txt !== lastRoom) {
        const [name, dim] = txt.split('\n');
        roomEl.textContent = name || '';
        if (dim) { const sm = document.createElement('small'); sm.textContent = dim; roomEl.appendChild(sm); }
        roomEl.style.display = txt ? '' : 'none'; lastRoom = txt;
      }
      renderer.render(scene, camera); drawMap();
      raf = requestAnimationFrame(tick);
    }
    setMode('walk'); tick();

    return {
      dispose() {
        alive = false; cancelAnimationFrame(raf);
        listeners.forEach(([t, type, fn, o]) => t.removeEventListener(type, fn, o));
        scene.traverse(o => { if (o.geometry) o.geometry.dispose(); });
        renderer.dispose(); root.innerHTML = ''; root.classList.remove('w3d', 'touch');
      },
    };
  }

  window.Walk3D = { mount, KINDS, JO };
})();
