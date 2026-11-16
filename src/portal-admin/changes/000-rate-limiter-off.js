'use strict';
// PocketBase's own rate limiter counts per caller address. Every sign-in reaches PocketBase through Portal Admin or the apps on this server,
// so PocketBase sees a handful of callers and ends up throttling everyone together. Portal Admin limits failed sign-ins itself, per real address.
module.exports = {
  id: '000-rate-limiter-off',
  title: "Switch off PocketBase's own rate limiter",
  summary: 'It would treat all your users as one caller and block normal sign-ins. Portal Admin already limits failed sign-ins per person instead.',
  async plan(c) {
    const s = await c.pb('GET', '/api/settings');
    return s.rateLimits && s.rateLimits.enabled ? ["Turn off PocketBase's rate limiter"] : [];
  },
  async apply(c) {
    const s = await c.pb('GET', '/api/settings');
    if (s.rateLimits && s.rateLimits.enabled) await c.pb('PATCH', '/api/settings', { rateLimits: { ...s.rateLimits, enabled: false } });
    return [];
  },
};
