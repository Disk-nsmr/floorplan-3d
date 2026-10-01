// 間取りデータをサイト（GitHub リポジトリ）に1回のコミットで公開する
// 必要なもの：リポジトリへの書き込み権限があるアクセストークン（管理者ページと同じもの）
(function () {
  const OWNER = 'Disk-nsmr', REPO = 'floorplan-3d', BRANCH = 'main';
  const TOKEN_KEY = 'floorplan-admin-token';

  const tokenStore = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } },
    set(t, remember) { try { (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, t); } catch (e) {} },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) {} },
  };

  async function gh(token, path, opts = {}) {
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
      ...opts, cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token, 'X-GitHub-Api-Version': '2022-11-28', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    let body = null; try { body = await r.json(); } catch (e) {}
    return { status: r.status, ok: r.ok, body };
  }
  const b64utf8 = str => { const bytes = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));
  async function readJson(token, path, fallback) {
    const r = await gh(token, `/contents/${path}?ref=${BRANCH}`);
    if (r.status === 404) return fallback;
    if (!r.ok) throw new Error(`サイトのファイルを読めませんでした（${r.status}）`);
    return JSON.parse(unb64(r.body.content));
  }

  // 権限を確認する。問題があれば日本語のメッセージで例外を投げる
  async function checkToken(token) {
    const repo = await gh(token, '');
    if (repo.status === 401) { tokenStore.clear(); throw new Error('トークンが正しくないか、有効期限が切れています。入れ直してください。'); }
    if (!repo.ok) throw new Error('サイトのリポジトリを確認できませんでした（' + repo.status + '）。');
    const p = repo.body.permissions || {};
    if (!(p.push || p.admin || p.maintain)) throw new Error('このトークンの持ち主には、サイトへの書き込み権限がありません。');
  }

  // plan.image は data URL（JPEG）。戻り値は公開ページの URL
  async function publish({ token, plan, title, summary, onStep = () => {} }) {
    onStep('権限を確認しています…');
    await checkToken(token);
    const id = plan.id || ('p' + Date.now().toString(36));
    onStep('ファイルを送っています…');
    const catalog = await readJson(token, 'catalog.json', []);
    const access = await readJson(token, 'access.json', {});
    const now = new Date().toISOString();
    const entry = { id, title, summary, mode: plan.mode || 'editor', rooms: (plan.rooms || []).filter(r => r.name).slice(0, 10).map(r => r.name + (r.jo ? ` ${r.jo}帖` : '')), updatedAt: now };
    const idx = catalog.findIndex(c => c.id === id);
    if (idx >= 0) catalog[idx] = entry; else catalog.push(entry);
    if (!(id in access)) access[id] = true;
    const pub = { ...plan, id, title, summary, image: `plans/${id}.jpg`, draftId: undefined, updatedAt: now };
    const files = [
      { path: `plans/${id}.json`, content: b64utf8(JSON.stringify(pub)) },
      { path: `plans/${id}.jpg`, content: plan.image.split(',')[1] },
      { path: 'catalog.json', content: b64utf8(JSON.stringify(catalog, null, 2) + '\n') },
      { path: 'access.json', content: b64utf8(JSON.stringify(access, null, 2) + '\n') },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const ref = await gh(token, `/git/ref/heads/${BRANCH}`); if (!ref.ok) throw new Error('公開できませんでした（ref ' + ref.status + '）');
      const base = ref.body.object.sha;
      const cm = await gh(token, `/git/commits/${base}`); if (!cm.ok) throw new Error('公開できませんでした（commit ' + cm.status + '）');
      const tree = [];
      for (const f of files) {
        const b = await gh(token, '/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.content, encoding: 'base64' }) });
        if (!b.ok) throw new Error(b.status === 403 || b.status === 404 ? '書き込みが許可されませんでした。トークンの Contents 権限が「Read and write」か確認してください。' : '公開できませんでした（blob ' + b.status + '）');
        tree.push({ path: f.path, mode: '100644', type: 'blob', sha: b.body.sha });
      }
      const t = await gh(token, '/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: cm.body.tree.sha, tree }) });
      if (!t.ok) throw new Error('公開できませんでした（tree ' + t.status + '）');
      const c = await gh(token, '/git/commits', { method: 'POST', body: JSON.stringify({ message: `間取りを公開: ${title}`, tree: t.body.sha, parents: [base] }) });
      if (!c.ok) throw new Error('公開できませんでした（commit ' + c.status + '）');
      const u = await gh(token, `/git/refs/heads/${BRANCH}`, { method: 'PATCH', body: JSON.stringify({ sha: c.body.sha }) });
      if (u.ok) break;
      if (attempt === 1) throw new Error('ほかの変更と重なったため保存できませんでした。もう一度お試しください。');
    }
    return { id, url: new URL(`view.html?id=${id}`, location.href).href };
  }

  window.FloorPublish = { publish, tokenStore };
})();
