// 止まれない機関車（仮） 試作サーバー
// サーバーが列車と全プレイヤーを計算し、20回/秒で全員に送る
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ===== 線路（index.html と同じ計算） =====
const L = 14000;            // 路線の長さ
const STEP = 10;
const FLATS = [[0, 500], [6800, 7200], [13300, 14000]]; // 駅・給水所は平ら
const TOWER_X = 7000;      // 給水塔
const STOP_LINE = 13800;    // 停止線
const BUFFER_X = 13940;     // 車止め
function rawSlope(x) {
  for (const f of FLATS) if (x >= f[0] && x <= f[1]) return 0;
  return 0.10 + 0.12 * Math.cos(x / 500) + 0.17 * Math.cos(x / 170 + 1);
}
const H = [0];
for (let i = 1; i <= L / STEP + 2; i++) H[i] = H[i - 1] + rawSlope((i - 0.5) * STEP) * STEP;
function ground(x) {
  x = Math.max(0, Math.min(L, x));
  const i = Math.floor(x / STEP), t = x / STEP - i;
  return H[i] * (1 - t) + H[i + 1] * t;
}
function slopeAt(x) { return (ground(x + 5) - ground(x - 5)) / 10; }

// ===== 定数 =====
const GAP = 190;                         // 機関車と貨車の中心距離
const HALF = { loco: 105, wagon: 88 };   // 車体の半分の長さ
const DECK = { loco: 33, wagon: 44 };    // 床の高さ
const COLORS = ['#D94F3D', '#3D7DD9', '#E8B93A', '#4FA36B', '#B266D9', '#E8913A'];
const SPOTS = [
  { id: 'fire', body: 'loco', rel: -80, label: '焚き口：[E]で石炭をくべる' },
  { id: 'reg', body: 'loco', rel: -52, label: '加減弁：[E]上げる / [Q]下げる' },
  { id: 'brake', body: 'loco', rel: -24, label: 'ブレーキ：[E]長押し' },
  { id: 'valve', body: 'loco', rel: 22, label: '安全弁：[E]長押しで圧力を抜く' },
  { id: 'whistle', body: 'loco', rel: 72, label: '汽笛：[E]' },
  { id: 'couple', body: 'loco', rel: -100, label: '連結器：[E]長押しで修理・連結' },
  { id: 'couple', body: 'wagon', rel: 84, label: '連結器：[E]長押しで修理・連結' },
];

let g;            // ゲーム状態
const players = {};

function newGame() {
  return {
    loco: { x: 320, v: 0 }, wagon: { x: 320 - GAP, v: 0 },
    coupled: true, couplerHP: 100,
    reg: 0, pressure: 45, fire: 35, water: 100, coal: 30,
    brakeHeat: 0, braking: false, venting: false,
    trainHP: 100, cargo: 3, phase: 'play', result: null,
    stopTimer: 0, msgs: [], t: 0, whistle: 0,
  };
}
g = newGame();

function msg(text) { g.msgs.push({ text, t: g.t }); if (g.msgs.length > 5) g.msgs.shift(); }
function bodyX(b) { return b === 'loco' ? g.loco.x : (g.coupled ? g.loco.x - GAP : g.wagon.x); }
function bodyV(b) { return b === 'loco' ? g.loco.v : (g.coupled ? g.loco.v : g.wagon.v); }
function deckY(b) { return ground(bodyX(b)) - DECK[b]; }

function spawn(p) {
  p.on = 'wagon'; p.rel = (Math.random() - 0.5) * 120;
  p.x = bodyX('wagon') + p.rel; p.y = deckY('wagon'); p.vx = 0; p.vy = 0; p.grounded = false;
}

function findSpot(p) {
  if (!p.on) return null;
  let best = null, bd = 18;
  for (const s of SPOTS) {
    if (s.body !== p.on) continue;
    const d = Math.abs(s.rel - p.rel);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
function nearTower(p) { return Math.abs(p.x - TOWER_X) < 70; }
function canCouple() {
  return !g.coupled && Math.abs(g.wagon.x - (g.loco.x - GAP)) < 16 && Math.abs(g.wagon.v - g.loco.v) < 90;
}

function throwOff(p, reason) {
  if (!p.on) return;
  const v = bodyV(p.on);
  p.x = bodyX(p.on) + p.rel; p.y = deckY(p.on) - 2;
  p.vx = v * 0.7 + (Math.random() - 0.5) * 120; p.vy = -260; p.on = null; p.grounded = false;
  if (reason) msg(`${p.name} が${reason}`);
}

function applyMotion(obj, accel, oppose, dt) {
  obj.v += accel * dt;
  const dec = oppose * dt;
  if (Math.abs(obj.v) <= dec) obj.v = 0; else obj.v -= Math.sign(obj.v) * dec;
}

function tick(dt) {
  g.t += dt;
  g.braking = false; g.venting = false;
  const playing = g.phase === 'play';

  // ---- 操作 ----
  for (const p of Object.values(players)) {
    const inp = p.input, prev = p.prev;
    const pressE = inp.e && !prev.e, pressQ = inp.q && !prev.q;
    p.cool = Math.max(0, p.cool - dt);
    const s = findSpot(p);
    p.spot = s ? s.id : (nearTower(p) ? 'tower' : null);
    if (playing && s) {
      if (s.id === 'fire' && pressE) {
        if (g.coal >= 1 && p.cool <= 0) { g.coal -= 1; g.fire = Math.min(100, g.fire + 10); p.cool = 0.35; }
        else if (g.coal < 1) msg('石炭がない！');
      }
      if (s.id === 'reg') {
        if (pressE) g.reg = Math.min(1, g.reg + 0.25);
        if (pressQ) g.reg = Math.max(-0.5, g.reg - 0.25);
      }
      if (s.id === 'brake' && inp.e) g.braking = true;
      if (s.id === 'valve' && inp.e) g.venting = true;
      if (s.id === 'whistle' && pressE) g.whistle = g.t;
      if (s.id === 'couple' && inp.e) {
        if (g.coupled) g.couplerHP = Math.min(100, g.couplerHP + 30 * dt);
        else if (canCouple()) { g.coupled = true; g.couplerHP = 50; msg('連結した！'); }
      }
    }
    if (playing && !s && nearTower(p) && inp.e) {
      if (Math.abs(g.loco.v) < 30 && Math.abs(g.loco.x - TOWER_X) < 160) {
        g.water = Math.min(100, g.water + 40 * dt);
        g.coal = Math.min(30, g.coal + 6 * dt);
      }
    }
  }

  // ---- 機関車 ----
  const L0 = g.loco, vPrev = L0.v;
  const mass = g.coupled ? 1.4 : 1;
  const aEngine = playing ? g.reg * (g.pressure / 100) * 60 / mass : 0;
  const aGrav = 120 * slopeAt(L0.x);
  const brakeEff = Math.max(0.25, 1 - g.brakeHeat / 120) * 0.8;
  const aBrake = g.braking ? 170 * brakeEff : 0;
  applyMotion(L0, aEngine + aGrav, aBrake + 6 + 0.12 * Math.abs(L0.v), dt);
  L0.v = Math.max(-400, Math.min(600, L0.v));
  L0.x += L0.v * dt;
  if (L0.x < 100) { L0.x = 100; L0.v = Math.max(0, L0.v); }
  if (L0.x >= BUFFER_X) {
    if (L0.v > 80) {
      g.trainHP -= 40; g.crashed = true; msg('車止めに激突！！');
      for (const p of Object.values(players)) throwOff(p);
    }
    L0.x = BUFFER_X; L0.v = -Math.abs(L0.v) * 0.2;
  }
  const acc = (L0.v - vPrev) / dt;
  g.brakeHeat = Math.max(0, Math.min(150, g.brakeHeat + (g.braking && Math.abs(L0.v) > 5 ? 30 : -12) * dt));

  // ---- ボイラー ----
  if (g.water > 0) { g.pressure += g.fire * 0.15 * dt; g.water = Math.max(0, g.water - g.fire * 0.015 * dt); }
  else g.pressure -= 5 * dt;
  g.pressure -= (Math.abs(g.reg) * Math.abs(L0.v) * 0.03 + 0.8) * dt;
  if (g.venting) g.pressure -= 35 * dt;
  g.fire = Math.max(0, g.fire - 3 * dt);
  g.pressure = Math.max(0, g.pressure);
  if (g.pressure > 125 && playing) {
    g.pressure = 10; g.fire = 0; g.trainHP -= 25;
    if (g.cargo > 0) g.cargo--;
    msg('ボイラーが破裂した！！');
    for (const p of Object.values(players)) throwOff(p);
  }

  // ---- 連結器と貨車 ----
  if (g.coupled) {
    g.wagon.x = L0.x - GAP; g.wagon.v = L0.v;
    const stress = Math.max(0, Math.abs(acc) - 60) * 0.1 + (Math.abs(L0.v) > 280 ? 3 : 0);
    g.couplerHP -= stress * dt;
    if (g.couplerHP <= 0 && playing) { g.couplerHP = 0; g.coupled = false; msg('連結が外れた！貨車が離れていく！'); }
  } else {
    const W = g.wagon;
    applyMotion(W, 120 * slopeAt(W.x), 6 + 0.12 * Math.abs(W.v), dt);
    W.x += W.v * dt;
    if (W.x < 40) { W.x = 40; W.v = 0; }
    const limit = L0.x - GAP + 2;
    if (W.x > limit) {
      const rel = W.v - L0.v;
      if (rel > 200 && g.cargo > 0) { g.cargo--; msg('ドーン！貨車が追突、スイカが割れた'); }
      W.x = limit; const avg = (W.v + L0.v) / 2; W.v = avg; L0.v = avg;
    }
  }

  // ---- 急な揺れで落ちる ----
  for (const p of Object.values(players)) {
    if (!p.on || !playing) continue;
    const v = Math.abs(bodyV(p.on));
    if (Math.abs(acc) > 420 && !p.input.e) throwOff(p, '投げ出された！');
    else if (v > 380 && !p.input.e && Math.random() < 0.2 * dt) throwOff(p, '振り落とされた！');
  }

  // ---- プレイヤーの移動 ----
  for (const p of Object.values(players)) {
    const inp = p.input, prev = p.prev;
    const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    const pressJ = inp.j && !prev.j;
    if (p.on) {
      p.rel += dir * 110 * dt;
      const bx = bodyX(p.on);
      if (Math.abs(p.rel) > HALF[p.on] + 4) {
        p.x = bx + p.rel; p.y = deckY(p.on); p.vx = bodyV(p.on) + dir * 60; p.vy = -60; p.on = null; p.grounded = false;
      } else if (pressJ) {
        p.x = bx + p.rel; p.y = deckY(p.on); p.vx = bodyV(p.on) + dir * 80; p.vy = -380; p.on = null; p.grounded = false;
      } else { p.x = bx + p.rel; p.y = deckY(p.on); }
    } else {
      const target = dir * 200;
      p.vx += (target - p.vx) * Math.min(1, (p.grounded ? 6 : 1.5) * dt);
      if (pressJ && p.grounded) { p.vy = -380; p.grounded = false; }
      p.vy += 900 * dt;
      p.x = Math.max(0, Math.min(L, p.x + p.vx * dt));
      p.y += p.vy * dt;
      const gy = ground(p.x);
      if (p.y >= gy) { p.y = gy; p.vy = 0; p.grounded = true; }
      if (p.vy > 0) {
        for (const b of ['loco', 'wagon']) {
          const bx = bodyX(b), dy = deckY(b);
          if (Math.abs(p.x - bx) < HALF[b] && p.y >= dy - 4 && p.y <= dy + 16) {
            p.on = b; p.rel = p.x - bx; p.vy = 0; p.grounded = false; break;
          }
        }
      }
    }
    p.prev = { ...inp };
  }

  // ---- ゴール判定 ----
  if (playing) {
    if (L0.x > 13300 && Math.abs(L0.v) < 4) {
      g.stopTimer += dt;
      if (g.stopTimer > 1.5) {
        const err = Math.abs(L0.x - STOP_LINE);
        const stars = g.crashed ? 0 : err < 25 ? 3 : err < 80 ? 2 : 1;
        g.phase = 'result';
        g.result = { ok: true, err: Math.round(err), stars, cargo: g.cargo, wagon: g.coupled, crashed: !!g.crashed };
      }
    } else g.stopTimer = 0;
    if (g.trainHP <= 0) { g.phase = 'result'; g.result = { ok: false }; msg('機関車が壊れた…'); }
  }
  g.msgs = g.msgs.filter(m => g.t - m.t < 4);
}

function restart() {
  g = newGame();
  for (const p of Object.values(players)) { spawn(p); p.rHold = 0; }
  msg('出発進行！');
}

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    if (players[socket.id]) return;
    const used = Object.values(players).map(p => p.color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[0];
    const p = {
      id: socket.id, name: String(name || 'ななし').slice(0, 10), color,
      input: { l: false, r: false, j: false, e: false, q: false }, prev: {}, cool: 0, spot: null,
    };
    spawn(p);
    players[socket.id] = p;
    msg(`${p.name} が乗車した`);
    socket.emit('joined', { id: socket.id, spots: SPOTS });
  });
  socket.on('input', (inp) => {
    const p = players[socket.id];
    if (!p || typeof inp !== 'object') return;
    // l=左 r=右 j=ジャンプ e=操作 q=加減弁を下げる restart=Rキー
    p.input = { l: !!inp.l, r: !!inp.r, j: !!inp.j, e: !!inp.e, q: !!inp.q, restart: !!inp.rst };
  });
  socket.on('disconnect', () => {
    delete players[socket.id];
    // 誰もいなくなったら最初からにする
    if (Object.keys(players).length === 0) g = newGame();
  });
});

// 結果画面で誰かがRを押したらリスタート
const DT = 1 / 30;
let frame = 0;
setInterval(() => {
  for (const p of Object.values(players)) {
    // 結果画面ではRを押すだけ、プレイ中はRを2秒長押しでリセット
    p.rHold = p.input.restart ? (p.rHold || 0) + DT : 0;
    const pressR = p.input.restart && !p.prevRestart;
    p.prevRestart = p.input.restart;
    if (g.phase === 'result' && pressR) { restart(); break; }
    if (g.phase === 'play' && p.rHold > 2) { const who = p.name; restart(); msg(`${who} がリセットした`); break; }
  }
  // 結果画面は20秒たったら自動で最初から
  if (g.phase === 'result') {
    g.resultTimer = (g.resultTimer || 0) + DT;
    if (g.resultTimer > 20) restart();
  }
  tick(DT);
  if (++frame % 2 === 0) {
    io.emit('state', {
      g: {
        loco: g.loco, wagon: g.wagon, coupled: g.coupled, couplerHP: g.couplerHP,
        reg: g.reg, pressure: g.pressure, fire: g.fire, water: g.water, coal: g.coal,
        brakeHeat: g.brakeHeat, braking: g.braking, venting: g.venting,
        trainHP: g.trainHP, cargo: g.cargo, phase: g.phase, result: g.result,
        msgs: g.msgs.map(m => m.text), whistle: g.whistle,
      },
      players: Object.values(players).map(p => ({
        id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, on: p.on, spot: p.spot,
      })),
    });
  }
}, DT * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`止まれない機関車 http://localhost:${PORT}`));
