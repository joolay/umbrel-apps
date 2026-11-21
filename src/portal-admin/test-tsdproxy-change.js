'use strict';
const assert = require('assert'), m = require('./changes/014-tsdproxy-published.js');
(async () => {
  const calls = [], ok = async (method, p) => { calls.push(method + ' ' + p.split('?')[0]); return method === 'GET' ? JSON.stringify([{ Id: 'abc', Image: 'almeidapaulopt/tsdproxy:2' }, { Id: 'zzz', Image: 'other' }]) : ''; };
  await m.restartTsdproxy(ok); assert.deepStrictEqual(calls, ['GET /containers/json', 'POST /containers/abc/restart']);
  await assert.rejects(m.restartTsdproxy(async () => '[]'), /not found/);
  await assert.rejects(m.restartTsdproxy(async () => JSON.stringify([{ Id: 'a', Image: 'tsdproxy' }, { Id: 'b', Image: 'tsdproxy' }])), /More than one/);
  console.log('tsdproxy change ok');
})();
