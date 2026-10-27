import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamError } from '@voltkit-rtc/server';
import { createApp } from '../src/app.mjs';
import { readConfig } from '../src/config.mjs';

const KEY = 'example-app-key-0123456789';

async function start(rtc) {
  const server = createApp({ appKey: KEY, rtc }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (body, key = KEY, raw) => {
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-App-Key': key } : {}) },
      body: raw ?? JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { base, post, stop: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

function fakeRtc() {
  const calls = [];
  return {
    calls,
    async ensureRoom(args) { calls.push(['ensureRoom', args]); return { roomId: args.roomId, existed: false, hostToken: 'never-sent' }; },
    async createToken(args) { calls.push(['createToken', args]); return { ...args, token: 'room-token', wsUrl: 'wss://rtc.example/ws', expiresAt: 123 }; },
  };
}

test('POST /token ensures the room and returns a room token (never the host token)', async (t) => {
  const rtc = fakeRtc();
  const s = await start(rtc);
  t.after(s.stop);
  const res = await s.post({ room: 'demo-room', identity: 'asha', role: 'viewer' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { wsUrl: 'wss://rtc.example/ws', token: 'room-token', room: 'demo-room', identity: 'asha', role: 'viewer', expiresAt: 123 });
  assert.deepEqual(rtc.calls, [
    ['ensureRoom', { roomId: 'demo-room', hostIdentity: 'asha' }],
    ['createToken', { roomId: 'demo-room', identity: 'asha', role: 'viewer' }],
  ]);
  assert.equal((await s.post({ room: 'demo-room', identity: 'bo' })).body.role, 'host', 'role defaults to host');
});

test('the app key is required', async (t) => {
  const rtc = fakeRtc();
  const s = await start(rtc);
  t.after(s.stop);
  assert.equal((await s.post({ room: 'demo-room', identity: 'a' }, null)).status, 401);
  assert.equal((await s.post({ room: 'demo-room', identity: 'a' }, 'wrong-key')).status, 401);
  assert.deepEqual(rtc.calls, []);
});

test('bad input is refused before VoltKit is called', async (t) => {
  const rtc = fakeRtc();
  const s = await start(rtc);
  t.after(s.stop);
  for (const body of [{ identity: 'a' }, { room: 'X', identity: 'a' }, { room: 'demo-room', identity: 'has space' }, { room: 'demo-room', identity: 'a', role: 'owner' }]) {
    assert.equal((await s.post(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await s.post(null, KEY, '{bad json')).status, 400);
  assert.equal((await s.post(null, KEY, JSON.stringify({ room: 'x'.repeat(5000) }))).status, 413);
  assert.deepEqual(rtc.calls, []);
});

test('VoltKit errors keep their status and code; other routes are 404', async (t) => {
  const s = await start({
    async ensureRoom() { throw new StreamError('quota-exhausted', 402, 'No minutes left', false); },
  });
  t.after(s.stop);
  assert.deepEqual(await s.post({ room: 'demo-room', identity: 'a' }), { status: 402, body: { error: { code: 'quota-exhausted', message: 'No minutes left' } } });
  assert.equal((await fetch(`${s.base}/health`)).status, 200);
  assert.equal((await fetch(`${s.base}/voltkit/v1/lab/rooms`)).status, 404);
});

test('configuration', () => {
  const env = { LAB_KEY: KEY, VOLTKIT_RTC_URL: 'https://rtc.example', VOLTKIT_RTC_SECRET: 'secret' };
  assert.equal(readConfig(env).port, 7000);
  assert.throws(() => readConfig({ ...env, LAB_KEY: 'short' }), /LAB_KEY/);
  assert.throws(() => readConfig({ ...env, VOLTKIT_RTC_URL: 'http://rtc.example' }), /VOLTKIT_RTC_URL/);
  assert.throws(() => readConfig({ ...env, VOLTKIT_RTC_SECRET: '' }), /VOLTKIT_RTC_SECRET/);
});
