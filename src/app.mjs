import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamError } from '@voltkit-rtc/server';

const ROOM = /^[a-z0-9][a-z0-9-]{2,63}$/;
const IDENTITY = /^[A-Za-z0-9._-]{1,64}$/;
const ROLES = ['host', 'cohost', 'moderator', 'viewer'];

/**
 * The whole token server: your app asks for a room token, this server checks the app is yours and asks VoltKit for
 * one. The VoltKit API secret never leaves the server; the app only ever holds a short-lived room token.
 *
 * `rtc` is a StreamClient from @voltkit-rtc/server.
 */
export function createApp({ appKey, rtc }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4kb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // POST /token  { room, identity, role? }  ->  { wsUrl, token, room, identity, role, expiresAt }
  app.post('/token', async (req, res) => {
    // 1. Check the caller is your app. In a real product this is your own user login.
    if (!sameKey(req.get('x-app-key'), appKey)) return fail(res, 401, 'unauthorized', 'Wrong app key.');

    // 2. Check the input.
    const { room, identity, role = 'host' } = req.body ?? {};
    if (!ROOM.test(room ?? '')) return fail(res, 400, 'bad-room', 'room: 3–64 of a-z 0-9 -');
    if (!IDENTITY.test(identity ?? '')) return fail(res, 400, 'bad-identity', 'identity: 1–64 of A-Z a-z 0-9 . _ -');
    if (!ROLES.includes(role)) return fail(res, 400, 'bad-role', `role: ${ROLES.join(', ')}`);

    // 3. Make sure the room exists, then mint a token for this person and role.
    try {
      await rtc.ensureRoom({ roomId: room, hostIdentity: identity });
      const t = await rtc.createToken({ roomId: room, identity, role });
      res.set('Cache-Control', 'no-store').json({
        wsUrl: t.wsUrl, token: t.token, room, identity: t.identity, role: t.role, expiresAt: t.expiresAt,
      });
    } catch (error) {
      if (error instanceof StreamError) return fail(res, error.status >= 400 ? error.status : 502, error.code, error.message);
      fail(res, 502, 'voltkit-unavailable', 'VoltKit did not answer.');
    }
  });

  app.use((_req, res) => fail(res, 404, 'not-found', 'Use POST /token.'));
  // Bad JSON, a body over 4 KB, anything unexpected.
  app.use((error, _req, res, _next) => {
    if (error?.type === 'entity.parse.failed') return fail(res, 400, 'bad-json', 'Send a JSON body.');
    if (error?.type === 'entity.too.large') return fail(res, 413, 'too-large', 'Body too large.');
    console.error('Request failed:', error?.name);
    fail(res, 500, 'internal', 'Unexpected server error.');
  });
  return app;
}

function fail(res, status, code, message) {
  res.status(status).json({ error: { code, message } });
}

/** Constant-time comparison, so the key cannot be guessed from response times. */
function sameKey(given, expected) {
  const a = Buffer.from(typeof given === 'string' ? given : '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
