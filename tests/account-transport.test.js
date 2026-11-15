'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { createTransport, ProxyRequiredError } = require('../lib/account-transport');
const { createAccountProxy } = require('../lib/account-proxy');
const { encodeFrame, FrameParser, OP_TEXT } = require('../lib/ws');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
}

function wsServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  const sockets = new Set();
  server.sockets = sockets;
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('end', () => socket.end());
    socket.on('error', () => socket.destroy());
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    const parser = new FrameParser();
    socket.on('data', (chunk) => {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode !== OP_TEXT) continue;
        socket.write(encodeFrame(OP_TEXT, `echo:${frame.payload.toString('utf8')}`, { mask: false }));
      }
    });
  });
  return server;
}

function connectProxy() {
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end();
  });
  const tunnels = new Set();
  server.tunnels = tunnels;
  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = String(req.url || '').split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    tunnels.add(clientSocket);
    tunnels.add(upstream);
    const drop = () => {
      clientSocket.destroy();
      upstream.destroy();
    };
    upstream.on('error', drop);
    clientSocket.on('error', drop);
    clientSocket.on('end', () => upstream.end());
    upstream.on('end', () => clientSocket.end());
    clientSocket.on('close', () => { tunnels.delete(clientSocket); upstream.destroy(); });
    upstream.on('close', () => { tunnels.delete(upstream); clientSocket.destroy(); });
  });
  return server;
}

test('a transport without a proxy port fails closed', () => {
  assert.throws(() => createTransport({ alias: 'alice' }), (error) => {
    assert.ok(error instanceof ProxyRequiredError);
    assert.equal(error.code, 'ERR_PROXY_REQUIRED_FAIL_CLOSED');
    assert.equal(error.status, 503);
    return true;
  });
});

test('requireFetchFor refuses an alias without a slot instead of going direct', () => {
  const state = {
    settings: { proxy: { enabled: true, basePort: 24001, size: 250, ports: {} } },
    accounts: [{ alias: 'alice', enabled: true }],
  };
  const proxies = createAccountProxy({ getState: () => state });
  assert.throws(() => proxies.requireFetchFor('ghost'), (error) => {
    assert.equal(error.code, 'ERR_PROXY_REQUIRED_FAIL_CLOSED');
    return true;
  });
  const fetchImpl = proxies.fetchFor('ghost', { candidate: true });
  assert.equal(typeof fetchImpl, 'function');
  proxies.closeAll();
});

test('createWebSocket tunnels through the account proxy CONNECT socket', async () => {
  const ws = wsServer();
  const proxy = connectProxy();
  const wsPort = await listen(ws);
  const proxyPort = await listen(proxy);
  const transport = createTransport({ alias: 'alice', port: proxyPort });

  try {
    const conn = await transport.connectWebSocket(`ws://127.0.0.1:${wsPort}/terminal`, { timeoutMs: 5000 });
    conn.resume();
    const messages = [];
    conn.on('message', (message) => messages.push(message.data.toString('utf8')));
    conn.sendText('hello');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(messages, ['echo:hello']);
    assert.ok(proxy.tunnels.size >= 1);
    conn.close();
  } finally {
    transport.destroy();
    for (const socket of [...proxy.tunnels]) socket.destroy();
    for (const socket of [...ws.sockets]) socket.destroy();
    await close(proxy);
    await close(ws);
  }
});
