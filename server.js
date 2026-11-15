// 地図師たち（仮） 試作サーバー
// 島や地図の計算は各プレイヤーの画面側で行う。
// サーバーは「みんなの位置を配る」ことと「地図を見せ合う」ときの受け渡しだけをする。
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 2e6 });
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const COLORS = ['#D94F3D', '#3D7DD9', '#E8B93A', '#4FA36B', '#B266D9', '#E8913A', '#3DBFD9', '#D93D8C'];
const players = {};
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    const used = Object.values(players).map((p) => p.color);
    players[socket.id] = {
      id: socket.id,
      name: String(name || 'ななし').slice(0, 10),
      color: COLORS.find((c) => !used.includes(c)) || COLORS[0],
      x: 0, y: 0, z: 0, ry: 0, onBoat: false, bx: 0, bz: 0, bry: 0, sail: 0,
    };
    socket.emit('joined', { id: socket.id, color: players[socket.id].color });
  });

  // 自分の位置と船の位置
  socket.on('pos', (d) => {
    const p = players[socket.id];
    if (!p || !d) return;
    p.x = num(d.x); p.y = num(d.y); p.z = num(d.z); p.ry = num(d.ry);
    p.onBoat = !!d.onBoat; p.bx = num(d.bx); p.bz = num(d.bz); p.bry = num(d.bry); p.sail = num(d.sail);
  });

  // 近くの仲間に、自分の確定した地図を渡す
  socket.on('share', (d) => {
    const me = players[socket.id];
    if (!me || !d || !players[d.to] || !d.data) return;
    io.to(d.to).emit('share', { from: me.name, data: d.data, marks: Array.isArray(d.marks) ? d.marks.slice(0, 50) : [] });
  });

  socket.on('disconnect', () => { delete players[socket.id]; });
});

setInterval(() => io.emit('players', Object.values(players)), 66);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`地図師たち http://localhost:${PORT}`));
