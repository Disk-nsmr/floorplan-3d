// 間取り図の画像から壁・ドア・窓・部屋を自動で読み取り、Walk3D 用の間取りデータを作る
// 使い方: const r = Auto3D.analyze(imgElement, { jo }); Walk3D.mount(el, r.plan)
(function () {
  const JO = 1.62;

  // ---------- 2値画像の処理 ----------
  function runs(mask, W, H, horiz) {
    // 各画素が属する連続区間の長さ
    const out = new Uint16Array(W * H);
    const A = horiz ? H : W, B = horiz ? W : H;
    for (let a = 0; a < A; a++) {
      let b = 0;
      while (b < B) {
        const i = horiz ? a * W + b : b * W + a;
        if (!mask[i]) { b++; continue; }
        let e = b; while (e < B && mask[horiz ? a * W + e : e * W + a]) e++;
        const len = Math.min(65535, e - b);
        for (let t = b; t < e; t++) out[horiz ? a * W + t : t * W + a] = len;
        b = e;
      }
    }
    return out;
  }
  function filter1D(mask, W, H, k, horiz, erode) {
    const out = new Uint8Array(W * H);
    const lo = Math.floor((k - 1) / 2), hi = k - 1 - lo;
    const a0 = erode ? lo : hi, a1 = erode ? hi : lo;  // 膨張は窓を反転させて、開閉処理を正確にする
    const A = horiz ? H : W, B = horiz ? W : H;
    const pre = new Int32Array(B + 1);
    for (let a = 0; a < A; a++) {
      for (let b = 0; b < B; b++) pre[b + 1] = pre[b] + mask[horiz ? a * W + b : b * W + a];
      for (let b = 0; b < B; b++) {
        const s = Math.max(0, b - a0), e = Math.min(B - 1, b + a1);
        const sum = pre[e + 1] - pre[s];
        const v = erode ? (sum === k ? 1 : 0) : (sum > 0 ? 1 : 0);
        out[horiz ? a * W + b : b * W + a] = v;
      }
    }
    return out;
  }
  const open2D = (m, W, H, k) => filter1D(filter1D(filter1D(filter1D(m, W, H, k, true, true), W, H, k, false, true), W, H, k, true, false), W, H, k, false, false);
  const dilate2D = (m, W, H, k) => filter1D(filter1D(m, W, H, k, true, false), W, H, k, false, false);

  function components(mask, W, H, eight) {
    const lab = new Int32Array(W * H).fill(-1), comps = [];
    const stack = new Int32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i] || lab[i] >= 0) continue;
      const id = comps.length, c = { id, area: 0, x1: W, y1: H, x2: 0, y2: 0, pix: [] };
      let sp = 0; stack[sp++] = i; lab[i] = id;
      while (sp) {
        const p = stack[--sp], x = p % W, y = (p / W) | 0;
        c.area++; c.pix.push(p);
        if (x < c.x1) c.x1 = x; if (x > c.x2) c.x2 = x; if (y < c.y1) c.y1 = y; if (y > c.y2) c.y2 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          if (!eight && dx && dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (mask[q] && lab[q] < 0) { lab[q] = id; stack[sp++] = q; }
        }
      }
      comps.push(c);
    }
    return { lab, comps };
  }

  // マスクを長方形の集まりに分解（cs 画素ごとのセル単位）
  function rects(mask, W, H, cs) {
    const GW = Math.ceil(W / cs), GH = Math.ceil(H / cs), grid = new Uint8Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
      let on = 0, n = 0;
      for (let y = gy * cs; y < Math.min(H, gy * cs + cs); y++) for (let x = gx * cs; x < Math.min(W, gx * cs + cs); x++) { n++; on += mask[y * W + x]; }
      grid[gy * GW + gx] = on * 2 >= n ? 1 : 0;
    }
    const out = [], open = new Map();
    for (let gy = 0; gy <= GH; gy++) {
      const rowRuns = [];
      if (gy < GH) {
        let x = 0;
        while (x < GW) {
          if (!grid[gy * GW + x]) { x++; continue; }
          let e = x; while (e < GW && grid[gy * GW + e]) e++;
          rowRuns.push([x, e]); x = e;
        }
      }
      const next = new Map();
      for (const [x0, x1] of rowRuns) {
        const key = x0 + ',' + x1;
        if (open.has(key)) { next.set(key, open.get(key)); open.delete(key); }
        else next.set(key, { x0, x1, y0: gy });
      }
      for (const r of open.values()) out.push({ x1: r.x0 * cs, x2: Math.min(W, r.x1 * cs), y1: r.y0 * cs, y2: Math.min(H, gy * cs) });
      open.clear(); for (const [k, v] of next) open.set(k, v);
    }
    return out;
  }
  const median = a => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : NaN; };


  // ---------- 設備（キッチン・浴槽・トイレ・洗面台・洗濯機）の読み取り ----------
  // 設備記号の「理想の輪郭」（便器＝楕円、浴槽＝角の丸い四角、コンロ・洗面ボウル＝円、シンク＝四角）を
  // 実寸の大きさで部屋の中に当てはめ、輪郭の点が図面の線にどれだけ近いかで見つける。
  // 線のかすれや、記号が壁にくっついていても見つけられる。
  function distanceMap(ink, W, H) {
    const D = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) D[i] = ink[i] ? 0 : 1e6;
    const R2 = Math.SQRT2;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let d = D[i];
      if (x > 0) d = Math.min(d, D[i - 1] + 1);
      if (y > 0) { d = Math.min(d, D[i - W] + 1); if (x > 0) d = Math.min(d, D[i - W - 1] + R2); if (x < W - 1) d = Math.min(d, D[i - W + 1] + R2); }
      D[i] = d;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let d = D[i];
      if (x < W - 1) d = Math.min(d, D[i + 1] + 1);
      if (y < H - 1) { d = Math.min(d, D[i + W] + 1); if (x < W - 1) d = Math.min(d, D[i + W + 1] + R2); if (x > 0) d = Math.min(d, D[i + W - 1] + R2); }
      D[i] = d;
    }
    return D;
  }
  // 輪郭の点列（中心からの相対位置、m）
  const shapeEllipse = (a, b, n = 40) => Array.from({ length: n }, (_, k) => { const t = k / n * Math.PI * 2; return [a * Math.cos(t), b * Math.sin(t)]; });
  function shapeRRect(w, h, r, n = 56) {
    const pts = [], hw = w / 2, hh = h / 2, per = 2 * (w + h - 4 * r) + 2 * Math.PI * r;
    for (let k = 0; k < n; k++) {
      let d = k / n * per;
      const segs = [
        [w - 2 * r, t => [-hw + r + t, -hh]], [Math.PI * r / 2, t => { const a = -Math.PI / 2 + t / r; return [hw - r + r * Math.cos(a), -hh + r + r * Math.sin(a)]; }],
        [h - 2 * r, t => [hw, -hh + r + t]], [Math.PI * r / 2, t => { const a = t / r; return [hw - r + r * Math.cos(a), hh - r + r * Math.sin(a)]; }],
        [w - 2 * r, t => [hw - r - t, hh]], [Math.PI * r / 2, t => { const a = Math.PI / 2 + t / r; return [-hw + r + r * Math.cos(a), hh - r + r * Math.sin(a)]; }],
        [h - 2 * r, t => [-hw, hh - r - t]], [Math.PI * r / 2, t => { const a = Math.PI + t / r; return [-hw + r + r * Math.cos(a), -hh + r + r * Math.sin(a)]; }],
      ];
      for (const [len, f] of segs) { if (d <= len) { pts.push(f(d)); break; } d -= len; }
    }
    return pts;
  }
  const rot90 = pts => pts.map(([x, y]) => [-y, x]);

  function detectFixtures({ W, H, S, ink, thick, inside, roomLab, rooms, entranceRooms }) {
    const D = distanceMap(ink, W, H);
    const CAP = 6, THR = 1.1;
    const step = Math.max(2, Math.round(0.04 / S));
    // tpls: [{pts(px), w, h(px), tag}]
    const toPx = (pts, k) => pts.map(([x, y]) => [Math.round(x * k / S), Math.round(y * k / S)]);
    function bestMatch(room, tpls, avoid = []) {
      let best = null;
      for (let y = room.y1; y <= room.y2; y += step) for (let x = room.x1; x <= room.x2; x += step) {
        if (roomLab[y * W + x] !== room.id) continue;
        if (avoid.some(a => x > a.x1 && x < a.x2 && y > a.y1 && y < a.y2)) continue;
        for (const t of tpls) {
          let c = 0;
          for (const [dx, dy] of t.pts) {
            const xx = x + dx, yy = y + dy;
            c += xx < 0 || yy < 0 || xx >= W || yy >= H ? CAP : Math.min(D[yy * W + xx], CAP);
            if (c > THR * t.pts.length) break;
          }
          c /= t.pts.length;
          if (c < THR && (!best || c < best.cost) && emptyInside(t, x, y)) best = { cost: c, x, y, t };
        }
      }
      return best;
    }
    function allMatches(room, tpls, avoid = []) {
      const out = [];
      for (let y = room.y1; y <= room.y2; y += step) for (let x = room.x1; x <= room.x2; x += step) {
        if (roomLab[y * W + x] !== room.id) continue;
        if (avoid.some(a => x > a.x1 && x < a.x2 && y > a.y1 && y < a.y2)) continue;
        for (const t of tpls) {
          let c = 0;
          for (const [dx, dy] of t.pts) { const xx = x + dx, yy = y + dy; c += xx < 0 || yy < 0 || xx >= W || yy >= H ? CAP : Math.min(D[yy * W + xx], CAP); }
          c /= t.pts.length;
          if (c < THR && emptyInside(t, x, y)) out.push({ cost: c, x, y, t });
        }
      }
      out.sort((a, b) => a.cost - b.cost);
      const kept = [];
      for (const m of out) if (!kept.some(k => Math.hypot(k.x - m.x, k.y - m.y) < Math.max(k.t.w, k.t.h) / 2)) kept.push(m);
      return kept;
    }
    const scales = [0.85, 1, 1.15];
    const innerGrid = (wM, hM, oval) => {
      const g = [];
      for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
        const u = (i / 4 - 0.5) * 0.6, v = (j / 4 - 0.5) * 0.6;
        if (oval && u * u + v * v > 0.09) continue;
        g.push([u * wM, v * hM]);
      }
      return g;
    };
    const mk = (pts, wM, hM, tag, oval = false, empty = 0.15) => scales.map(k => ({ pts: toPx(pts, k), inner: toPx(innerGrid(wM, hM, oval), k), w: wM * k / S, h: hM * k / S, tag, empty }));
    // 輪郭の内側がほとんど白いこと（タイルの目地や文字の上では当てはまらない）
    const emptyInside = (t, x, y) => {
      let on = 0;
      for (const [dx, dy] of t.inner) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && D[yy * W + xx] <= 1.5) on++; }
      return on / t.inner.length <= t.empty;
    };
    const T_TUB = [], T_BOWL = [], T_CIRC = [], T_SINK = [], T_SQ = [];
    for (const [w, h] of [[0.55, 0.95], [0.6, 1.1], [0.65, 1.25], [0.7, 1.4], [0.75, 1.55]]) {
      const p = shapeRRect(w, h, 0.1);
      T_TUB.push(...mk(p, w, h, 'v'), ...mk(rot90(p), h, w, 'h'));
    }
    // 便器は便座の線、コンロは五徳の輪が内側にあるので、内側の線を多めに許す
    for (const [a, b] of [[0.16, 0.22], [0.18, 0.25]]) { const p = shapeEllipse(a, b); T_BOWL.push(...mk(p, a * 2, b * 2, 'v', true, 0.4), ...mk(rot90(p), b * 2, a * 2, 'h', true, 0.4)); }
    for (const r of [0.1, 0.13, 0.17, 0.21]) T_CIRC.push(...mk(shapeEllipse(r, r, 32), r * 2, r * 2, 'o', true, 0.5));
    for (const [w, h] of [[0.35, 0.45], [0.42, 0.55]]) { const p = shapeRRect(w, h, 0.02, 40); T_SINK.push(...mk(p, w, h, 'v', false, 0.25), ...mk(rot90(p), h, w, 'h', false, 0.25)); }
    const T_DRAIN = [];
    for (const r of [0.035, 0.05, 0.07]) T_DRAIN.push(...mk(shapeEllipse(r, r, 20), r * 2, r * 2, 'o', true, 0.6));
    for (const w of [0.6, 0.7]) T_SQ.push(...mk(shapeRRect(w, w, 0.02, 48), w, w, 's', false, 0.25));

    const box = m => ({ x1: m.x - m.t.w / 2, y1: m.y - m.t.h / 2, x2: m.x + m.t.w / 2, y2: m.y + m.t.h / 2 });
    const m2p = m => Math.round(m / S);
    function wallGap(r, side, maxPx) {
      for (let k = 1; k <= maxPx; k++) {
        if (side === 0 || side === 2) {
          const y = Math.round(side === 0 ? r.y1 - k : r.y2 - 1 + k); if (y < 0 || y >= H) return maxPx + 1;
          for (let x = Math.round(r.x1); x < r.x2; x++) if (thick[y * W + x]) return k;
        } else {
          const x = Math.round(side === 1 ? r.x2 - 1 + k : r.x1 - k); if (x < 0 || x >= W) return maxPx + 1;
          for (let y = Math.round(r.y1); y < r.y2; y++) if (thick[y * W + x]) return k;
        }
      }
      return maxPx + 1;
    }
    // 一番近い壁の側に背を向け、壁まで伸ばす。side: 0上 1右 2下 3左（Walk3D の rot と同じ）
    function toWall(r, maxM, sides = [0, 1, 2, 3]) {
      const mx = m2p(maxM); let best = -1, bd = 1e9;
      for (const sd of sides) { const d = wallGap(r, sd, mx); if (d < bd) { bd = d; best = sd; } }
      const o = { ...r };
      if (best < 0 || bd > mx) return { r: o, rot: 0 };
      if (best === 0) o.y1 -= bd - 1; if (best === 2) o.y2 += bd - 1;
      if (best === 3) o.x1 -= bd - 1; if (best === 1) o.x2 += bd - 1;
      return { r: o, rot: best };
    }
    const grow = (r, m) => { const k = m / S; return { x1: r.x1 - k, y1: r.y1 - k, x2: r.x2 + k, y2: r.y2 + k }; };
    function ensureDepth(r, rot, depthM) {
      const vert = rot === 0 || rot === 2, cur = (vert ? r.y2 - r.y1 : r.x2 - r.x1) * S, need = (depthM - cur) / S;
      if (need <= 0) return r;
      if (rot === 0) r.y2 += need; else if (rot === 2) r.y1 -= need; else if (rot === 1) r.x1 -= need; else r.x2 += need;
      return r;
    }
    const items = [];
    // 設備は部屋の内側に収める（壁を突き抜けて外に出ないように）
    const add = (type, r, rot, rm) => {
      const c = rm ? { x1: Math.max(r.x1, rm.x1), y1: Math.max(r.y1, rm.y1), x2: Math.min(r.x2, rm.x2 + 1), y2: Math.min(r.y2, rm.y2 + 1) } : r;
      if (c.x2 - c.x1 < 2 || c.y2 - c.y1 < 2) return;
      items.push({ id: 'i' + items.length, type, x1: Math.round(c.x1), y1: Math.round(c.y1), x2: Math.round(c.x2), y2: Math.round(c.y2), rot });
    };

    const areaM = r => r.area * S * S;
    const sidesM = r => { const a = (r.x2 - r.x1 + 1) * S, b = (r.y2 - r.y1 + 1) * S; return [Math.min(a, b), Math.max(a, b)]; };
    const used = new Map(); // 部屋ごとに使った範囲
    const usedIn = r => used.get(r.id) || [];
    const mark = (r, b) => used.set(r.id, [...usedIn(r), b]);
    const bathRooms = new Set();

    // 壁に接している辺の数（0.2m 以内）
    const wallSides = b => [0, 1, 2, 3].filter(sd => wallGap(b, sd, m2p(0.2)) <= m2p(0.2));
    const cornered = b => { const sd = wallSides(b); return sd.some(a => sd.includes((a + 1) % 4)); };

    // 1) 浴槽：浴室くらいの広さ（1.2〜4.5㎡）の部屋で、角（2面の壁）に接する角丸の四角。家全体で一番よく合うもの
    let tub = null, tubRoom = null;
    for (const rm of rooms) {
      const A = areaM(rm), [mn, mx] = sidesM(rm);
      if (A < 1.2 || A > 4.5 || mn < 0.95 || mx > 2.6) continue;
      for (const m of allMatches(rm, T_TUB).slice(0, 8)) {
        if (m.cost > 0.9 || !cornered(box(m))) continue;
        if (!tub || m.cost < tub.cost) { tub = m; tubRoom = rm; }
        break;
      }
    }
    if (tub) {
      bathRooms.add(tubRoom.id);
      const tb = box(tub); mark(tubRoom, grow(tb, 0.05));
      add('tub', grow(tb, 0.05), toWall(tb, 0.3).rot, tubRoom);
      // 洗面台：同じ部屋の、浴槽に一番近い丸・楕円
      const cands = allMatches(tubRoom, T_CIRC.concat(T_BOWL), usedIn(tubRoom)).sort((a, b) => Math.hypot(a.x - tub.x, a.y - tub.y) - Math.hypot(b.x - tub.x, b.y - tub.y));
      if (cands[0]) { const b = box(cands[0]); mark(tubRoom, grow(b, 0.1)); const { r, rot } = toWall(grow(b, 0.08), 0.45); add('basin', ensureDepth(r, rot, 0.45), rot, tubRoom); }
    }
    // 2) トイレ：浴槽のない細い小部屋（0.5〜2.2㎡、短い辺 1.1m 以下）。楕円が円よりはっきり当てはまるもののうち、家全体で一番よく合うもの
    const toiletRooms = new Set();
    let bestBowl = null;
    for (const rm of rooms) {
      const A = areaM(rm), [mn, mx] = sidesM(rm);
      if (bathRooms.has(rm.id) || entranceRooms.has(rm.id) || A > 2.2 || A < 0.5 || mn > 1.1 || mx / mn < 1.25) continue;
      const bowl = bestMatch(rm, T_BOWL);
      if (!bowl || bowl.cost > 1.0) continue;
      const circ = bestMatch({ ...rm, x1: bowl.x - step, x2: bowl.x + step, y1: bowl.y - step, y2: bowl.y + step }, T_CIRC);
      if (circ && circ.cost < bowl.cost * 0.8) continue;
      if (!bestBowl || bowl.cost < bestBowl.cost) bestBowl = { ...bowl, rm };
    }
    if (bestBowl) {
      // タンクはトイレ室の短い壁のうち、便器に近い方。便器は部屋の中に収める
      const bowl = bestBowl, rm = bowl.rm;
      const longY = rm.y2 - rm.y1 >= rm.x2 - rm.x1;
      const depth = 0.72 / S, half = Math.min(0.21 / S, (longY ? rm.x2 - rm.x1 : rm.y2 - rm.y1) / 2);
      let r, rot;
      if (longY) {
        const c = Math.max(rm.x1 + half, Math.min(rm.x2 + 1 - half, bowl.x));
        rot = bowl.y - rm.y1 <= rm.y2 - bowl.y ? 0 : 2;
        r = rot === 0 ? { x1: c - half, x2: c + half, y1: rm.y1, y2: rm.y1 + depth } : { x1: c - half, x2: c + half, y1: rm.y2 + 1 - depth, y2: rm.y2 + 1 };
      } else {
        const c = Math.max(rm.y1 + half, Math.min(rm.y2 + 1 - half, bowl.y));
        rot = bowl.x - rm.x1 <= rm.x2 - bowl.x ? 3 : 1;
        r = rot === 3 ? { y1: c - half, y2: c + half, x1: rm.x1, x2: rm.x1 + depth } : { y1: c - half, y2: c + half, x1: rm.x2 + 1 - depth, x2: rm.x2 + 1 };
      }
      toiletRooms.add(rm.id); mark(rm, r); add('toilet', r, rot, rm);
    }
    // 3) キッチン：浴室・トイレ以外の部屋で、シンク（四角）とコンロ（円）が並ぶ組。家全体で一番よく合うもの
    let pick = null;
    for (const rm of rooms) {
      if (bathRooms.has(rm.id) || toiletRooms.has(rm.id) || areaM(rm) < 1.5) continue;
      const sinks = allMatches(rm, T_SINK, usedIn(rm)).slice(0, 8);
      const circs = allMatches(rm, T_CIRC, usedIn(rm)).slice(0, 12);
      for (const sk of sinks) for (const ci of circs) {
        const d = Math.hypot(sk.x - ci.x, sk.y - ci.y) * S;
        const aligned = Math.abs(sk.x - ci.x) * S < 0.25 || Math.abs(sk.y - ci.y) * S < 0.25;
        if (d < 0.3 || d > 1.3 || !aligned) continue;
        const score = sk.cost + ci.cost;
        if (!pick || score < pick.score) pick = { sk, ci, score, rm };
      }
    }
    if (pick) {
      const a = box(pick.sk), b = box(pick.ci);
      let r = grow({ x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1), x2: Math.max(a.x2, b.x2), y2: Math.max(a.y2, b.y2) }, 0.08);
      const horizK = Math.abs(pick.sk.x - pick.ci.x) >= Math.abs(pick.sk.y - pick.ci.y);
      for (const o of allMatches(pick.rm, T_SINK.concat(T_CIRC), usedIn(pick.rm))) {
        const ob = box(o);
        const inLine = horizK ? Math.abs(o.y - (r.y1 + r.y2) / 2) * S < 0.25 : Math.abs(o.x - (r.x1 + r.x2) / 2) * S < 0.25;
        const gapM = (horizK ? Math.max(ob.x1 - r.x2, r.x1 - ob.x2) : Math.max(ob.y1 - r.y2, r.y1 - ob.y2)) * S;
        if (inLine && gapM < 0.15) r = { x1: Math.min(r.x1, ob.x1), y1: Math.min(r.y1, ob.y1), x2: Math.max(r.x2, ob.x2), y2: Math.max(r.y2, ob.y2) };
      }
      const res = toWall(r, 0.5, horizK ? [0, 2] : [1, 3]);
      r = ensureDepth(res.r, res.rot, 0.62);
      mark(pick.rm, grow(r, 0.3)); add('kitchen', r, res.rot, pick.rm);
    }
    // 4) 洗濯機：浴室・トイレ以外で、壁ぎわにある 0.6〜0.7m の正方形（防水パン）。一番よく合うもの
    let wash = null;
    for (const rm of rooms) {
      if (bathRooms.has(rm.id) || toiletRooms.has(rm.id)) continue;
      for (const m of allMatches(rm, T_SQ, usedIn(rm)).slice(0, 4)) {
        if (m.cost > 0.8 || !wallSides(box(m)).length) continue;
        const b = box(m);
        if (!bestMatch({ ...rm, x1: Math.round(b.x1), y1: Math.round(b.y1), x2: Math.round(b.x2), y2: Math.round(b.y2) }, T_DRAIN)) continue;
        if (!wash || m.cost < wash.cost) wash = { ...m, rm };
        break;
      }
    }
    if (wash) { const b = box(wash); add('washer', b, toWall(b, 0.3).rot, wash.rm); }
    return items;
  }

  function analyze(src, opt = {}) {
    // ---- 1. 画像を読み込み、暗い線を取り出す ----
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height, big = Math.max(sw, sh);
    const k0 = big > 1400 ? 1400 / big : big < 1000 ? Math.min(3, 1200 / big) : 1;
    const W = Math.round((src.naturalWidth || src.width) * k0), H = Math.round((src.naturalHeight || src.height) * k0);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, N = W * H;
    const dark = new Uint8Array(N), ink = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
      const l = 0.299 * r + 0.587 * gg + 0.114 * b, sat = Math.max(r, gg, b) - Math.min(r, gg, b);
      dark[i] = l < 115 && sat < 90 ? 1 : 0;
      ink[i] = l < 215 ? 1 : 0;
    }

    // ---- 2. 壁の太さを推定し、太い線（＝壁）だけを残す ----
    const hr = runs(dark, W, H, true), vr = runs(dark, W, H, false);
    const hist = new Float64Array(100);
    for (let i = 0; i < N; i++) if (dark[i]) { const t = Math.min(hr[i], vr[i]); if (t < 100) hist[t]++; }
    let T = 0, best = 0;
    for (let t = 3; t < 99; t++) { const s = (hist[t - 1] + hist[t] + hist[t + 1]) * t; if (s > best) { best = s; T = t; } }
    if (!T || hist[T] < 50) T = 2;
    const kk = Math.max(2, Math.round(T * 0.6));
    let thick = open2D(dark, W, H, kk);
    {
      const { comps } = components(thick, W, H, true), keep = new Uint8Array(N);
      for (const c of comps) {
        const bw = c.x2 - c.x1 + 1, bh = c.y2 - c.y1 + 1;
        if (Math.max(bw, bh) >= 3 * T && c.area >= 2 * T * T) for (const p of c.pix) keep[p] = 1;
      }
      thick = keep;
    }

    // ---- 3. 壁の切れ目（ドア・窓）を見つける ----
    const tH = runs(thick, W, H, true), tV = runs(thick, W, H, false);
    const gap = new Uint8Array(N), GMAX = 24 * T, MINRUN = 1.5 * T;
    for (let pass = 0; pass < 2; pass++) {
      const horiz = pass === 0, A = horiz ? H : W, B = horiz ? W : H, RL = horiz ? tH : tV;
      for (let a = 0; a < A; a++) {
        let prevEnd = -1, prevLen = 0;
        for (let b = 0; b < B; b++) {
          const i = horiz ? a * W + b : b * W + a;
          if (!thick[i]) continue;
          const len = RL[i];
          if (prevEnd >= 0) {
            const gl = b - prevEnd - 1;
            if (gl > 0 && gl <= GMAX && Math.max(prevLen, len) >= MINRUN && Math.min(prevLen, len) >= 0.8 * T) for (let t = prevEnd + 1; t < b; t++) gap[horiz ? a * W + t : t * W + a] = 1;
          }
          prevEnd = b + len - 1; prevLen = len; b = prevEnd;
        }
      }
    }
    // ---- 3b. 建物の外側を求める（壁と切れ目を境界にして、画像の端から塗りつぶす） ----
    const barrier = new Uint8Array(N); for (let i = 0; i < N; i++) barrier[i] = thick[i] | gap[i];
    const D = Math.max(3, 3 * T), sealed = dilate2D(barrier, W, H, D);
    const outside = new Uint8Array(N), queue = new Int32Array(N); let qh = 0, qt = 0;
    const push = i => { if (!sealed[i] && !outside[i]) { outside[i] = 1; queue[qt++] = i; } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (qh < qt) {
      const p = queue[qh++], x = p % W, y = (p / W) | 0;
      if (x > 0) push(p - 1); if (x < W - 1) push(p + 1); if (y > 0) push(p - W); if (y < H - 1) push(p + W);
    }
    // 壁ぎわまで外側を広げ直す（壁の外にはみ出した床を消す）
    let front = []; for (let i = 0; i < N; i++) if (outside[i]) front.push(i);
    for (let s = 0; s < D + 1; s++) {
      const nf = [];
      for (const p of front) {
        const x = p % W, y = (p / W) | 0;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
          if (q >= 0 && !outside[q] && !barrier[q]) { outside[q] = 1; nf.push(q); }
        }
      }
      front = nf;
    }
    const gapC = components(gap, W, H, true);
    const doorM = new Uint8Array(N), winLowM = new Uint8Array(N), winM = new Uint8Array(N);
    const gapInfo = [];
    for (const c of gapC.comps) {
      const bw = c.x2 - c.x1 + 1, bh = c.y2 - c.y1 + 1, across = Math.min(bw, bh), along = Math.max(bw, bh);
      if (across < 0.5 * T || along < 1.5 * T) { for (const p of c.pix) gap[p] = 0; continue; }
      const horizGap = bw >= bh;
      // 開き戸の円弧（ドアの軌跡）が切れ目の脇に描かれていればドア
      const nearDark = (x, y) => {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const xx = Math.round(x + dx), yy = Math.round(y + dy);
          if (xx >= 0 && yy >= 0 && xx < W && yy < H && dark[yy * W + xx]) return true;
        }
        return false;
      };
      const cx0 = (c.x1 + c.x2) / 2, cy0 = (c.y1 + c.y2) / 2;
      const ends = horizGap ? [[c.x1, cy0, 1, 0], [c.x2, cy0, -1, 0]] : [[cx0, c.y1, 0, 1], [cx0, c.y2, 0, -1]];
      let arc = 0;  // 0: なし, 1: 片開き, 2: 両開き
      for (const [ex, ey, ux, uy] of ends) for (const side of [1, -1]) for (const [R, kind] of [[along, 1], [along * 0.9, 1], [along * 1.1, 1], [along / 2, 2]]) {
        const nx = -uy * side, ny = ux * side;
        let hit = 0, n = 0;
        for (let th = 0.2; th <= 1.4; th += 0.1) {
          n++;
          if (nearDark(ex + R * (Math.cos(th) * ux + Math.sin(th) * nx), ey + R * (Math.cos(th) * uy + Math.sin(th) * ny))) hit++;
        }
        if (hit / n >= 0.75 && (!arc || kind === 1)) arc = kind;
      }
      const nx0 = horizGap ? 0 : 1, ny0 = horizGap ? 1 : 0, off = across / 2 + 2 * T;
      let exterior = false;
      for (const f of [0.25, 0.5, 0.75]) {
        const px0 = horizGap ? c.x1 + (c.x2 - c.x1) * f : cx0, py0 = horizGap ? cy0 : c.y1 + (c.y2 - c.y1) * f;
        for (const sgn of [1, -1]) {
          const xx = Math.round(px0 + nx0 * off * sgn), yy = Math.round(py0 + ny0 * off * sgn);
          if (xx < 0 || yy < 0 || xx >= W || yy >= H || outside[yy * W + xx]) exterior = true;
        }
      }
      // 円弧があればドア、外壁で円弧がなければ窓、内壁で円弧がなければ扉のない開口
      const type = arc ? 'door' : exterior ? 'window' : 'open';
      gapInfo.push({ type, along, arc, exterior, pix: c.pix });
    }

    // ---- 4. 縮尺を決める ----
    const doors = gapInfo.filter(o => o.arc === 1).map(o => o.along);
    const sT = 0.13 / T, sD = doors.length ? 0.75 / median(doors) : NaN;
    let S = isFinite(sD) && sD / sT < 3 && sT / sD < 3 ? Math.sqrt(sT * sD) : sT;

    // ---- 5. 部屋（壁に囲まれた内側）を見つける ----
    const inside = new Uint8Array(N); for (let i = 0; i < N; i++) inside[i] = !barrier[i] && !outside[i] ? 1 : 0;
    const roomC = components(inside, W, H, false);

    const finish = Sx => {
      const minRoom = 0.45 / (Sx * Sx);
      const rooms = roomC.comps.filter(c => c.area >= minRoom).sort((a, b) => b.area - a.area);
      return { Sx, rooms };
    };
    let { rooms } = finish(S);
    if (opt.jo > 0 && rooms.length) { S = Math.sqrt(opt.jo * JO / rooms[0].area); rooms = finish(S).rooms; }

    // ---- 6. Walk3D 用のデータに変換 ----
    const HC = 2.4, cs = Math.max(1, Math.round(T / 2));
    const walls = [];
    const addRects = (mask, extra) => {
      for (const r of rects(mask, W, H, cs)) {
        const w = r.x2 - r.x1, h = r.y2 - r.y1; if (w <= 0 || h <= 0) continue;
        const seg = w >= h
          ? { a: [r.x1, (r.y1 + r.y2) / 2], b: [r.x2, (r.y1 + r.y2) / 2], t: h * S }
          : { a: [(r.x1 + r.x2) / 2, r.y1], b: [(r.x1 + r.x2) / 2, r.y2], t: w * S };
        walls.push({ id: 'w' + walls.length, ...seg, ...extra });
      }
    };
    for (const o of gapInfo) {
      const m = o.type !== 'window' ? doorM : (o.along * S >= 1.5 ? winLowM : winM);
      for (const p of o.pix) m[p] = 1;
    }
    addRects(thick, {});
    addRects(doorM, { bottom: 2.0 });
    addRects(winM, { bottom: 2.0 }); addRects(winM, { top: 0.9 }); addRects(winM, { glass: true, bottom: 0.9, top: 2.0 });
    addRects(winLowM, { bottom: 2.0 }); addRects(winLowM, { top: 0.03 }); addRects(winLowM, { glass: true, bottom: 0.03, top: 2.0 });

    const floorM = new Uint8Array(N); for (let i = 0; i < N; i++) floorM[i] = inside[i] | doorM[i];
    const floorRects = rects(floorM, W, H, cs);

    // 部屋の中心：壁から一番遠い点
    const distTo = new Float32Array(N).fill(1e9); qh = 0; qt = 0;
    for (let i = 0; i < N; i++) if (!inside[i]) { distTo[i] = 0; queue[qt++] = i; }
    while (qh < qt) {
      const p = queue[qh++], x = p % W, y = (p / W) | 0, d = distTo[p] + 1;
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) if (q >= 0 && distTo[q] > d) { distTo[q] = d; queue[qt++] = q; }
    }
    const planRooms = rooms.map((c, i) => {
      let bp = c.pix[0]; for (const p of c.pix) if (distTo[p] > distTo[bp]) bp = p;
      const jo = Math.round(c.area * S * S / JO * 10) / 10;
      return { id: 'r' + i, name: `部屋${i + 1}`, kind: 'wood', jo, noFloor: true, x1: c.x1, y1: c.y1, x2: c.x2 + 1, y2: c.y2 + 1, cx: bp % W, cy: (bp / W) | 0 };
    });

    // 玄関（外へのドア・出入口に面した部屋）
    const entranceRooms = new Set();
    for (const o of gapInfo) {
      if (!o.exterior || o.type === 'window') continue;
      for (const p of o.pix) for (const q of [p - 1, p + 1, p - W, p + W]) { const l = roomC.lab[q]; if (q >= 0 && q < N && l >= 0) entranceRooms.add(l); }
    }
    const items = opt.fixtures === false ? [] : detectFixtures({ W, H, S, ink, thick, inside, roomLab: roomC.lab, rooms, entranceRooms });
    const imageUrl = cv.toDataURL('image/jpeg', 0.9);
    return {
      plan: { version: 1, mode: 'auto', title: '', image: imageUrl, imgW: W, imgH: H, scale: S, ceiling: HC, walls, openings: [], rooms: planRooms, items, floorRects },
      stats: { T, S, sT, sD, rooms: planRooms.length, opens: gapInfo.filter(o => o.type === 'open').length, doors: gapInfo.filter(o => o.type === 'door').length, windows: gapInfo.filter(o => o.type === 'window').length, wallRects: walls.length, items: items.reduce((a, it) => (a[it.type] = (a[it.type] || 0) + 1, a), {}) },
      masks: { W, H, thick, gap, inside, doorM, winM, winLowM, k0, biggest: rooms.length ? rooms[0].pix : [] },
    };
  }

  window.Auto3D = { analyze };
})();
