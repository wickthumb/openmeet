// Text helpers shared by the meet-folder reader and the LIF writer:
// windows-1252 decode/encode, line splitting, and the comma-delimited field
// rules (double-quoted fields, "" as an escaped quote).

const decoder1252 = new TextDecoder('windows-1252');
const decoderUtf8 = new TextDecoder('utf-8');

/**
 * Decode a meet-folder file to a string.
 * - Bytes are windows-1252 (the meet managers' single-byte code set).
 * - A UTF-8 BOM (EF BB BF) is stripped. A BOM declares UTF-8, so the rest of
 *   such a file is decoded as UTF-8; otherwise "é" would become "Ã©".
 * - A string input only has a leading U+FEFF removed.
 * @param {Uint8Array | string} input
 * @returns {string}
 */
export function decodeMeetText(input) {
  if (typeof input === 'string') {
    return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  }
  if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    return decoderUtf8.decode(input.subarray(3));
  }
  const text = decoder1252.decode(input);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split text into lines, accepting CRLF, LF or bare CR.
 * @param {string} text
 * @returns {string[]}
 */
export function splitLines(text) {
  return text.split(/\r\n|\n|\r/);
}

/**
 * True for lines the parsers skip: blank (whitespace only) or `;` comments.
 * @param {string} line
 */
export function isSkippable(line) {
  const t = line.trim();
  return t === '' || t[0] === ';';
}

/**
 * Split one comma-delimited line into fields.
 * - Unquoted fields are trimmed.
 * - A field whose first non-space character is `"` is quoted: it runs to the
 *   next lone `"`, `""` inside it is one `"`, and commas inside it are data.
 *   Text between the closing quote and the next comma is appended (lenient).
 * - An unterminated quoted field takes the rest of the line.
 * @param {string} line
 * @returns {string[]}
 */
export function parseFields(line) {
  /** @type {string[]} */
  const fields = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i < n && line[i] === '"') {
      i++;
      let value = '';
      for (;;) {
        const q = line.indexOf('"', i);
        if (q === -1) {
          value += line.slice(i);
          i = n;
          break;
        }
        value += line.slice(i, q);
        if (line[q + 1] === '"') {
          value += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      const comma = line.indexOf(',', i);
      const tail = comma === -1 ? line.slice(i) : line.slice(i, comma);
      fields.push(value + tail.trim());
      if (comma === -1) return fields;
      i = comma + 1;
    } else {
      const comma = line.indexOf(',', i);
      if (comma === -1) {
        fields.push(line.slice(i).trim());
        return fields;
      }
      fields.push(line.slice(i, comma).trim());
      i = comma + 1;
    }
  }
}

/**
 * Format one output field: quoted if it contains a comma or a quote.
 * CR/LF would break the line structure, so they become spaces.
 * @param {unknown} value
 * @returns {string}
 */
export function formatField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value).replace(/[\r\n]+/g, ' ');
  if (s.includes(',') || s.includes('"')) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/** Unicode code point -> windows-1252 byte for the 0x80-0x9F block. */
const CP1252_HIGH = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

/** Bytes 0x81, 0x8D, 0x8F, 0x90, 0x9D are unassigned; WHATWG decodes them to the same C1 code point. */
const CP1252_PASSTHROUGH = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

const QUESTION = 0x3f;

/**
 * Encode a string as windows-1252. Text is NFC-normalised first so a
 * decomposed "é" still maps to one byte. Anything unrepresentable becomes `?`
 * (one `?` per code point).
 * @param {string} text
 * @returns {Buffer}
 */
export function encodeWindows1252(text) {
  const s = text.normalize('NFC');
  const out = Buffer.allocUnsafe(s.length);
  let n = 0;
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp < 0x80 || (cp >= 0xa0 && cp <= 0xff) || CP1252_PASSTHROUGH.has(cp)) {
      out[n++] = cp;
    } else {
      out[n++] = CP1252_HIGH.get(cp) ?? QUESTION;
    }
  }
  return out.subarray(0, n);
}
