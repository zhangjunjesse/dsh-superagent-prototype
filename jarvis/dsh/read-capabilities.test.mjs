import test from 'node:test';
import assert from 'node:assert/strict';
import { brainDirectToolNames, isBrainDirectTool, readCapabilityDefinitions, executeReadCapability } from './read-capabilities.mjs';

const calculate = args => executeReadCapability('calculate', args);
const arithmetic = expression => calculate({ operation: 'arithmetic', expression }).result;

test('brain direct allowlist excludes every execution/mutation tool and unknown name', () => {
  assert.deepEqual(brainDirectToolNames, ['read', 'read_image', 'glob', 'grep', 'current_time', 'calculate', 'web_search', 'web_fetch']);
  for (const name of ['write', 'edit', 'bash', 'pwsh', 'working_directory', 'job_kill', 'skill', 'subagent', 'run_code', 'jarvis_work_submit', 'unknown']) assert.equal(isBrainDirectTool(name), false);
  assert.deepEqual(readCapabilityDefinitions.map(tool => tool.name), ['current_time', 'calculate']);
  assert.throws(() => executeReadCapability('unknown', {}), /未知/);
});

test('arithmetic evaluates precedence, brackets, decimals, signed powers and remainders deterministically', () => {
  for (const [expression, expected] of [['(2 + 3) * 4 - 6 / 2', 17], ['1.25e2 + .5', 125.5],
    ['-2^2', -4], ['(-2)^2', 4], ['2^3^2', 512], ['2^-2', .25], ['17 % 5', 2], ['-0', 0]]) assert.equal(arithmetic(expression), expected, expression);
});

test('arithmetic rejects code, non-finite results, invalid syntax and oversized work without executing input', () => {
  const cases = ['globalThis.__readCapabilityInjected = true', 'process.exit()', '1; 2', 'Math.sqrt(4)', '2 ** 4', '2(3)', '1 +',
    '()', '(1 + 2', '1 2', '1/0', '1%0', '1e101', '10^1000', '2^1001', '(-1)^.5', '1+'.repeat(128) + '1',
    '('.repeat(33) + '1' + ')'.repeat(33), '1'.repeat(513)];
  for (const expression of cases) assert.throws(() => arithmetic(expression), undefined, expression);
  assert.equal(globalThis.__readCapabilityInjected, undefined);
});

test('unit conversion handles distance, mass, duration, volume and affine temperature conversion', () => {
  for (const [value, from, to, expected] of [[1, 'mi', 'm', 1609.344], [1, 'lb', 'kg', .45359237],
    [2, 'h', 'min', 120], [500, 'ml', 'l', .5], [32, 'fahrenheit', 'celsius', 0], [100, 'celsius', 'fahrenheit', 212]]) {
    const actual = calculate({ operation: 'convert', value, from, to });
    assert.ok(Math.abs(actual.result - expected) < 1e-9, JSON.stringify(actual));
    assert.equal(actual.to, to);
  }
  for (const args of [{ value: 1, from: 'm', to: 'kg' }, { value: '1', from: 'm', to: 'km' },
    { value: Infinity, from: 'm', to: 'km' }, { value: 1, from: 'custom', to: 'm' }]) assert.throws(() => calculate({ operation: 'convert', ...args }));
});

test('date differences use explicit instants and leap days, including changing DST offsets', () => {
  assert.equal(calculate({ operation: 'date_difference', start: '2024-02-28', end: '2024-03-01', unit: 'day' }).result, 2);
  assert.equal(calculate({ operation: 'date_difference', start: '2026-03-08T01:30:00-05:00', end: '2026-03-08T03:30:00-04:00', unit: 'h' }).result, 1);
  assert.equal(calculate({ operation: 'date_difference', start: '2026-11-16T08:00:00+08:00', end: '2026-11-16T00:00:00Z', unit: 's' }).result, 0);
});

test('date addition uses bounded fixed elapsed durations and returns UTC', () => {
  assert.equal(calculate({ operation: 'date_add', date: '2024-02-28', amount: 1, unit: 'day' }).result, '2024-02-29T00:00:00.000Z');
  assert.equal(calculate({ operation: 'date_add', date: '2026-11-16T08:00:00+08:00', amount: -1.5, unit: 'h' }).result, '2026-11-15T22:30:00.000Z');
  assert.throws(() => calculate({ operation: 'date_add', date: '9999-12-31', amount: 1, unit: 'day' }), /0001–9999/);
  assert.throws(() => calculate({ operation: 'date_add', date: '2026-11-16', amount: 1e100, unit: 'week' }));
});

test('date operations reject rollover dates, local-zone ambiguity, unsupported units and missing fields', () => {
  for (const date of ['2026-02-29', '2024-02-30', '2026-00-10', '0000-01-01', '2026-11-16T12:00:00', '2026-11-16T24:00:00Z', '2026-11-16T00:00:00+24:00', 'next Monday']) {
    assert.throws(() => calculate({ operation: 'date_add', date, amount: 1, unit: 'day' }), undefined, date);
  }
  assert.throws(() => calculate({ operation: 'date_add', date: '2026-11-16', amount: 1, unit: 'month' }));
  assert.throws(() => calculate({ operation: 'date_difference', start: '2026-11-16', unit: 'day' }));
});

test('current_time reports one real injected instant in the requested IANA timezone', () => {
  const now = () => new Date('2026-11-16T00:02:03.123Z');
  assert.deepEqual(executeReadCapability('current_time', {}, { now }), {
    utc: '2026-11-16T00:02:03.123Z', unixMilliseconds: 1794787323123, timeZone: 'Asia/Shanghai', local: '2026-11-16T08:02:03.123+08:00',
  });
  assert.equal(executeReadCapability('current_time', { timeZone: 'America/New_York' }, { now }).local, '2026-11-15T19:02:03.123-05:00');
  assert.equal(executeReadCapability('current_time', {}, { now, timeZone: 'UTC' }).local, '2026-11-16T00:02:03.123+00:00');
});

test('production current_time reads the clock and rejects invalid timezone/input independently of schema', () => {
  const before = Date.now(), value = executeReadCapability('current_time', { timeZone: 'UTC' }), after = Date.now();
  assert.ok(value.unixMilliseconds >= before && value.unixMilliseconds <= after);
  for (const args of [{ timeZone: 'no-such/Timezone' }, { timeZone: '+08:00' }, { timeZone: null }, { timeZone: 'a'.repeat(101) }, { timezone: 'UTC' }, []]) assert.throws(() => executeReadCapability('current_time', args));
});

test('all calculations enforce argument types, required fields and per-operation keys without schema dispatch', () => {
  for (const args of [null, [], {}, { operation: 'arithmetic' }, { operation: 'arithmetic', expression: '1+1', script: 'evil' },
    { operation: 'arithmetic', expression: '1+1', amount: 2 }, { operation: 'convert', value: 1, from: 'm' },
    { operation: 'date_add', date: '2026-11-16', amount: '1', unit: 'day' }, { operation: 'shell', expression: '1+1' },
    Object.create({ operation: 'arithmetic', expression: '1+1' })]) assert.throws(() => calculate(args));
});
