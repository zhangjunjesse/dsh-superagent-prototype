// Brain-owned read capabilities. This module never evaluates code or starts a process.
export const brainDirectToolNames = Object.freeze(['read', 'read_image', 'glob', 'grep', 'current_time', 'calculate', 'web_search', 'web_fetch']);
const directNames = new Set(brainDirectToolNames);
export const isBrainDirectTool = name => directNames.has(name);

export const readCapabilityDefinitions = Object.freeze([
  { name: 'current_time', description: '读取真实当前时间，可指定 IANA 时区；不修改系统时间。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      timeZone: { type: 'string', description: '可选 IANA 时区，例如 Asia/Shanghai、UTC、America/New_York。省略时使用组织时区。' },
    } } },
  { name: 'calculate', description: '确定性计算：arithmetic 算术表达式（数字、括号、+ - * / % ^）；convert 同维度单位换算；date_difference/date_add 带明确时区的日期差与固定时长加减。不执行代码。',
    parameters: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
      operation: { type: 'string', enum: ['arithmetic', 'convert', 'date_difference', 'date_add'] },
      expression: { type: 'string', description: 'arithmetic 必填，最多 512 字符；% 为取余，^ 为幂。' },
      value: { type: 'number', description: 'convert 必填，待换算数值。' },
      from: { type: 'string', description: 'convert 必填。支持 mm/cm/m/km/in/ft/yd/mi，mg/g/kg/oz/lb，ml/l，ms/s/min/h/day/week，celsius/fahrenheit/kelvin。' },
      to: { type: 'string', description: 'convert 必填，目标单位须与 from 维度相同。' },
      start: { type: 'string', description: 'date_difference 必填：YYYY-MM-DD（UTC）或含 Z/±HH:mm 的 ISO 时间。' },
      end: { type: 'string', description: 'date_difference 必填，与 start 格式相同。' },
      date: { type: 'string', description: 'date_add 必填：YYYY-MM-DD（UTC）或含 Z/±HH:mm 的 ISO 时间。' },
      amount: { type: 'number', description: 'date_add 必填，要增加的固定时长；负数表示减去。' },
      unit: { type: 'string', enum: ['ms', 's', 'min', 'h', 'day', 'week'], description: '日期运算必填。day 固定为 24 小时，week 固定为 7 天，不按当地夏令时或日历月份调整。' },
    } } },
]);

const invalid = message => { throw new Error(message); };
function fields(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
    Reflect.ownKeys(args).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some(key => !Object.hasOwn(args, key))) invalid('工具参数格式不正确');
}
function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e100) invalid('数值必须有限且绝对值不超过 1e100');
  return Object.is(value, -0) ? 0 : value;
}

function arithmetic(expression) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 512) invalid('表达式需要 1–512 个字符');
  const tokens = []; let offset = 0;
  while (offset < expression.length) {
    if (/\s/.test(expression[offset])) { offset++; continue; }
    const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(offset));
    if (numeric) { tokens.push(number(Number(numeric[0]))); offset += numeric[0].length; }
    else if ('()+-*/%^'.includes(expression[offset])) tokens.push(expression[offset++]);
    else invalid('表达式只能包含数字、括号和 + - * / % ^ 运算符');
    if (tokens.length > 256) invalid('表达式最多包含 256 个数字和运算符');
  }
  let cursor = 0, depth = 0;
  const atom = () => {
    if (++depth > 32) invalid('表达式嵌套不能超过 32 层');
    try {
      if (tokens[cursor] === '+' || tokens[cursor] === '-') {
        const sign = tokens[cursor++]; const value = atom(); return sign === '-' ? number(-value) : value;
      }
      let value;
      if (tokens[cursor] === '(') {
        cursor++; value = sum();
        if (tokens[cursor++] !== ')') invalid('表达式括号不匹配');
      } else if (typeof tokens[cursor] === 'number') value = tokens[cursor++];
      else invalid('表达式缺少数字或括号');
      if (tokens[cursor] === '^') { cursor++; const exponent = atom(); if (Math.abs(exponent) > 1000) invalid('幂指数绝对值不能超过 1000'); value = number(value ** exponent); }
      return value;
    } finally { depth--; }
  };
  const product = () => {
    let value = atom();
    while (['*', '/', '%'].includes(tokens[cursor])) {
      const operator = tokens[cursor++], right = atom();
      if ((operator === '/' || operator === '%') && right === 0) invalid('不能除以零或对零取余');
      value = number(operator === '*' ? value * right : operator === '/' ? value / right : value % right);
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const operator = tokens[cursor++], right = product(); value = number(operator === '+' ? value + right : value - right);
    }
    return value;
  };
  const result = sum();
  if (cursor !== tokens.length) invalid('表达式包含不完整或多余的内容');
  return { operation: 'arithmetic', expression, result };
}

const units = new Map(Object.entries({
  mm: ['length', .001], cm: ['length', .01], m: ['length', 1], km: ['length', 1000],
  in: ['length', .0254], ft: ['length', .3048], yd: ['length', .9144], mi: ['length', 1609.344],
  mg: ['mass', .000001], g: ['mass', .001], kg: ['mass', 1], oz: ['mass', .028349523125], lb: ['mass', .45359237],
  ml: ['volume', .001], l: ['volume', 1], ms: ['duration', .001], s: ['duration', 1],
  min: ['duration', 60], h: ['duration', 3600], day: ['duration', 86400], week: ['duration', 604800],
  celsius: ['temperature', 1, 273.15], fahrenheit: ['temperature', 5 / 9, 459.67], kelvin: ['temperature', 1, 0],
}));
const durations = new Map([['ms', 1], ['s', 1000], ['min', 60000], ['h', 3600000], ['day', 86400000], ['week', 604800000]]);
function unitName(value, table) {
  if (typeof value !== 'string' || value.length > 32 || !table.has(value)) invalid('不支持该单位');
  return value;
}
function convert(args) {
  fields(args, ['operation', 'value', 'from', 'to'], ['value', 'from', 'to']);
  const value = number(args.value), from = unitName(args.from, units), to = unitName(args.to, units);
  const [kind, scale, offset = 0] = units.get(from), [targetKind, targetScale, targetOffset = 0] = units.get(to);
  if (kind !== targetKind) invalid('只能在同一维度的单位之间换算');
  return { operation: 'convert', value, from, to, result: number((value + offset) * scale / targetScale - targetOffset) };
}

function instant(value) {
  if (typeof value !== 'string' || value.length > 40) invalid('日期格式不正确');
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) invalid('日期须为 YYYY-MM-DD 或带明确时区的 ISO 时间');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days ||
    Number(match[4] || 0) > 23 || Number(match[5] || 0) > 59 || Number(match[6] || 0) > 59 ||
    match[8] !== undefined && match[8] !== 'Z' && (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4)) > 59)) invalid('日期或时区偏移无效');
  const parsed = Date.parse(match[4] === undefined ? value + 'T00:00:00.000Z' : value);
  if (!Number.isFinite(parsed)) invalid('日期无效');
  return parsed;
}
function dateCalculation(args) {
  const difference = args.operation === 'date_difference';
  fields(args, difference ? ['operation', 'start', 'end', 'unit'] : ['operation', 'date', 'amount', 'unit'],
    difference ? ['start', 'end', 'unit'] : ['date', 'amount', 'unit']);
  const unit = unitName(args.unit, durations), scale = durations.get(unit);
  if (difference) return { operation: args.operation, start: args.start, end: args.end, unit, result: number((instant(args.end) - instant(args.start)) / scale) };
  const amount = number(args.amount), timestamp = instant(args.date) + amount * scale;
  if (!Number.isFinite(timestamp) || timestamp < -62135596800000 || timestamp > 253402300799999) invalid('计算结果日期须在 0001–9999 年之间');
  return { operation: args.operation, date: args.date, amount, unit, result: new Date(timestamp).toISOString() };
}

function currentTime(args, options) {
  fields(args, ['timeZone']);
  const timeZone = Object.hasOwn(args, 'timeZone') ? args.timeZone : options.timeZone ?? 'Asia/Shanghai';
  if (typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timeZone)) invalid('时区需要有效的 IANA 名称');
  let formatter;
  try { formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZoneName: 'longOffset' }); }
  catch { invalid('时区需要有效的 IANA 名称'); }
  const value = options.now === undefined ? new Date() : options.now();
  const date = value instanceof Date ? value : new Date(number(value));
  if (!Number.isFinite(date.getTime())) invalid('当前时间来源无效');
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { utc: date.toISOString(), unixMilliseconds: date.getTime(), timeZone: formatter.resolvedOptions().timeZone,
    local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${parts.timeZoneName === 'GMT' ? '+00:00' : parts.timeZoneName.replace('GMT', '')}` };
}

// Caller-supplied clock makes verification repeatable; production always uses the real clock.
export function executeReadCapability(name, args, options = {}) {
  if (name === 'current_time') return currentTime(args, options);
  if (name !== 'calculate') invalid('未知的只读工具');
  fields(args, ['operation', 'expression', 'value', 'from', 'to', 'start', 'end', 'date', 'amount', 'unit'], ['operation']);
  if (args.operation === 'arithmetic') { fields(args, ['operation', 'expression'], ['expression']); return arithmetic(args.expression); }
  if (args.operation === 'convert') return convert(args);
  if (args.operation === 'date_difference' || args.operation === 'date_add') return dateCalculation(args);
  invalid('不支持该计算操作');
}
