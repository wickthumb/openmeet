'use strict';
// Independent implementation of the source-informed TIME-v1 bounded contract.
// No runtime fixture, provider, clock, file or locale dependency.
const MIN48 = -(1n << 47n), MAX48 = (1n << 47n) - 1n;
const MIN32 = -(1n << 31n), MAX32 = (1n << 31n) - 1n;
function bounded(n, lo, hi) {
  if (n < lo || n > hi) throw new RangeError('Unsupported integer domain');
  return n;
}
function integer(s) {
  if (typeof s !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(s))
    throw new TypeError('Expected decimal integer string');
  return BigInt(s);
}
const i48 = s => bounded(integer(s), MIN48, MAX48);
const i32 = s => bounded(integer(s), MIN32, MAX32);
const fit48 = n => bounded(n, MIN48, MAX48);
const max = (a, b) => a > b ? a : b;
function tuple(t) { return { t: i48(t.ticks), m: i48(t.quantum), o: i32(t.origin) }; }
function project(t) { return { ticks: String(t.t), quantum: String(t.m), origin: String(t.o) }; }
function validity(t) { return tuple(t).m > 0n; }
function tupleEqual({ a, b }) {
  a = tuple(a); b = tuple(b);
  return a.t === b.t && a.m === b.m && a.o === b.o;
}
function tickOrder({ a, b }) {
  const x = tuple(a).t, y = tuple(b).t;
  return x < y ? -1 : x > y ? 1 : 0;
}
function arithmetic({ a, b }, subtract) {
  a = tuple(a); b = tuple(b);
  if (a.m <= 0n || b.m <= 0n) return { valid: false };
  return { valid: true, tuple: project({ t: fit48(subtract ? a.t - b.t : a.t + b.t),
    m: max(a.m, b.m), o: a.o }) };
}
const tupleAdd = input => arithmetic(input, false);
const tupleSubtract = input => arithmetic(input, true);
function tupleSequence({ initial, steps }) {
  const first = tuple(initial);
  let current = first.m > 0n ? { valid: true, tuple: project(first) } : { valid: false };
  for (const step of steps) {
    tuple(step.operand);
    if (step.operation !== 'add' && step.operation !== 'subtract') throw new RangeError('Unsupported operation');
    if (current.valid) current = arithmetic({ a: current.tuple, b: step.operand }, step.operation === 'subtract');
  }
  return current;
}
// BigInt division truncates; adjust the negative nonintegral quotient to floor.
function floor(a, b) { const q = a / b; return a % b < 0n ? q - 1n : q; }
function quantized(t, q, mode) {
  if (q <= 0n) throw new RangeError('Quantum must be positive');
  let result;
  if (mode === 'Down') result = q * floor(t, q);
  else if (mode === 'Up') result = -q * floor(-t, q);
  else if (mode === 'Round') result = q * floor(fit48(t + q / 2n), q);
  else throw new RangeError('Unsupported rounding mode');
  return fit48(result);
}
function quantize({ ticks, quantum, mode }) { return String(quantized(i48(ticks), i48(quantum), mode)); }
function resolveRoundMethod(s) { const n = i32(s); return n === 1n ? 'Down' : n === 2n ? 'Round' : 'Up'; }
function precision({ present, value }, fallback) {
  if (!present) return fallback;
  const n = integer(value);
  return n >= 1n && n <= 80000n ? String(n) : fallback;
}
const exportPrecision = input => precision(input, '0');
const eventPrecision = input => precision(input, '800');
function rowPrecision({ row, parentPresent, parent }) {
  const n = i48(row);
  return n !== 0n ? String(n) : parentPresent ? String(integer(parent)) : '800';
}
function positiveRationalSkipFirst({ total, period }) {
  const positive = s => bounded(i32(s), 1n, MAX32);
  const n = positive(total.numerator), d = positive(total.denominator);
  const a = positive(period.numerator), b = positive(period.denominator);
  return bounded(n * b, 1n, MAX32) % bounded(d * a, 1n, MAX32) > 0n;
}
function appendTime(input) {
  const { prefix, characters: c, callbackSelection } = input;
  const { t, m } = tuple(input.tuple);
  const p = i48(input.requestedPrecision), h = i32(input.H), l = i32(input.L);
  const settingMode = resolveRoundMethod(input.RoundMethod);
  if (typeof prefix !== 'string' || !c || ['minus', 'day', 'hour', 'minute', 'fraction'].some(k => typeof c[k] !== 'string' || c[k].length !== 1))
    throw new TypeError('Expected UTF16 prefix and single-code-unit characters');
  if (callbackSelection !== null && !['Down', 'Up', 'Round'].includes(callbackSelection))
    throw new RangeError('Unsupported callback selection');
  if (m <= 0n) return { valid: false, append: '', text: prefix, quantizationInvocations: 0, inputsUnchanged: true };
  let q = max(m, p), d = quantized(t, q, callbackSelection === null ? settingMode : callbackSelection);
  const raw = h !== 0n && p === 1n && (h > 1n || m === 1n);
  if (raw) { q = 1n; d = t; }
  fit48(2n * q);
  let remainder = fit48(d < 0n ? -d : d);
  let text = d < 0n ? c.minus : '';
  let larger = false;
  function field(unit, separator) {
    const n = remainder / unit;
    remainder %= unit;
    if (n > 0n || larger) {
      text += String(n).padStart(larger ? 2 : 1, '0') + separator;
      larger = true;
    }
  }
  field(6912000000n, c.day);
  field(288000000n, c.hour);
  const flatten = !larger && l > 0n && remainder < 80n * (l < 100000n ? l : 100000n);
  if (!flatten) field(4800000n, c.minute);
  text += String(remainder / 80000n).padStart(larger ? 2 : 1, '0');
  remainder %= 80000n;
  let width = null, fraction = null;
  if (2n * q <= 80000n) {
    width = 0;
    for (let b = 80000n / q; b > 1n; b /= 10n) width++;
    let f = remainder / q;
    if (raw) f = 5n * f / 4n;
    fraction = String(f);
    text += c.fraction + fraction.padStart(width, '0');
  }
  return { valid: true, append: text, text: prefix + text, quantizationInvocations: 1,
    inputsUnchanged: true, displayQuantum: String(q), displayTicks: String(d),
    rawDisplay: raw, fractionWidth: width, fractionNumber: fraction };
}
module.exports = Object.freeze({ validity, tupleEqual, tickOrder, tupleAdd, tupleSubtract,
  tupleSequence, quantize, resolveRoundMethod, exportPrecision, eventPrecision,
  rowPrecision, positiveRationalSkipFirst, appendTime });
