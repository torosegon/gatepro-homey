'use strict';

const { EventEmitter } = require('events');
const MiniMqtt = require('./MiniMqtt');
const STATES = require('./states');
const AMAZON_ROOT_CA = require('./amazonRootCA');
const { decodeDevStatus, OPEN_AT, CLOSED_AT } = require('./devStatus');

const PORT = 8883;
const KEEPALIVE_S = 30;
const RECONNECT_MS = 5000;
// Gap between chained commands (e.g. OPEN pulse then CLOSE).
const SEQUENCE_GAP_MS = 1200;
// If the gate is moving but no live /position update arrives for this long,
// assume it has stopped (e.g. halted mid-travel by a physical remote).
const SETTLE_MS = 5000;
// After this many consecutive failed (re)connects, assume the AWS IoT cert was
// rotated (the phone app re-provisions and revokes the previous user cert) and
// ask the owner to provision a fresh one.
const REPROVISION_AFTER_FAILURES = 3;

// UARTCommand values sent as `c=<CMD>` on <uuid>/wbt01Rx.
const CMD = Object.freeze({
  OPEN: 'FULL OPEN',
  CLOSE: 'FULL CLOSE',
  STOP: 'STOP',
  PED_OPEN: 'PED OPEN',
  READ_STATUS: 'RS',
});

/**
 * Persistent AWS IoT MQTT connection to one GatePro (WBT) gate.
 *
 * Emits:
 *  - 'state'        (gateState: string)
 *  - 'position'     (0..100)
 *  - 'ack'          (text)          raw wbt01Tx reply
 *  - 'connected' / 'disconnected'
 *  - 'reprovision'                  cert likely revoked; caller should re-provision
 *  - 'error'        (err)
 */
class ChowMqtt extends EventEmitter {

  /**
   * @param {object} o
   * @param {string} o.endpoint  AWS IoT ATS endpoint host
   * @param {string} o.uuid      device uuid (== AWS thing name)
   * @param {string} o.cert      client certificate PEM
   * @param {string} o.key       client private key PEM
   */
  /**
   * @param {string} o.srcTag  owner tag `P<accountId in %07X>`; control commands
   *   are rejected (NAK) without it. Reads (RS) are accepted bare.
   */
  constructor({ endpoint, uuid, cert, key, srcTag, log = () => {} }) {
    super();
    this.endpoint = endpoint;
    this.uuid = uuid;
    this.cert = cert;
    this.key = key;
    this.srcTag = srcTag;
    this.log = log;
    this.client = null;
    this.position = null; // 0..100 (0 = closed, 100 = open)
    this.movement = null; // 'opening' | 'closing' | null
    this.isOperating = null; // whether the gate reports it is moving
    this.lastState = null;
    this.settleTimer = null;
    this.failures = 0;

    this.shadowBase = `$aws/things/${uuid}/shadow`;
    this.rxTopic = `${uuid}/wbt01Rx`;
    this.txTopic = `${uuid}/wbt01Tx`;
    // Live travel percentage — the shadow position is stale during movement.
    this.positionTopic = `${uuid}/position`;
  }

  connect() {
    // Unique clientId: reusing the uuid would kick the real gate module offline.
    // Unique clientId: reusing the uuid would kick the real gate module offline.
    const clientId = `homey-gatepro-${this.uuid.slice(0, 8)}-${Date.now().toString(36)}`;
    this.ended = false;
    this.client = new MiniMqtt({
      host: this.endpoint,
      port: PORT,
      key: this.key,
      cert: this.cert,
      ca: AMAZON_ROOT_CA,
      clientId,
      keepalive: KEEPALIVE_S,
      log: this.log,
    });

    this.client.on('connect', () => {
      this.failures = 0;
      this.log('MQTT connected');
      this.client.subscribe([`${this.shadowBase}/get/accepted`, `${this.shadowBase}/update/accepted`, this.txTopic, this.positionTopic]);
      this.requestStatus();
      this.emit('connected');
    });

    this.client.on('message', (topic, payload) => this._onMessage(topic, payload.toString()));
    this.client.on('error', (err) => this.log('MQTT error:', err.message));
    this.client.on('close', () => this._onClose());

    this.client.connect();
  }

  end() {
    this.ended = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.settleTimer);
    if (this.client) {
      this.client.end();
      this.client = null;
    }
  }

  // --- commands ---------------------------------------------------------------

  open() { return this._command([CMD.OPEN], 'opening'); }

  /**
   * This controller ignores a bare FULL CLOSE from a resting fully-open state:
   * it needs an OPEN pulse first (relay clicks, no movement), then FULL CLOSE —
   * like the phone app. But that OPEN pulse would fully open the gate from any
   * partial position, so only prepend it when we know the gate is fully open.
   */
  close() {
    const pos = this.position;
    let steps;
    if (pos != null && pos >= OPEN_AT) {
      steps = [CMD.OPEN, CMD.CLOSE]; // fully open: OPEN pulse wakes it, no movement
    } else if (pos != null && pos > CLOSED_AT) {
      steps = [CMD.PED_OPEN, CMD.CLOSE]; // partly open (e.g. pedestrian): PED pulse wakes it
    } else {
      steps = [CMD.CLOSE];
    }
    return this._command(steps, 'closing');
  }

  stop() { return this._command([CMD.STOP], 'stop'); }
  pedestrianOpen() { return this._command([CMD.PED_OPEN], 'opening'); }

  requestStatus() {
    this._safePublish(`${this.shadowBase}/get`, '{}');
  }

  _command(steps, intent) {
    // Send each step with a gap so the controller processes them in order.
    steps.forEach((cmd, i) => {
      // Control commands must carry the owner tag or the device replies NAK.
      const payload = this.srcTag ? `c=${cmd};src=${this.srcTag}` : `c=${cmd}`;
      if (i === 0) this._publish(this.rxTopic, payload); // first step throws if offline
      else setTimeout(() => this._safePublish(this.rxTopic, payload), i * SEQUENCE_GAP_MS);
    });
    // Optimistic movement for a snappy UI; live /position confirms/corrects it.
    if (intent === 'opening' || intent === 'closing') {
      this.isOperating = true;
      this.movement = intent;
    } else if (intent === 'stop') {
      this.isOperating = false;
      this.movement = null;
    }
    this._recomputeState();
    this._armSettle();
  }

  _publish(topic, message) {
    if (!this.client || !this.client.connected) throw new Error('MQTT not connected');
    this.log('->', topic, message);
    this.client.publish(topic, message);
  }

  // Publish from a timer: never throw (the connection may have gone away).
  _safePublish(topic, message) {
    try {
      this._publish(topic, message);
    } catch (err) {
      this.log('publish skipped:', err.message);
    }
  }

  // --- inbound ----------------------------------------------------------------

  _onMessage(topic, message) {
    if (topic === this.txTopic) {
      this.log('<- tx', message);
      this.emit('ack', message);
      return;
    }
    if (topic === this.positionTopic) {
      // Live travel percentage, e.g. "42" or "42%".
      const pct = parseInt(String(message).replace('%', '').trim(), 10);
      if (!Number.isNaN(pct)) this._applyPosition(Math.max(0, Math.min(100, pct)), true);
      return;
    }
    if (topic.startsWith(this.shadowBase)) {
      try {
        const doc = JSON.parse(message);
        const reported = doc.state && doc.state.reported;
        if (reported && reported['DEV STATUS']) this._applyDevStatus(reported['DEV STATUS']);
      } catch (err) {
        this.log('shadow parse error:', err.message);
      }
    }
  }

  // Shadow position is a fallback (stale during travel), so it does not drive
  // the movement direction — the live /position topic does.
  _applyDevStatus(devStatus) {
    const parsed = decodeDevStatus(devStatus);
    if (!parsed || parsed.position == null) return;
    this._applyPosition(parsed.position, false);
  }

  /**
   * Fold a position reading into the state. `deriveMovement` is true only for
   * the live /position stream, whose deltas are monotonic during travel.
   */
  _applyPosition(pct, deriveMovement) {
    const previous = this.position;
    const position = pct <= CLOSED_AT ? 0 : pct >= OPEN_AT ? 100 : pct;
    this.position = position;
    this.emit('position', position);

    if (deriveMovement && this.isOperating !== false && previous != null) {
      if (position > previous) this.movement = 'opening';
      else if (position < previous) this.movement = 'closing';
    }

    // At a limit (unless still travelling the other way) the gate has settled.
    const reachedClosed = position === 0 && this.movement !== 'opening';
    const reachedOpen = position === 100 && this.movement !== 'closing';
    if (reachedClosed || reachedOpen) {
      this.isOperating = false;
      this.movement = null;
    }

    this._recomputeState();
    this._armSettle();
  }

  _recomputeState() {
    let state;
    if (this.movement === 'opening') state = STATES.OPENING;
    else if (this.movement === 'closing') state = STATES.CLOSING;
    else if (this.position == null) state = STATES.UNKNOWN;
    else if (this.position === 0) state = STATES.CLOSED;
    else if (this.position === 100) state = STATES.OPEN;
    else state = STATES.STOPPED;
    this._emitState(state);
  }

  // Safety net: if the gate is moving but no position update arrives for
  // SETTLE_MS (e.g. stopped mid-travel by a remote), assume it has stopped.
  _armSettle() {
    clearTimeout(this.settleTimer);
    if (this.movement == null) return;
    this.settleTimer = setTimeout(() => {
      this.isOperating = false;
      this.movement = null;
      this._recomputeState();
    }, SETTLE_MS);
  }

  _emitState(state) {
    if (state === this.lastState) return;
    this.lastState = state;
    this.emit('state', state);
  }

  _onClose() {
    this.emit('disconnected');
    if (this.ended) return;

    this.failures += 1;
    if (this.failures === REPROVISION_AFTER_FAILURES) {
      this.log('Repeated MQTT failures — certificate likely revoked');
      this.emit('reprovision');
      return; // the device will re-provision and reconnect
    }
    // Reconnect the existing client after a delay.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (!this.ended && this.client) this.client.connect();
    }, RECONNECT_MS);
  }

}

ChowMqtt.CMD = CMD;

module.exports = ChowMqtt;
