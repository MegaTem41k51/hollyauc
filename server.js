/* HollyAuc — сервер без внешних зависимостей (нужен только Node 18+) */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

/* ============ хранилище (data.json) ============ */
const DB_FILE = path.join(__dirname, 'data.json');
let db = { users: {}, auctions: {}, sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (_) {}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; fs.writeFile(DB_FILE, JSON.stringify(db), () => {}); }, 500);
}

/* ============ утилиты ============ */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const code6 = () => crypto.randomBytes(3).toString('hex'); // 6 символов
const json = (res, code, obj) => { res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(obj)); };
function readBody(req) { return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch(_){r({})} }); }); }
function cookie(req, name) {
  const m = (req.headers.cookie||'').match(new RegExp('(?:^|; )'+name+'=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function postForm(url, params) {
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams(params) });
  return res.json();
}
async function getJSON(url, headers) { const r = await fetch(url, {headers}); if (!r.ok) throw new Error(await r.text()); return r.json(); }

/* ============ Twitch OAuth ============ */
function twitchLoginURL(state) {
  return 'https://id.twitch.tv/oauth2/authorize?' + new URLSearchParams({
    client_id: cfg.twitch.id, redirect_uri: cfg.twitch.redirect,
    response_type: 'code', scope: 'user:read:email', state });
}
async function twitchUser(code) {
  const tok = await postForm('https://id.twitch.tv/oauth2/token', {
    client_id: cfg.twitch.id, client_secret: cfg.twitch.secret,
    code, grant_type: 'authorization_code', redirect_uri: cfg.twitch.redirect });
  if (!tok.access_token) throw new Error('Twitch token: ' + JSON.stringify(tok));
  const u = (await getJSON('https://api.twitch.tv/helix/users', {
    Authorization: 'Bearer ' + tok.access_token, 'Client-Id': cfg.twitch.id })).data[0];
  return { twitchId: u.id, login: u.login, name: u.display_name, avatar: u.profile_image_url };
}

/* ============ DonationAlerts OAuth ============ */
function daLoginURL(state) {
  return 'https://www.donationalerts.com/oauth/authorize?' + new URLSearchParams({
    client_id: cfg.da.id, redirect_uri: cfg.da.redirect,
    response_type: 'code', scope: 'oauth-user-show oauth-donation-index', state });
}
async function daToken(code) {
  const tok = await postForm('https://www.donationalerts.com/oauth/token', {
    client_id: cfg.da.id, client_secret: cfg.da.secret,
    code, grant_type: 'authorization_code', redirect_uri: cfg.da.redirect });
  if (!tok.access_token) throw new Error('DA token: ' + JSON.stringify(tok));
  return tok;
}

/* ============ авто-зачёт донатов (поллер, лимит DA: 1 запрос / 5 сек) ============ */
const daSeen = {}; // twitchId -> Set(alerts ids)
async function pollDonations() {
  for (const user of Object.values(db.users)) {
    if (!user.daToken) continue;
    try {
      const data = await getJSON('https://www.donationalerts.com/api/v1/alerts/donations?page=1', {
        Authorization: 'Bearer ' + user.daToken });
      const list = data.data || [];
      if (!daSeen[user.twitchId]) { daSeen[user.twitchId] = new Set(list.map(d => d.id)); continue; }
      const fresh = list.filter(d => !daSeen[user.twitchId].has(d.id)).reverse();
      fresh.forEach(d => daSeen[user.twitchId].add(d.id));
      for (const d of fresh) {
        const a = Object.values(db.auctions).find(x => x.owner === user.twitchId && x.active);
        if (!a) break;
        const amount = parseFloat(d.amount || d.amount_in_user_currency || 0);
        if (amount <= 0) continue;
        const pts = Math.round(amount * cfg.pointsPerRub);
        creditDonation(a, d, pts, amount);
      }
    } catch (e) { console.error('[DA poll]', user.login, e.message); }
  }
}
setInterval(pollDonations, 6000);

/* донат засчитывается: #N в сообщении -> лот N, иначе текущий лидер */
function creditDonation(a, d, pts, amountRub) {
  const name = esc((d.username || 'Аноним').slice(0, 24));
  const m = (d.message || '').match(/#(\d+)/);
  let lot = m ? a.lots.find(l => l.id === +m[1]) : a.lots.filter(l => l.pts > 0).sort((x,y)=>y.pts-x.pts)[0];
  if (!lot) lot = a.lots[0];
  lot.pts += pts; lot.leader = name;
  a.total += pts;
  a.feed.unshift({ name, lot: lot.emoji + ' ' + lot.name, pts, type: 'donate', rub: amountRub, ts: Date.now() });
  a.feed = a.feed.slice(0, 50);
  broadcast(a.code); save();
}

/* ============ SSE (live-обновления) ============ */
const sseClients = {}; // code -> Set(res)
function broadcast(code) {
  const msg = 'data: ' + JSON.stringify(auctionState(db.auctions[code])) + '\n\n';
  (sseClients[code] || []).forEach(r => { try { r.write(msg); } catch (_) {} });
}

/* ============ состояние аукциона для клиента ============ */
function auctionState(a) {
  return { code: a.code, title: a.title, step: a.step, total: a.total, active: a.active,
    winner: a.winner || null, lots: a.lots,
    feed: a.feed.slice(0, 15) };
}

/* ============ HTTP сервер ============ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, cfg.baseUrl);
  const p = u.pathname;

  /* --- статика --- */
  if (req.method === 'GET' && !p.startsWith('/api') && !p.startsWith('/auth')) {
    let file = p === '/' ? '/index.html' : p;
    if (p.startsWith('/a/')) file = '/index.html';
    const full = path.join(__dirname, 'public', path.normalize(file));
    if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      const ext = path.extname(full);
      res.writeHead(200, {'Content-Type': {'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'}[ext] || 'application/octet-stream'});
      res.end(data);
    });
    return;
  }

  const me = () => { const t = cookie(req, 'ha_sess'); return t && db.sessions[t] ? db.users[db.sessions[t]] : null; };

  /* --- auth: Twitch --- */
  if (p === '/auth/twitch') {
    const st = crypto.randomBytes(8).toString('hex');
    db.sessions['st_' + st] = 'oauth-state'; save();
    res.writeHead(302, { Location: twitchLoginURL(st) }); return res.end();
  }
  if (p === '/auth/twitch/callback') {
    try {
      if (u.searchParams.get('state') && !db.sessions['st_' + u.searchParams.get('state')]) throw new Error('bad state');
      const info = await twitchUser(u.searchParams.get('code'));
      if (!db.users[info.twitchId]) db.users[info.twitchId] = { ...info, daToken: null };
      Object.assign(db.users[info.twitchId], info);
      const t = crypto.randomBytes(16).toString('hex');
      db.sessions[t] = info.twitchId; save();
      res.writeHead(302, { Location: '/', 'Set-Cookie': `ha_sess=${t}; Path=/; HttpOnly; SameSite=Lax` });
    } catch (e) { console.error(e); res.writeHead(302, { Location: '/?error=twitch' }); }
    return res.end();
  }

  /* --- auth: DonationAlerts --- */
  if (p === '/auth/da') {
    const user = me();
    if (!user) { res.writeHead(302, { Location: '/auth/twitch' }); return res.end(); }
    const st = crypto.randomBytes(8).toString('hex');
    db.sessions['st_' + st] = user.twitchId; save();
    res.writeHead(302, { Location: daLoginURL(st) }); return res.end();
  }
  if (p === '/auth/da/callback') {
    try {
      const st = u.searchParams.get('state');
      const owner = db.sessions['st_' + st];
      if (!owner || owner === 'oauth-state') throw new Error('bad state');
      const tok = await daToken(u.searchParams.get('code'));
      db.users[owner].daToken = tok.access_token; save();
      res.writeHead(302, { Location: '/?da=ok' });
    } catch (e) { console.error(e); res.writeHead(302, { Location: '/?error=da' }); }
    return res.end();
  }

  if (p === '/auth/logout') {
    const t = cookie(req, 'ha_sess'); if (t) delete db.sessions[t]; save();
    res.writeHead(302, { Location: '/', 'Set-Cookie': 'ha_sess=; Path=/; Max-Age=0' }); return res.end();
  }

  /* --- API --- */
  if (p === '/api/me' && req.method === 'GET') { const user = me(); return json(res, 200, user ? { login: user.login, name: user.name, avatar: user.avatar, da: !!user.daToken } : null); }

  if (p === '/api/auctions' && req.method === 'POST') {
    const user = me(); if (!user) return json(res, 401, { error: 'Нужен вход через Twitch' });
    const b = await readBody(req);
    const lots = (Array.isArray(b.lots) ? b.lots : []).slice(0, 20).map((l, i) => ({
      id: i + 1, name: esc(String(l.name || 'Лот ' + (i + 1)).slice(0, 60)), emoji: esc(String(l.emoji || '🎁').slice(0, 4)), pts: 0, leader: null }));
    if (!lots.length) return json(res, 400, { error: 'Добавь хотя бы один лот' });
    const a = { code: code6(), owner: user.twitchId, title: esc(String(b.title || 'Аукцион').slice(0, 60)),
      step: Math.max(10, parseInt(b.step || 100, 10)), lots, total: 0, feed: [], active: true, winner: null, created: Date.now() };
    db.auctions[a.code] = a; save();
    return json(res, 200, { code: a.code, url: '/a/' + a.code });
  }

  if (p === '/api/my' && req.method === 'GET') {
    const user = me(); if (!user) return json(res, 401, { error: 'auth' });
    return json(res, 200, Object.values(db.auctions).filter(a => a.owner === user.twitchId)
      .sort((x, y) => y.created - x.created).map(a => ({ code: a.code, title: a.title, total: a.total, active: a.active })));
  }

  const mA = p.match(/^\/api\/auction\/([a-z0-9]{6})(\/bid|\/spin)?$/);
  if (mA) {
    const a = db.auctions[mA[1]];
    if (!a) return json(res, 404, { error: 'Аукцион не найден' });
    const sub = mA[2];

    if (!sub && req.method === 'GET') return json(res, 200, auctionState(a));

    if (sub === '/bid' && req.method === 'POST') {
      if (!a.active) return json(res, 400, { error: 'Аукцион завершён' });
      const b = await readBody(req);
      const lot = a.lots.find(l => l.id === +b.lotId);
      if (!lot) return json(res, 400, { error: 'Лот не найден' });
      const pts = Math.max(a.step, parseInt(b.pts || a.step, 10));
      const name = esc(String(b.name || 'Аноним').slice(0, 24));
      lot.pts += pts; lot.leader = name; a.total += pts;
      a.feed.unshift({ name, lot: lot.emoji + ' ' + lot.name, pts, type: 'bid', ts: Date.now() });
      a.feed = a.feed.slice(0, 50);
      broadcast(a.code); save();
      return json(res, 200, auctionState(a));
    }

    if (sub === '/spin' && req.method === 'POST') {
      const user = me();
      if (!user || user.twitchId !== a.owner) return json(res, 403, { error: 'Только владелец может крутить колесо' });
      const pool = a.lots.filter(l => l.pts > 0);
      if (!pool.length) return json(res, 400, { error: 'Ставок пока нет' });
      const totalW = pool.reduce((s, l) => s + l.pts, 0);
      let r = Math.random() * totalW, win = pool[0];
      for (const l of pool) { r -= l.pts; if (r <= 0) { win = l; break; } }
      a.winner = { lot: win.name, leader: win.leader, pts: win.pts }; a.active = false;
      a.feed.unshift({ name: '🏆 Колесо', lot: win.emoji + ' ' + win.name, pts: 0, type: 'win', ts: Date.now() });
      broadcast(a.code); save();
      return json(res, 200, auctionState(a));
    }
  }

  /* --- SSE --- */
  const mE = p.match(/^\/api\/events\/([a-z0-9]{6})$/);
  if (mE && req.method === 'GET') {
    const a = db.auctions[mE[1]]; if (!a) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(auctionState(a)) + '\n\n');
    (sseClients[a.code] = sseClients[a.code] || new Set()).add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ping); sseClients[a.code].delete(res); });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(cfg.port, () => {
  console.log(`🎄 HollyAuc запущен: ${cfg.baseUrl}`);
  if (!cfg.twitch.id) console.warn('⚠️  Не задан TWITCH_CLIENT_ID — сначала заполни .env (см. README.md)');
});