import test from 'node:test';
import assert from 'node:assert/strict';
import { Limiter, OverloadError, TtlCache } from '../lib/cache.js';

test('TtlCache возвращает значение в пределах TTL и обновляет после истечения', async () => {
  const cache = new TtlCache({ maxEntries: 10 });
  cache.set('key', 'old');
  assert.equal(cache.entry('key').value, 'old');
  await new Promise((resolve) => setTimeout(resolve, 10));
  let calls = 0;
  const value = await cache.wrap('key', 5, async () => {
    calls += 1;
    return 'fresh';
  });
  assert.equal(value, 'fresh');
  assert.equal(calls, 1);
  assert.equal(cache.entry('key').value, 'fresh');
});

test('TtlCache удаляет самые старые записи при переполнении', () => {
  const cache = new TtlCache({ maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.entry('a'), null);
  assert.equal(cache.entry('b').value, 2);
  assert.equal(cache.entry('c').value, 3);
});

test('TtlCache объединяет одновременные запросы и ограничивает их число', async () => {
  const cache = new TtlCache({ maxEntries: 10, maxFlights: 1 });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const pending = cache.wrap('a', 1000, async () => {
    calls += 1;
    await gate;
    return 'a';
  });
  await assert.rejects(
    cache.wrap('b', 1000, async () => 'b'),
    (error) => error instanceof OverloadError
  );
  release();
  assert.equal(await pending, 'a');
  assert.equal(calls, 1);
  const duplicate = await Promise.all([
    cache.wrap('c', 1000, async () => {
      calls += 1;
      return 'c';
    }),
    cache.wrap('c', 1000, async () => {
      calls += 1;
      return 'c';
    })
  ]);
  assert.deepEqual(duplicate, ['c', 'c']);
  assert.equal(calls, 2);
});

test('Limiter отклоняет задачи сверх лимита очереди', async () => {
  const limiter = new Limiter(1, 0, 1);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = limiter.run(async () => {
    await gate;
    return 'first';
  });
  const second = limiter.run(async () => 'second');
  await assert.rejects(
    limiter.run(async () => 'third'),
    (error) => error instanceof OverloadError
  );
  release();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
});
