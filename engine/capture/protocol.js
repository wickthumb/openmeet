// Camera stream protocol. Simulated and (later) real camera drivers emit the
// same plain-object messages, so nothing above the driver knows the source.
//
//   {type: 'hello', model, rows, channels, columnPeriod}
//   {type: 'start_pulse', hwTime}
//   {type: 'columns', firstHwTime, period, count, data}
//   {type: 'end'}
//
// Times are camera hardware time in seconds. Column i of a `columns` chunk
// has hardware time firstHwTime + i * period. `data` is count * rows *
// channels bytes, column-major: one column's rows are contiguous (top row
// first), and each pixel's channels are contiguous.

/**
 * @typedef {object} HelloMsg
 * @property {'hello'} type
 * @property {string} model
 * @property {number} rows          Pixels per column.
 * @property {number} channels      Bytes per pixel (1 = mono, 3 = RGB, 4 = RGBA).
 * @property {number} columnPeriod  Nominal seconds per column (informational; per-column times are authoritative).
 */
/** @typedef {{type: 'start_pulse', hwTime: number}} StartPulseMsg */
/**
 * @typedef {object} ColumnsMsg
 * @property {'columns'} type
 * @property {number} firstHwTime
 * @property {number} period
 * @property {number} count
 * @property {Uint8Array} data   Buffer or Uint8Array (structured clone turns Buffers into Uint8Array).
 */
/** @typedef {{type: 'end'}} EndMsg */
/** @typedef {HelloMsg | StartPulseMsg | ColumnsMsg | EndMsg} CameraMsg */

export const MSG_TYPES = Object.freeze(['hello', 'start_pulse', 'columns', 'end']);

/** @param {unknown} v */
const isPosInt = (v) => Number.isInteger(v) && /** @type {number} */ (v) > 0;
/** @param {unknown} v */
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Bytes per column for a stream.
 * @param {{rows: number, channels: number}} hello
 */
export function columnBytes(hello) {
  return hello.rows * hello.channels;
}

/**
 * Validate a message; throws TypeError with the reason. With `hello`, a
 * columns message's byte length is checked against the stream geometry.
 * @param {any} msg
 * @param {{rows: number, channels: number} | null} [hello]
 * @returns {CameraMsg}
 */
export function validateMessage(msg, hello = null) {
  if (!msg || typeof msg !== 'object') throw new TypeError('camera message must be an object');
  switch (msg.type) {
    case 'hello':
      if (typeof msg.model !== 'string') throw new TypeError('hello.model must be a string');
      if (!isPosInt(msg.rows)) throw new TypeError('hello.rows must be a positive integer');
      if (!isPosInt(msg.channels) || msg.channels > 4) throw new TypeError('hello.channels must be 1-4');
      if (!isFiniteNum(msg.columnPeriod) || msg.columnPeriod <= 0) throw new TypeError('hello.columnPeriod must be > 0');
      return msg;
    case 'start_pulse':
      if (!isFiniteNum(msg.hwTime)) throw new TypeError('start_pulse.hwTime must be a finite number');
      return msg;
    case 'columns': {
      if (!isFiniteNum(msg.firstHwTime)) throw new TypeError('columns.firstHwTime must be a finite number');
      if (!isFiniteNum(msg.period) || msg.period <= 0) throw new TypeError('columns.period must be > 0');
      if (!isPosInt(msg.count)) throw new TypeError('columns.count must be a positive integer');
      if (!(msg.data instanceof Uint8Array)) throw new TypeError('columns.data must be a Buffer or Uint8Array');
      if (hello && msg.data.length !== msg.count * columnBytes(hello)) {
        throw new TypeError(`columns.data is ${msg.data.length} bytes; expected count*rows*channels = ${msg.count * columnBytes(hello)}`);
      }
      return msg;
    }
    case 'end':
      return msg;
    default:
      throw new TypeError(`unknown camera message type ${JSON.stringify(msg.type)}`);
  }
}

/**
 * Hardware time of column `i` within a columns chunk.
 * @param {ColumnsMsg} msg
 * @param {number} i
 */
export function chunkColumnTime(msg, i) {
  return msg.firstHwTime + i * msg.period;
}
