'use strict';

/**
 * Gate states reported to Homey. Matches the `gate_state` capability values.
 */
module.exports = Object.freeze({
  CLOSED: 'closed',
  OPENING: 'opening',
  OPEN: 'open',
  CLOSING: 'closing',
  STOPPED: 'stopped',
  UNKNOWN: 'unknown',
});
