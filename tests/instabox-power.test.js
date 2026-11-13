'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { InstaboxClient } = require('../lib/instabox');

test('power forwards a stable idempotency key', async () => {
  const calls = [];
  const client = new InstaboxClient({
    apiKey: 'ibk_test',
    baseUrl: 'https://api.example.test',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), key: init.headers['idempotency-key'] });
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
    },
  });
  await client.power('m_1', 'suspend', { idempotencyKey: 'wbi/m_1/run1/suspend' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].key, 'wbi/m_1/run1/suspend');
  assert.match(calls[0].url, /\/v1\/machines\/m_1\/suspend$/);
});

test('power honors a custom timeout', async () => {
  const client = new InstaboxClient({
    apiKey: 'ibk_test',
    baseUrl: 'https://api.example.test',
    fetchImpl: async () => {
      throw new Error('not reached');
    },
  });
  const original = client.request.bind(client);
  let seen = null;
  client.request = async (method, path, options) => {
    seen = options;
    return { ok: true };
  };
  await client.power('m_1', 'resume', { timeoutMs: 5000 });
  assert.equal(seen.timeoutMs, 5000);
  client.request = original;
});
