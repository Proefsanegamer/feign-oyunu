// Feign — çok oyunculu sunucu (Node.js + Express + Socket.io)
const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
app.use(express.static(__dirname + '/public'));

const ROLES = {
  doktor: { n: 'Doktor', t: 'good', act: 1 }, polis: { n: 'Polis', t: 'good', act: 1 },
  gozlemci: { n: 'Gözlemci', t: 'good', act: 1 }, dedektif: { n: 'Dedektif', t: 'good', act: 1 },
  vatandas: { n: 'Kasabalı', t: 'good', act: 0 }, hain: { n: 'Hain', t: 'evil', act: 1 },
  manip: { n: 'Manipülatör', t: 'evil', act: 1 }, seri: { n: 'Seri Katil', t: 'neutral', act: 1 },
  deli: { n: 'Deli', t: 'neutral', act: 1 }
};
const POOL = ['hain', 'doktor', 'dedektif', 'polis', 'vatandas', 'manip', 'gozlemci', 'seri', 'deli', 'vatandas', 'hain', 'vatandas'];
const TYPE_TR = { good: 'İyi', evil: 'Kötü', neutral: 'Tarafsız' };
const MIN = 4, MAX = 12, T_TALK = 60, T_VOTE = 30, T_NIGHT = 35;
const rnd = a => a[Math.random() * a.length | 0];
const shuf = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rooms = new Map();
const isEv = p => ROLES[p.role].t === 'evil';

/* ---------- Oda yardımcıları ---------- */
function newCode() {
  const L = 'ABCDEFGHJKLMNPRSTUVYZ'; let c;
  do { c = Array.from({ length: 4 }, () => L[Math.random() * L.length | 0]).join(''); } while (rooms.has(c));
  return c;
}
function mkPlayer(room, sock, name) {
  let n = name || 'Oyuncu', k = 2; const base = n;
  while (room.players.some(p => p.name === n)) n = base + k++;
  const p = { id: room.players.length, sid: sock.id, name: n, token: crypto.randomBytes(8).toString('hex'), role: null, shown: null, alive: true, connected: true, log: [], last: 0 };
  room.players.push(p); sock.data = { code: room.code, seat: p.id };
  sock.emit('joined', { code: room.code, token: p.token });
  return p;
}
function view(room, p) {
  const over = !!room.over;
  return {
    code: room.code, phase: room.phase, day: room.day, timer: room.timer, me: p.id, over: room.over,
    host: room.players.findIndex(q => q.sid === room.host),
    players: room.players.map(q => ({
      id: q.id, name: q.name, alive: q.alive, connected: q.connected,
      role: q.id === p.id ? ((q.alive && !over) ? q.shown : q.role)
        : (!q.alive || over) ? q.role
        : (q.role && p.role && isEv(q) && isEv(p) ? q.role : null)
    })),
    myVote: room.votes[p.id], myAct: room.actions[p.id],
    docSelf: p.role === 'doktor' ? room.docSelf : false,
    counts: room.phase === 'trans' ? room.counts : null,
    ready: room.ready.has(p.id), readyN: room.ready.size, needN: alive(room).length
  };
}
const alive = room => room.players.filter(p => p.alive && p.connected);
function emit(room) { room.players.forEach(p => p.connected && io.to(p.sid).emit('state', view(room, p))); }
function msg(room, type, text, who, filter) {
  room.players.forEach(p => {
    if (filter && !filter(p)) return;
    const m = { type, who: who || '', text }; p.log.push(m); if (p.log.length > 100) p.log.shift();
    if (p.connected) io.to(p.sid).emit('msg', m);
  });
}

/* ---------- GameState yardımcıları ---------- */
function checkWin(room) {
  const al = room.players.filter(p => p.alive);
  const ev = al.filter(isEv).length, sk = al.filter(p => p.role === 'seri').length;
  if (!ev && !sk) return { w: 'good', t: 'Kasaba Kazandı!', d: 'Tüm hainler ve katiller etkisiz hale getirildi.' };
  if (ev && !sk && ev >= al.length - ev) return { w: 'evil', t: 'Hainler Kazandı!', d: 'Hainler kasabalıların sayısına ulaştı; köy artık onların.' };
  if (sk && !ev && al.length <= 2) return { w: 'seri', t: 'Seri Katil Kazandı!', d: 'Meydanda yalnızca katil ve son kurbanı kaldı.' };
  if (ev && sk && al.length <= 2) return { w: 'draw', t: 'Karanlık Kazandı', d: 'Geriye yalnızca bir Hain ve bir Seri Katil kaldı. Kimse kazanamadı.' };
  return null;
}

/* ---------- NightSystem ---------- */
function resolveNight(room) {
  const P = room.players, notes = {}, say = (i, m) => (notes[i] ??= []).push(m);
  const acts = {};
  for (const [a, t] of Object.entries(room.actions)) if (P[a] && P[a].alive && P[t]) acts[+a] = +t;
  const orig = { ...acts };
  for (const a in acts) if (P[a].role === 'deli') delete acts[a];            // Deli etkisiz
  const by = r => Object.keys(acts).map(Number).filter(a => P[a].role === r);
  // 1) Engellemeler
  by('polis').forEach(a => {
    const t = acts[a]; if (t === undefined) return;
    if (acts[t] !== undefined) { delete acts[t]; say(t, 'Bu gece biri seni engelledi; yeteneğin işlemedi.'); }
    say(a, `${P[t].name} engellendi.`);
  });
  // 1.5) Manipülasyon
  by('manip').forEach(m => {
    const v = acts[m]; if (v === undefined) return; say(m, `${P[v].name} yönlendirildi.`);
    if (acts[v] !== undefined) { const o = P.filter(p => p.alive && p.id !== v && p.id !== acts[v]); if (o.length) acts[v] = rnd(o).id; }
  });
  // 2) Korumalar
  const prot = new Set();
  by('doktor').forEach(d => {
    const t = acts[d];
    if (t === d) { if (room.docSelf) { say(d, 'Kendini zaten bir kez korudun; bu gece koruma olmadı.'); return; } room.docSelf = true; }
    prot.add(t);
  });
  // 3) Öldürmeler
  const dead = new Set();
  [...by('hain'), ...by('seri')].forEach(k => {
    const t = acts[k]; if (t === k) return;
    if (prot.has(t)) {
      say(t, 'Bu gece saldırıya uğradın ama Doktor seni kurtardı!');
      by('doktor').filter(d => acts[d] === t).forEach(d => say(d, `${P[t].name} saldırıya uğradı ve sen onu kurtardın!`));
    } else dead.add(t);
  });
  // 4) Bilgi toplama
  by('gozlemci').forEach(g => {
    const t = acts[g], v = Object.keys(acts).map(Number).filter(a => acts[a] === t && a !== g).map(a => P[a].name);
    say(g, v.length ? `${P[t].name} evine şunlar geldi: ${v.join(', ')}.` : `${P[t].name} evine kimse gelmedi.`);
  });
  by('dedektif').forEach(d => { const t = acts[d]; say(d, `${P[t].name}: ${TYPE_TR[ROLES[P[t].role].t]}.`); });
  // 5) Deli kontrolü: sahte geri bildirim
  Object.keys(orig).map(Number).filter(a => P[a].role === 'deli').forEach(a => {
    const t = orig[a], n = P[t].name;
    say(a, ({ doktor: `${n} bu gece korundu.`, polis: `${n} engellendi.`, gozlemci: `${n} evine kimse gelmedi.`, dedektif: `${n}: ${rnd(['İyi', 'Kötü', 'Tarafsız'])}.` })[P[a].shown]);
  });
  dead.forEach(i => P[i].alive = false);
  return { deaths: [...dead], notes };
}

/* ---------- VotingSystem ---------- */
function tally(room) {
  const counts = {}; let skip = 0;
  Object.values(room.votes).forEach(v => { v === -1 ? skip++ : counts[v] = (counts[v] || 0) + 1; });
  let max = skip, top = [-1];
  for (const [id, c] of Object.entries(counts)) { if (c > max) { max = c; top = [+id]; } else if (c === max) top.push(+id); }
  return { counts, skip, hanged: top.length === 1 && top[0] !== -1 ? top[0] : null };
}

/* ---------- Faz akışı ---------- */
function later(room, fn, ms) { room.to.push(setTimeout(fn, ms)); }
function startGame(room) {
  const n = room.players.length, roles = shuf(POOL.slice(0, n));
  Object.assign(room, { day: 0, actions: {}, votes: {}, docSelf: false, over: null, counts: null, ready: new Set() });
  room.players.forEach((p, i) => {
    Object.assign(p, { role: roles[i], shown: roles[i], alive: true });
    if (p.role === 'deli') p.shown = rnd(['doktor', 'polis', 'gozlemci', 'dedektif']);
  });
  msg(room, 'sys', `Oyun başladı! Köyde ${n} kişi var. Aranızda hainler gizleniyor.`);
  room.players.forEach(p => msg(room, 'priv', `Rolün: ${ROLES[p.shown].n}.` + (isEv(p) ? ` Ekibin: ${room.players.filter(q => isEv(q) && q !== p).map(q => q.name).join(', ') || 'yok'}.` : ''), '', q => q === p));
  startDay(room, []);
}
function startDay(room, deaths) {
  room.day++; room.phase = 'talk'; room.timer = T_TALK; room.votes = {}; room.counts = null; room.ready = new Set();
  msg(room, 'sys', `— Gün ${room.day} —`);
  if (room.day > 1) {
    if (deaths.length) deaths.forEach(i => msg(room, 'sys', `Gece raporu: ${room.players[i].name} öldürüldü. Rolü: ${ROLES[room.players[i].role].n}.`));
    else msg(room, 'sys', 'Gece raporu: Kimse ölmedi.');
  }
  const w = checkWin(room); if (w) return finish(room, w);
  emit(room);
}
function startVote(room) {
  room.phase = 'vote'; room.timer = T_VOTE; room.votes = {}; room.ready = new Set();
  msg(room, 'sys', 'Oylama başladı. Bir eve dokun ve oyunu ver ya da pas geç.'); emit(room);
}
function endVote(room) {
  const t = tally(room); room.counts = t.counts; room.phase = 'trans'; room.timer = 0;
  const parts = Object.entries(t.counts).map(([i, c]) => `${room.players[i].name}: ${c}`); if (t.skip) parts.push(`Pas: ${t.skip}`);
  msg(room, 'sys', 'Oylar → ' + (parts.join(', ') || 'kimse oy vermedi'));
  if (t.hanged != null) {
    const p = room.players[t.hanged]; p.alive = false;
    msg(room, 'sys', `${p.name} asıldı! Rolü: ${ROLES[p.role].n}.`);
    if (p.role === 'deli') return finish(room, { w: 'deli', t: 'Deli Kazandı!', d: `${p.name} kasabalıları kandırıp kendini astırdı. Tam da istediği buydu!` });
  } else msg(room, 'sys', 'Eşitlik ya da pas: kimse asılmadı.');
  const w = checkWin(room); if (w) return finish(room, w);
  emit(room); later(room, () => startNight(room), 4000);
}
function startNight(room) {
  room.phase = 'night'; room.timer = T_NIGHT; room.actions = {}; room.counts = null; room.ready = new Set();
  msg(room, 'sys', `— Gece ${room.day} — Herkes evine çekildi.`); emit(room);
}
function endNight(room) {
  const r = resolveNight(room);
  room.players.forEach(p => (r.notes[p.id] || []).forEach(m => msg(room, 'priv', m, '', q => q === p)));
  r.deaths.forEach(i => msg(room, 'priv', 'Öldün. Artık yalnızca ölüler kanalında konuşabilirsin.', '', q => q.id === i));
  startDay(room, r.deaths);
}
function finish(room, w) {
  room.over = w; room.phase = 'over'; room.timer = 0; room.to.forEach(clearTimeout); room.to = [];
  msg(room, 'sys', w.t + ' ' + w.d); emit(room);
}
function next(room) {
  if (room.phase === 'talk') startVote(room); else if (room.phase === 'vote') endVote(room); else if (room.phase === 'night') endNight(room);
}
function maybeAdvance(room) {
  const al = alive(room); if (!al.length) return;
  if ((room.phase === 'talk' || room.phase === 'night') && al.every(p => room.ready.has(p.id))) next(room);
  else if (room.phase === 'vote' && al.every(p => room.votes[p.id] !== undefined)) next(room);
}
function destroy(room) { clearInterval(room.iv); room.to.forEach(clearTimeout); rooms.delete(room.code); }

/* ---------- Socket olayları ---------- */
io.on('connection', sock => {
  const ctx = () => { const r = rooms.get(sock.data?.code); const p = r && r.players[sock.data.seat]; return p && p.sid === sock.id ? { r, p } : null; };
  const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 12);
  const err = m => sock.emit('err', m);

  sock.on('create', ({ name } = {}) => {
    name = clean(name); if (!name) return err('Takma ad gerekli.');
    const room = { code: newCode(), players: [], host: sock.id, phase: 'lobby', day: 0, timer: 0, actions: {}, votes: {}, ready: new Set(), docSelf: false, over: null, counts: null, to: [] };
    room.iv = setInterval(() => { if (room.timer > 0 && --room.timer === 0) next(room); if (room.timer > 0 || room.phase === 'trans') emit(room); }, 1000);
    rooms.set(room.code, room); mkPlayer(room, sock, name); emit(room);
  });

  sock.on('join', ({ name, code } = {}) => {
    name = clean(name); code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!name) return err('Takma ad gerekli.');
    if (!room) return err('Bu kodla bir oda bulunamadı.');
    if (room.phase !== 'lobby') return err('Oyun çoktan başlamış.');
    if (room.players.length >= MAX) return err('Oda dolu (en fazla 12 kişi).');
    mkPlayer(room, sock, name); emit(room);
  });

  sock.on('rejoin', ({ code, token } = {}) => {
    const room = rooms.get(String(code || '')); const p = room && room.players.find(q => q.token === token);
    if (!p) return sock.emit('rejoinFail');
    if (room.host === p.sid) room.host = sock.id;
    p.sid = sock.id; p.connected = true; sock.data = { code: room.code, seat: p.id };
    sock.emit('joined', { code: room.code, token: p.token });
    sock.emit('history', p.log); emit(room);
  });

  sock.on('start', () => {
    const c = ctx(); if (!c || c.r.host !== sock.id || c.r.phase !== 'lobby') return;
    if (c.r.players.length < MIN) return err(`En az ${MIN} oyuncu gerekli.`);
    startGame(c.r);
  });

  sock.on('again', () => {
    const c = ctx(); if (!c || c.r.host !== sock.id || c.r.phase !== 'over') return;
    const r = c.r; r.players = r.players.filter(p => p.connected); r.players.forEach((p, i) => { p.id = i; p.alive = true; p.role = p.shown = null; p.log = []; p.sid && (io.sockets.sockets.get(p.sid).data.seat = i); });
    Object.assign(r, { phase: 'lobby', over: null, day: 0, timer: 0, actions: {}, votes: {}, ready: new Set(), counts: null });
    r.players.forEach(p => io.to(p.sid).emit('history', [])); emit(r);
  });

  sock.on('chat', text => {
    const c = ctx(); if (!c) return; const { r, p } = c, now = Date.now();
    text = String(text || '').replace(/[<>]/g, '').trim().slice(0, 140);
    if (!text || now - p.last < 400 || r.phase === 'lobby' || r.phase === 'trans') return; p.last = now;
    if (!p.alive) return msg(r, 'dead', text, p.name, q => !q.alive);
    if (r.phase === 'talk' || r.phase === 'vote') msg(r, 'say', text, p.name);
    else if (r.phase === 'night' && isEv(p)) msg(r, 'evil', text, p.name, q => q.alive && isEv(q));
  });

  sock.on('vote', t => {
    const c = ctx(); if (!c) return; const { r, p } = c; t = Number(t);
    if (r.phase !== 'vote' || !p.alive) return;
    if (t !== -1 && (!r.players[t] || !r.players[t].alive || t === p.id)) return err('Geçersiz oy.');
    r.votes[p.id] = t; emit(r); maybeAdvance(r);
  });

  sock.on('act', t => {
    const c = ctx(); if (!c) return; const { r, p } = c;
    if (r.phase !== 'night' || !p.alive || !ROLES[p.role].act) return;
    if (t === null) { delete r.actions[p.id]; return emit(r); }
    t = Number(t); const q = r.players[t];
    if (!q || !q.alive) return err('Geçersiz hedef.');
    if (t === p.id && (p.shown !== 'doktor' || (p.role === 'doktor' && r.docSelf))) return err('Kendini seçemezsin.');
    r.actions[p.id] = t; emit(r);
  });

  sock.on('ready', () => {
    const c = ctx(); if (!c) return; const { r, p } = c;
    if (!p.alive || (r.phase !== 'talk' && r.phase !== 'night')) return;
    r.ready.has(p.id) ? r.ready.delete(p.id) : r.ready.add(p.id); emit(r); maybeAdvance(r);
  });

  sock.on('disconnect', () => {
    const c = ctx(); if (!c) return; const { r, p } = c;
    if (r.phase === 'lobby') {
      r.players.splice(p.id, 1); r.players.forEach((q, i) => { q.id = i; if (q.sid && q.sid !== sock.id) io.sockets.sockets.get(q.sid).data.seat = i; });
      if (!r.players.length) return destroy(r);
      if (r.host === sock.id) r.host = r.players[0].sid;
      emit(r);
    } else {
      p.connected = false;
      if (!r.players.some(q => q.connected)) return destroy(r);
      if (r.host === sock.id) r.host = r.players.find(q => q.connected).sid;
      emit(r); maybeAdvance(r);
    }
  });
});

srv.listen(process.env.PORT || 3000, () => console.log('Feign sunucusu hazır: http://localhost:' + (process.env.PORT || 3000)));
