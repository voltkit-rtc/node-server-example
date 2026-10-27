/** Settings from the environment (.env). The VoltKit secret stays on this server. */
export function readConfig(env = process.env) {
  const { LAB_KEY: appKey, VOLTKIT_RTC_URL: baseUrl, VOLTKIT_RTC_SECRET: apiKey } = env;
  if (!appKey || appKey.length < 16) throw new Error('Set LAB_KEY: the key your app sends (16+ characters).');
  if (!baseUrl?.startsWith('https://')) throw new Error('Set VOLTKIT_RTC_URL, e.g. https://rtc.voltkit.in');
  if (!apiKey) throw new Error('Set VOLTKIT_RTC_SECRET: your VoltKit API secret.');
  const port = Number(env.PORT ?? 7000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535.');
  return { appKey, port, host: env.HOST ?? '0.0.0.0', voltkit: { baseUrl, apiKey } };
}
