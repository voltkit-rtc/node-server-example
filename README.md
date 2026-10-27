# Token server

The one piece of backend a VoltKit app needs: it keeps your VoltKit API secret and gives each user a short-lived
room token. Built with Express and [`@voltkit-rtc/server`](https://www.npmjs.com/package/@voltkit-rtc/server).

## Run

```bash
cp .env.example .env    # then fill in LAB_KEY (any long random string) and VOLTKIT_RTC_SECRET
npm install
npm start               # http://localhost:7000
npm test
```

## The API

`POST /token` with header `X-App-Key: <LAB_KEY>` and body `{ "room": "demo-room", "identity": "asha", "role": "host" }`

```json
{ "wsUrl": "wss://…", "token": "…", "room": "demo-room", "identity": "asha", "role": "host", "expiresAt": 1761040000 }
```

`role` is `host`, `cohost`, `moderator` or `viewer` (defaults to `host`). Errors are
`{ "error": { "code", "message" } }`; VoltKit's own errors (for example no minutes left) keep their status and code.

## The code

All of it is in [`src/app.mjs`](src/app.mjs), in three steps:

1. **Check the caller.** The `X-App-Key` header is compared in constant time. In your product, replace this with your
   own user login.
2. **Check the input.** Room, identity and role.
3. **Ask VoltKit.** `ensureRoom()` creates the room if it does not exist, then `createToken()` mints a token for this
   person and role.

[`src/config.mjs`](src/config.mjs) reads `.env`, and [`src/index.mjs`](src/index.mjs) starts the server.
`deploy.bash` builds and runs it in Docker.
