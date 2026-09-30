'use strict';

const STATES = require('./states');

// Position thresholds (0..100). The app treats <=5 / >=95 as the limits.
const OPEN_AT = 95;
const CLOSED_AT = 5;

/**
 * Extract the gate position (0..100) from the WBT `DEV STATUS` field
 * (9 comma-separated hex bytes, e.g. "60,64,AA,3E,00,00,3E,00,00").
 * byte[3] & 0x7F = leaf-0 position, byte[6] & 0x7F = leaf-1 (dual-leaf gate).
 */
function parsePosition(devStatus) {
  const b = String(devStatus || '').split(',').map((x) => parseInt(x, 16));
  if (b.length < 8 || Number.isNaN(b[3])) return null;
  const p0 = b[3] & 0x7F;
  const p1 = Number.isNaN(b[6]) ? p0 : (b[6] & 0x7F);
  return Math.max(p0, p1);
}

/**
 * Decode the WBT `DEV STATUS` field the way the vendor app does:
 * byte[2] & 0x40 = operating (moving), byte[3] & 0x7F = position,
 * byte[3] & 0x80 = open direction. Note the shadow position can be stale while
 * the gate travels — the live percentage arrives on the `<uuid>/position` topic.
 */
function decodeDevStatus(devStatus) {
  const b = String(devStatus || '').split(';')[0].split(',').map((x) => parseInt(x, 16));
  if (b.length < 4 || Number.isNaN(b[3])) return null;
  return {
    position: b[3] & 0x7F,
    isOperating: Number.isNaN(b[2]) ? null : Boolean(b[2] & 0x40),
    isOpenDirection: Boolean(b[3] & 0x80),
  };
}

module.exports = { parsePosition, decodeDevStatus, OPEN_AT, CLOSED_AT };
