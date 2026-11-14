// 止まれない機関車（仮） 小人版 試作サーバー
// 小人たちが巨大な蒸気機関車を動かす。サーバーが全部計算して20回/秒で送る。
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ===== 線路（index.html と同じ計算） =====
const L = 16000, STEP = 10;
const FLATS = [[0, 900], [7500, 8500], [14800, 16000]];
const TOWER_X = 8000;       // 給水塔（列車の中心をここに止める）
const STOP_FRONT = 15500;   // 停止線（機関車の先頭をここに合わせる）
const BUFFER_FRONT = 15700; // 車止め
const FRONT = 560, REAR = -560; // 列車の先頭・最後尾（列車の中での位置）
function rawSlope(x) {
  for (const f of FLATS) if (x >= f[0] && x <= f[1]) return 0;
  return 0.07 + 0.09 * Math.cos(x / 700) + 0.07 * Math.cos(x / 300 + 1);
}
const H = [0];
for (let i = 1; i <= L / STEP + 2; i++) H[i] = H[i - 1] + rawSlope((i - 0.5) * STEP) * STEP;
function ground(x) {
  x = Math.max(0, Math.min(L, x));
  const i = Math.floor(x / STEP), t = x / STEP - i;
  return H[i] * (1 - t) + H[i + 1] * t;
}
function slopeAt(x) { return (ground(x + 5) - ground(x - 5)) / 10; }
function trainAngle(x) { return Math.atan((ground(x + 400) - ground(x - 400)) / 800); }

// ===== 列車の中の足場・はしご（列車の中での座標。yは上がマイナス） =====
const PLATS = [
  { x1: -560, x2: -240, y: -260 }, // 炭水車の上（石炭の山）
  { x1: -262, x2: 545, y: -150 },  // 運転台の床〜ランボード（ボイラー横の通路）
  { x1: -240, x2: -90, y: -300 },  // 運転台の棚（加減弁・圧力計）
  { x1: -285, x2: -40, y: -470 },  // 運転台の屋根
  { x1: -45, x2: 430, y: -400 },   // ボイラーの上
  { x1: -560, x2: -515, y: -60 },  // 炭水車の後ろのステップ
  { x1: -170, x2: -130, y: -60 },  // 運転台横のステップ
];
const LADDERS = [
  { x: -545, top: -260, bottom: -20, ground: true }, // 地面→炭水車の上
  { x: -150, top: -150, bottom: -20, ground: true }, // 地面→運転台
  { x: -250, top: -260, bottom: -150 },              // 運転台→炭水車の上
  { x: -215, top: -300, bottom: -150 },              // 運転台→棚
  { x: -100, top: -470, bottom: -300 },              // 棚→屋根
  { x: -32, top: -400, bottom: -150 },               // 通路→ボイラーの上
  { x: 422, top: -400, bottom: -150 },               // 前のはしご
];
const SPOTS = [
  { id: 'coalpile', x: -420, y: -260, r: 60 },
  { id: 'waterin', x: -300, y: -260, r: 26 },
  { id: 'fire', x: -75, y: -150, r: 24 },
  { id: 'brake', x: -230, y: -150, r: 22 },
  { id: 'reg', x: -125, y: -300, r: 24 },
  { id: 'gauge', x: -185, y: -300, r: 22 },
  { id: 'whistle', x: -10, y: -400, r: 22 },
  { id: 'valve', x: 120, y: -400, r: 26 },
];
const COLORS = ['#D94F3D', '#3D7DD9', '#E8B93A', '#4FA36B', '#B266D9', '#E8913A'];

let g;
const players = {};
let itemSeq = 1;

function newGame() {
  return {
    x: 600, v: 0, reg: 0, pressure: 40, fire: 30, water: 100, coalStock: 30,
    brakeHeat: 0, brakeForce: 0, venting: false, whistling: false, gaugeSeen: false,
    hp: 100, phase: 'play', result: null, stopTimer: 0, resultTimer: 0, crashed: false,
    msgs: [], t: 0, items: [],
  };
}
g = newGame();
function msg(text) {
  const same = g.msgs.find(m => m.text === text);
  if (same) { same.t = g.t; return; }
  g.msgs.push({ text, t: g.t }); if (g.msgs.length > 5) g.msgs.shift();
}

// 列車の中の座標 → 世界の座標
function toWorldPos(lx, ly) {
  const a = trainAngle(g.x), gy = ground(g.x);
  return { x: g.x + lx * Math.cos(a) - ly * Math.sin(a), y: gy + lx * Math.sin(a) + ly * Math.cos(a) };
}

function placeOnTender(p) {
  p.on = true; p.lx = -480 + Math.random() * 120; p.ly = -260; p.lvx = 0; p.lvy = 0;
  p.grounded = true; p.climb = null; p.offTime = 0;
}

function dropCarried(p, lost) {
  if (!p.carry) return;
  const it = g.items.find(i => i.id === p.carry);
  if (it) {
    if (lost) g.items = g.items.filter(i => i !== it);
    else { it.holder = null; it.lx = p.lx; it.ly = p.ly - 30; it.lvx = 0; it.lvy = 0; it.rest = 0; }
  }
  p.carry = null;
}

function leaveTrain(p, reason, kick) {
  if (!p.on) return;
  const w = toWorldPos(p.lx, p.ly);
  dropCarried(p, true);
  p.on = false; p.wx = w.x; p.wy = w.y;
  p.wvx = g.v + p.lvx + (kick ? (Math.random() - 0.3) * 160 : 0);
  p.wvy = kick ? -220 : p.lvy;
  p.climb = null; p.grounded = false; p.offTime = 0;
  if (reason) msg(`${p.name} が${reason}`);
}

function spotOf(p) {
  if (!p.on || p.climb || !p.grounded) return null;
  for (const s of SPOTS) if (Math.abs(p.lx - s.x) < s.r && Math.abs(p.ly - s.y) < 2) return s.id;
  return null;
}
// 給水口（列車の中で x=-300）が給水塔の下を通っている間ならOK。止まる必要なし
function nearTower() { return Math.abs(g.x - 300 - TOWER_X) < 260; }

// 足場への着地（上から落ちてきたときだけ乗れる）
function landY(x, y0, y1) {
  let best = null;
  for (const pl of PLATS) {
    if (x < pl.x1 || x > pl.x2) continue;
    if (y0 <= pl.y + 0.5 && y1 >= pl.y && (best === null || pl.y < best)) best = pl.y;
  }
  return best;
}
function onPlat(x, y) { return PLATS.some(pl => x >= pl.x1 && x <= pl.x2 && Math.abs(y - pl.y) < 0.6); }

function tick(dt) {
  g.t += dt;
  const playing = g.phase === 'play';
  const list = Object.values(players);

  // ---- 1. 場所ごとの操作 ----
  let regOpen = 0, regClose = 0, brakeN = 0;
  g.venting = false; g.whistling = false; g.gaugeSeen = false;
  for (const p of list) {
    const inp = p.input, prev = p.prev;
    const pressE = inp.e && !prev.e, pressQ = inp.q && !prev.q;
    p.spot = spotOf(p);
    if (!playing || !p.on) continue;

    // 石炭を持っているとき：Qで投げる、焚き口でEで入れる
    if (p.carry) {
      if (pressQ) {
        const it = g.items.find(i => i.id === p.carry);
        if (it) { it.holder = null; it.lx = p.lx + p.face * 10; it.ly = p.ly - 30; it.lvx = p.face * 230 + p.lvx; it.lvy = -170; it.rest = 0; }
        p.carry = null;
        continue;
      }
      if (p.spot === 'fire' && pressE) {
        g.items = g.items.filter(i => i.id !== p.carry); p.carry = null;
        g.fire = Math.min(100, g.fire + 20);
        continue;
      }
    } else if (pressE) {
      // 落ちている石炭を拾う
      const it = g.items.find(i => !i.holder && Math.abs(i.lx - p.lx) < 22 && Math.abs(i.ly - p.ly) < 26);
      if (it) { it.holder = p.id; p.carry = it.id; continue; }
      if (p.spot === 'coalpile') {
        if (g.coalStock >= 1) {
          g.coalStock -= 1;
          const nit = { id: itemSeq++, holder: p.id, lx: p.lx, ly: p.ly - 30, lvx: 0, lvy: 0 };
          g.items.push(nit); p.carry = nit.id;
        } else msg('石炭の山が空っぽ！');
        continue;
      }
    }
    if (p.carry) continue;
    if (p.spot === 'reg') { if (inp.e) regOpen++; if (inp.q) regClose++; }
    if (p.spot === 'brake' && inp.e) brakeN++;
    if (p.spot === 'valve' && inp.e) g.venting = true;
    if (p.spot === 'whistle' && inp.e) g.whistling = true;
    if (p.spot === 'gauge') g.gaugeSeen = true;
    if (p.spot === 'waterin' && inp.e) {
      if (nearTower()) { g.water = Math.min(100, g.water + 60 * dt); g.coalStock = Math.min(30, g.coalStock + 12 * dt); }
      else if (pressE) msg('給水塔の下でないと水が入らない');
    }
  }
  // 重いレバー：1人だとゆっくり、2人だと4倍速い
  g.reg += (0.1 * regOpen * regOpen - 0.1 * regClose * regClose) * dt;
  g.reg = Math.max(-0.5, Math.min(1, g.reg));
  g.brakeForce = Math.min(1, brakeN * 0.5);

  // ---- 2. 機関車 ----
  const vPrev = g.v;
  const aEngine = playing ? g.reg * (g.pressure / 100) * 60 : 0;
  const aGrav = 120 * slopeAt(g.x);
  const eff = Math.max(0.25, 1 - g.brakeHeat / 120);
  const aBrake = 200 * g.brakeForce * eff;
  g.v += (aEngine + aGrav) * dt;
  const dec = (aBrake + 6 + 0.12 * Math.abs(g.v)) * dt;
  if (Math.abs(g.v) <= dec) g.v = 0; else g.v -= Math.sign(g.v) * dec;
  g.v = Math.max(-300, Math.min(500, g.v));
  g.x += g.v * dt;
  if (g.x < 700) { g.x = 700; g.v = Math.max(0, g.v); }
  if (g.x + FRONT >= BUFFER_FRONT) {
    if (g.v > 60) {
      g.hp -= 40; g.crashed = true; msg('車止めに激突！！');
      for (const p of list) if (p.on && !p.input.e) leaveTrain(p, null, true);
    }
    g.x = BUFFER_FRONT - FRONT; g.v = -Math.abs(g.v) * 0.2;
  }
  const acc = (g.v - vPrev) / dt;
  g.brakeHeat = Math.max(0, Math.min(150, g.brakeHeat + (g.brakeForce > 0 && Math.abs(g.v) > 5 ? 30 * g.brakeForce : -12) * dt));

  // ---- 3. ボイラー ----
  if (g.water > 0) { g.pressure += g.fire * 0.15 * dt; g.water = Math.max(0, g.water - g.fire * 0.012 * dt); }
  else g.pressure -= 5 * dt;
  g.pressure -= (Math.abs(g.reg) * Math.abs(g.v) * 0.03 + 0.8) * dt;
  if (g.venting) g.pressure -= 35 * dt;
  g.fire = Math.max(0, g.fire - 2 * dt);
  g.pressure = Math.max(0, g.pressure);
  if (g.pressure > 125 && playing) {
    g.pressure = 10; g.fire = 0; g.hp -= 25;
    msg('ボイラーが破裂した！！');
    for (const p of list) if (p.on && p.ly <= -300) leaveTrain(p, null, true);
  }

  // ---- 4. 揺れで落ちる ----
  if (playing) for (const p of list) {
    if (!p.on || p.climb || p.input.e) continue;
    if (Math.abs(acc) > 300) leaveTrain(p, '投げ出された！', true);
    else if (Math.abs(g.v) > 280 && p.ly <= -400 && Math.random() < 0.25 * dt) leaveTrain(p, '振り落とされた！', true);
  }

  // ---- 5. 小人の移動 ----
  for (const p of list) {
    const inp = p.input, prev = p.prev;
    const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    if (dir) p.face = dir;
    const pressJ = inp.j && !prev.j, pressD = inp.d && !prev.d;
    if (p.on) moveOnTrain(p, dir, inp, pressJ, pressD, dt);
    else moveOnGround(p, dir, inp, pressJ, dt);
    p.prev = { ...inp };
  }

  // ---- 6. 石炭のかたまり ----
  for (const it of g.items) {
    if (it.holder) {
      const h = players[it.holder];
      if (!h || !h.on) { it.holder = null; continue; }
      it.lx = h.lx; it.ly = h.ly - 30; continue;
    }
    it.lvy += 900 * dt;
    const nx = it.lx + it.lvx * dt, ny = it.ly + it.lvy * dt;
    const ly = it.lvy >= 0 ? landY(nx, it.ly, ny) : null;
    if (ly !== null) { it.ly = ly; it.lvy = 0; it.lvx *= 0.5; if (Math.abs(it.lvx) < 5) it.lvx = 0; }
    // 床に落ちている時間を数えて、5秒で消す
    if (it.lvy === 0) { it.rest = (it.rest || 0) + dt; if (it.rest > 5) it.gone = true; }
    else it.ly = ny;
    it.lx = nx;
    if (!it.gone && (it.ly > -15 || it.lx < REAR - 10 || it.lx > FRONT + 10)) { it.gone = true; msg('石炭が線路に落ちた'); }
  }
  g.items = g.items.filter(i => !i.gone);

  // ---- 7. ゴール ----
  if (playing) {
    if (g.x + FRONT > 15000 && Math.abs(g.v) < 4) {
      g.stopTimer += dt;
      if (g.stopTimer > 1.5) {
        const err = Math.abs(g.x + FRONT - STOP_FRONT);
        const stars = g.crashed ? 0 : err < 30 ? 3 : err < 100 ? 2 : 1;
        g.phase = 'result'; g.result = { ok: true, err: Math.round(err), stars, crashed: g.crashed };
      }
    } else g.stopTimer = 0;
    if (g.hp <= 0) { g.phase = 'result'; g.result = { ok: false }; }
  }
  g.msgs = g.msgs.filter(m => g.t - m.t < 4);
}

function moveOnTrain(p, dir, inp, pressJ, pressD, dt) {
  const speed = (p.carry ? 60 : 110) * (inp.sh ? 1.7 : 1);
  // はしごの上
  if (p.climb) {
    const ld = p.climb;
    p.lx = ld.x; p.lvx = 0; p.lvy = 0;
    p.ly += ((inp.d ? 1 : 0) - (inp.u ? 1 : 0)) * 90 * dt;
    if (pressJ) { p.climb = null; p.lvy = -150; p.lvx = (dir || p.face) * 90; p.grounded = false; return; }
    if (p.ly <= ld.top) { p.ly = ld.top; p.climb = null; p.grounded = true; return; }
    if (p.ly >= ld.bottom) {
      if (ld.ground) { p.ly = ld.bottom; leaveTrain(p); p.wvx = g.v; p.wvy = 0; return; }
      p.ly = ld.bottom; p.climb = null; p.grounded = true; return;
    }
    return;
  }
  // はしごにつかまる
  if ((inp.u || inp.d) && p.grounded) {
    const ld = LADDERS.find(l => Math.abs(p.lx - l.x) < 14 && ((inp.u && Math.abs(p.ly - l.bottom) < 3) || (inp.d && Math.abs(p.ly - l.top) < 3)));
    if (ld) {
      if (p.carry) { if (!p.warned) { msg('石炭を持ったままはしごは登れない（Qで投げる）'); p.warned = true; } }
      else { p.climb = ld; p.lx = ld.x; p.ly += inp.u ? -2 : 2; p.grounded = false; return; }
    }
  }
  if (!(inp.u || inp.d)) p.warned = false;
  // 下に飛び降りる（↓）
  if (pressD && p.grounded && !LADDERS.some(l => Math.abs(p.lx - l.x) < 14)) { p.ly += 3; p.grounded = false; }
  p.lvx = dir * speed;
  if (pressJ && p.grounded) { p.lvy = p.carry ? -200 : -300; p.grounded = false; }
  if (p.grounded && !onPlat(p.lx + p.lvx * dt, p.ly)) p.grounded = false;
  if (!p.grounded) {
    p.lvy += 900 * dt;
    const nx = p.lx + p.lvx * dt, ny = p.ly + p.lvy * dt;
    const ly = p.lvy >= 0 ? landY(nx, p.ly, ny) : null;
    p.lx = nx;
    if (ly !== null) { p.ly = ly; p.lvy = 0; p.grounded = true; } else p.ly = ny;
  } else p.lx += p.lvx * dt;
  if (p.ly > -15 || p.lx < REAR - 10 || p.lx > FRONT + 10) leaveTrain(p, '列車から落ちた！');
}

function moveOnGround(p, dir, inp, pressJ, dt) {
  // 小人の足は遅い
  const target = dir * 90 * (inp.sh ? 1.8 : 1);
  p.wvx += (target - p.wvx) * Math.min(1, (p.grounded ? 5 : 1) * dt);
  if (pressJ && p.grounded) { p.wvy = -300; p.grounded = false; }
  p.wvy += 900 * dt;
  p.wx = Math.max(0, Math.min(L, p.wx + p.wvx * dt));
  p.wy += p.wvy * dt;
  const gy = ground(p.wx);
  if (p.wy >= gy) { p.wy = gy; p.wvy = 0; p.grounded = true; }
  // 地面からのはしごにつかまって乗る
  if (inp.u) {
    for (const ld of LADDERS) {
      if (!ld.ground) continue;
      const w = toWorldPos(ld.x, ld.bottom);
      if (Math.abs(p.wx - w.x) < 18 && Math.abs(p.wy - w.y) < 30) {
        p.on = true; p.lx = ld.x; p.ly = ld.bottom - 2; p.climb = ld; p.grounded = false; p.lvx = 0; p.lvy = 0;
        msg(`${p.name} がはしごに飛びついた！`); return;
      }
    }
  }
  // 遠く置いていかれたら、しばらくして炭水車に戻る
  p.offTime += dt;
  if (p.offTime > 7 && Math.abs(p.wx - g.x) > 500) { placeOnTender(p); msg(`${p.name} が必死に走って追いついた`); }
}

function restart() {
  g = newGame();
  for (const p of Object.values(players)) { placeOnTender(p); p.carry = null; p.rHold = 0; }
  msg('出発進行！');
}

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    if (players[socket.id]) return;
    const used = Object.values(players).map(p => p.color);
    const p = {
      id: socket.id, name: String(name || 'ななし').slice(0, 10),
      color: COLORS.find(c => !used.includes(c)) || COLORS[0],
      input: {}, prev: {}, face: 1, carry: null, spot: null, rHold: 0,
    };
    placeOnTender(p);
    players[socket.id] = p;
    msg(`${p.name} が乗車した`);
    socket.emit('joined', { id: socket.id });
  });
  socket.on('input', (inp) => {
    const p = players[socket.id];
    if (!p || typeof inp !== 'object') return;
    p.input = { l: !!inp.l, r: !!inp.r, u: !!inp.u, d: !!inp.d, j: !!inp.j, e: !!inp.e, q: !!inp.q, restart: !!inp.rst, sh: !!inp.sh };
  });
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) dropCarried(p, false);
    delete players[socket.id];
    if (Object.keys(players).length === 0) g = newGame();
  });
});

const DT = 1 / 30;
let frame = 0;
setInterval(() => {
  // リセット：結果画面ではR、プレイ中はRを2秒長押し、結果は20秒で自動
  for (const p of Object.values(players)) {
    p.rHold = p.input.restart ? (p.rHold || 0) + DT : 0;
    const pressR = p.input.restart && !p.prevRestart;
    p.prevRestart = p.input.restart;
    if (g.phase === 'result' && pressR) { restart(); break; }
    if (g.phase === 'play' && p.rHold > 2) { const who = p.name; restart(); msg(`${who} がリセットした`); break; }
  }
  if (g.phase === 'result') { g.resultTimer += DT; if (g.resultTimer > 20) restart(); }
  tick(DT);
  frame++;
  {
    io.emit('state', {
      g: {
        x: g.x, v: g.v, reg: g.reg, pressure: g.gaugeSeen ? g.pressure : null, danger: g.pressure > 100,
        fire: g.fire, water: g.water, coalStock: g.coalStock, brakeHeat: g.brakeHeat, brakeForce: g.brakeForce,
        venting: g.venting, whistling: g.whistling, hp: g.hp, phase: g.phase, result: g.result,
        msgs: g.msgs.map(m => m.text), items: g.items.map(i => ({ id: i.id, lx: i.lx, ly: i.ly, fade: i.holder ? 0 : (i.rest || 0) })),
      },
      players: Object.values(players).map(p => ({
        id: p.id, name: p.name, color: p.color, on: p.on, face: p.face,
        lx: p.lx, ly: p.ly, wx: p.wx, wy: p.wy, climb: !!p.climb, carry: !!p.carry, spot: p.spot,
      })),
    });
  }
}, DT * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`止まれない機関車（小人版） http://localhost:${PORT}`));
