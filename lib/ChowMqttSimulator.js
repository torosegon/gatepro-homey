'use strict';

const { EventEmitter } = require('events');
const STATES = require('./states');

const TRAVEL_MS = 8000;

/**
 * Interface-compatible stand-in for ChowMqtt, used in demo mode (account "demo").
 * Simulates a gate travelling between closed and open without real hardware.
 */
class ChowMqttSimulator extends EventEmitter {

  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.state = STATES.CLOSED;
    this.timer = null;
  }

  connect() {
    setImmediate(() => {
      this.emit('connected');
      this._emit(this.state);
    });
  }

  end() {
    clearTimeout(this.timer);
  }

  open() { this._move(STATES.OPENING, STATES.OPEN); }
  close() { this._move(STATES.CLOSING, STATES.CLOSED); }
  pedestrianOpen() { this._move(STATES.OPENING, STATES.OPEN, TRAVEL_MS / 4); }
  pedestrianClose() { this._move(STATES.CLOSING, STATES.CLOSED, TRAVEL_MS / 4); }

  stop() {
    clearTimeout(this.timer);
    this._emit(STATES.STOPPED);
  }

  requestStatus() {
    this._emit(this.state);
  }

  _move(transitional, final, duration = TRAVEL_MS) {
    clearTimeout(this.timer);
    this._emit(transitional);
    this.timer = setTimeout(() => this._emit(final), duration);
  }

  _emit(state) {
    this.state = state;
    this.emit('state', state);
  }

}

module.exports = ChowMqttSimulator;
