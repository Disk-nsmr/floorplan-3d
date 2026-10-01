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

  function analyze(src, opt = {}) {
    // ---- 1. 画像を読み込み、暗い線を取り出す ----
    const sw = src.naturalWidth || src.width, sh = src.naturalHeight || src.height, big = Math.max(sw, sh);
    const k0 = big > 1400 ? 1400 / big : big < 1000 ? Math.min(3, 1200 / big) : 1;
    const W = Math.round((src.naturalWidth || src.width) * k0), H = Math.round((src.naturalHeight || src.height) * k0);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, W, H);
    const px = g.getImageData(0, 0, W, H).data, N = W * H;
    const dark = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const r = px[i * 4], gg = px[i * 4 + 1], b = px[i * 4 + 2];
      const l = 0.299 * r + 0.587 * gg + 0.114 * b, sat = Math.max(r, gg, b) - Math.min(r, gg, b);
      dark[i] = l < 115 && sat < 90 ? 1 : 0;
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
            if (gl > 0 && gl <= GMAX && prevLen >= MINRUN && len >= MINRUN) for (let t = prevEnd + 1; t < b; t++) gap[horiz ? a * W + t : t * W + a] = 1;
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
      gapInfo.push({ type, along, arc, pix: c.pix });
    }

    // ---- 4. 縮尺を決める ----
    const doors = gapInfo.filter(o => o.arc === 1).map(o => o.along);
    const sT = 0.13 / T, sD = doors.length ? 0.75 / median(doors) : NaN;
    let S = isFinite(sD) && sD / sT < 3 && sT / sD < 3 ? Math.sqrt(sT * sD) : sT;

    // ---- 5. 部屋（壁に囲まれた内側）を見つける ----
    const inside = new Uint8Array(N); for (let i = 0; i < N; i++) inside[i] = !barrier[i] && !outside[i] ? 1 : 0;
    const roomC = components(inside, W, H, false);

    const finish = Sx => {
      const minRoom = 0.8 / (Sx * Sx);
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

    const imageUrl = cv.toDataURL('image/jpeg', 0.9);
    return {
      plan: { version: 1, mode: 'auto', title: '', image: imageUrl, imgW: W, imgH: H, scale: S, ceiling: HC, walls, openings: [], rooms: planRooms, items: [], floorRects },
      stats: { T, S, sT, sD, rooms: planRooms.length, opens: gapInfo.filter(o => o.type === 'open').length, doors: gapInfo.filter(o => o.type === 'door').length, windows: gapInfo.filter(o => o.type === 'window').length, wallRects: walls.length },
      masks: { W, H, thick, gap, inside, doorM, winM, winLowM, k0, biggest: rooms.length ? rooms[0].pix : [] },
    };
  }

  window.Auto3D = { analyze };
})();
