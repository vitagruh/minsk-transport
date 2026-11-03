import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalStopId,
  getClientIp,
  isMutatingMethod,
  isSameOriginRequest,
  RateLimiter
} from '../lib/security.js';

function makeRequest({ host = 'minsk.test', origin, site, ip = '203.0.113.7', forwarded } = {}) {
  const headers = { host };
  if (origin !== undefined) headers.origin = origin;
  if (site !== undefined) headers['sec-fetch-site'] = site;
  if (forwarded !== undefined) headers['x-forwarded-for'] = forwarded;
  return { headers, socket: { remoteAddress: ip } };
}

test('canonicalStopId нормализует ведущие нули и отклоняет мусор', () => {
  assert.equal(canonicalStopId('1'), '1');
  assert.equal(canonicalStopId('0001'), '1');
  assert.equal(canonicalStopId(' 42 '), '42');
  assert.equal(canonicalStopId('123456789012'), '123456789012');
  assert.equal(canonicalStopId('1234567890123'), null);
  assert.equal(canonicalStopId('0'), null);
  assert.equal(canonicalStopId('-1'), null);
  assert.equal(canonicalStopId('1.0'), null);
  assert.equal(canonicalStopId('abc'), null);
  assert.equal(canonicalStopId(null), null);
});

test('isSameOriginRequest принимает только свой Origin', () => {
  assert.equal(
    isSameOriginRequest(
      makeRequest({ host: 'minsk.test:3000', origin: 'http://minsk.test:3000' })
    ),
    true
  );
  assert.equal(
    isSameOriginRequest(makeRequest({ origin: 'https://evil.example' })),
    false
  );
  assert.equal(isSameOriginRequest(makeRequest({ origin: 'null' })), false);
});

test('isSameOriginRequest использует Sec-Fetch-Site и loopback для не-браузерных клиентов', () => {
  assert.equal(isSameOriginRequest(makeRequest({ site: 'same-origin' })), true);
  assert.equal(isSameOriginRequest(makeRequest({ site: 'none' })), true);
  assert.equal(isSameOriginRequest(makeRequest({ site: 'cross-site' })), false);
  assert.equal(isSameOriginRequest(makeRequest({ ip: '127.0.0.1' })), true);
  assert.equal(isSameOriginRequest(makeRequest({ ip: '::1' })), true);
  assert.equal(isSameOriginRequest(makeRequest({ ip: '::ffff:127.0.0.1' })), true);
  assert.equal(isSameOriginRequest(makeRequest({ ip: '192.168.1.10' })), false);
});

test('isMutatingMethod относит все небезопасные методы к изменяющим', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
    assert.equal(isMutatingMethod(method), false);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(isMutatingMethod(method), true);
  }
  assert.equal(isMutatingMethod(undefined), true);
});

test('getClientIp учитывает X-Forwarded-For только при trustProxy', () => {
  const request = makeRequest({ forwarded: '198.51.100.8, 10.0.0.1' });
  assert.equal(getClientIp(request), '203.0.113.7');
  assert.equal(getClientIp(request, { trustProxy: true }), '198.51.100.8');
});

test('RateLimiter ограничивает burst и восстанавливает токены', () => {
  const limiter = new RateLimiter({ ratePerSec: 1, burst: 2 });
  const start = 1_000_000;
  assert.equal(limiter.take('ip', start).allowed, true);
  assert.equal(limiter.take('ip', start).allowed, true);
  const blocked = limiter.take('ip', start);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSec, 1);
  assert.equal(limiter.take('ip', start + 1000).allowed, true);
  assert.equal(limiter.take('ip', start + 1001).allowed, false);
  assert.equal(limiter.take('other', start + 1001).allowed, true);
});
