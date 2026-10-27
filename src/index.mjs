import { StreamClient } from '@voltkit-rtc/server';
import { createApp } from './app.mjs';
import { readConfig } from './config.mjs';

const config = readConfig();
if (process.argv.includes('--check-config')) {
  console.info(`Configuration valid, port ${config.port}.`);
} else {
  const rtc = new StreamClient({ ...config.voltkit, timeoutMs: 8000 });
  const server = createApp({ appKey: config.appKey, rtc }).listen(config.port, config.host, () =>
    console.info(`VoltKit token server on ${config.host}:${config.port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => process.exit(0)));
}
