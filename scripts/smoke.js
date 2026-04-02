const { io } = require('socket.io-client');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function once(socket, event, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

async function main() {
  const port = parseInt(process.env.SMOKE_PORT || '0', 10) || 0;

  process.env.PORT = String(port);
  process.env.POKER_DATA_DIR = process.env.POKER_DATA_DIR || '.tmp-smoke-data';
  process.env.AUTH_TOKEN_TTL_HOURS = process.env.AUTH_TOKEN_TTL_HOURS || '24';
  process.env.SOCKET_IO_CORS_ORIGIN = process.env.SOCKET_IO_CORS_ORIGIN || '*';

  const serverModule = require('../server');
  const server = serverModule?.server || null;
  const httpServer = server || null;

  if (!httpServer || typeof httpServer.listen !== 'function') {
    throw new Error('Smoke expects server.js to export { server }.');
  }

  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  const address = httpServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const socket = io(baseUrl, {
    transports: ['websocket'],
    timeout: 5000,
  });

  await once(socket, 'connect');

  const uniq = Math.random().toString(16).slice(2, 10);
  const name = `smoke_${uniq}`;
  const password = 'smoke_password_123';

  const registerRes = await new Promise((resolve) =>
    socket.emit('register', { name, password }, (res) => resolve(res))
  );
  if (registerRes?.error) throw new Error(`register error: ${registerRes.error}`);
  if (!registerRes?.token) throw new Error('register missing token');

  const authRes = await new Promise((resolve) =>
    socket.emit('auth', { token: registerRes.token }, (res) => resolve(res))
  );
  if (authRes?.error) throw new Error(`auth error: ${authRes.error}`);
  if (!authRes?.user?.id) throw new Error('auth missing user');

  const state1Promise = once(socket, 'game-state', 8000);
  const createRes = await new Promise((resolve) =>
    socket.emit('create-room', { buyIn: 1000, smallBlind: 10, bigBlind: 20 }, (res) => resolve(res))
  );
  if (createRes?.error) throw new Error(`create-room error: ${createRes.error}`);
  if (!createRes?.code) throw new Error('create-room missing code');

  // Expect to receive a game state after room creation.
  const state1 = await state1Promise;
  if (!state1?.code || state1.code !== createRes.code) throw new Error('game-state missing/invalid code');
  if (!Array.isArray(state1.players) || state1.players.length < 1) throw new Error('game-state players invalid');

  // Toggle ready should not crash and should emit updated state.
  const state2Promise = once(socket, 'game-state', 8000);
  socket.emit('toggle-ready');
  const state2 = await state2Promise;
  if (state2.code !== createRes.code) throw new Error('game-state after toggle-ready invalid');

  socket.disconnect();
  await sleep(50);
  await new Promise((resolve) => httpServer.close(resolve));
}

main()
  .then(() => {
    process.stdout.write('SMOKE_OK\n');
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`SMOKE_FAIL: ${e.stack || e.message}\n`);
    process.exit(1);
  });

