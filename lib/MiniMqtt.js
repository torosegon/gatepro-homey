'use strict';

const tls = require('tls');
const { EventEmitter } = require('events');

/**
 * Minimal MQTT 3.1.1 client over TLS — just enough for this app (QoS 0
 * connect / subscribe / publish / keepalive), with zero npm dependencies, to
 * keep the Homey app's memory footprint small.
 *
 * Events: 'connect', 'message'(topic, payloadBuffer), 'error'(err), 'close'.
 */
class MiniMqtt extends EventEmitter {

  constructor({ host, port = 8883, key, cert, ca, clientId, keepalive = 30, rejectUnauthorized = true, log = () => {} }) {
    super();
    this.opts = { host, port, key, cert, ca, clientId, keepalive, rejectUnauthorized };
    this.log = log;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.packetId = 0;
    this.pingTimer = null;
    this.ended = false;
  }

  get connected() {
    return this.socket != null && !this.socket.destroyed && this._mqttConnected === true;
  }

  connect() {
    this.ended = false;
    const { host, port, key, cert, ca, rejectUnauthorized } = this.opts;
    this.socket = tls.connect({ host, port, key, cert, ca, servername: host, rejectUnauthorized }, () => {
      this._write(this._encodeConnect());
    });
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => this._onClose());
  }

  subscribe(topics) {
    const list = Array.isArray(topics) ? topics : [topics];
    this._write(this._encodeSubscribe(list));
  }

  publish(topic, message) {
    this._write(this._encodePublish(topic, Buffer.from(message)));
  }

  end() {
    this.ended = true;
    clearInterval(this.pingTimer);
    if (this.socket) {
      try { this._write(Buffer.from([0xE0, 0x00])); } catch { /* ignore */ }
      this.socket.destroy();
      this.socket = null;
    }
  }

  _write(buf) {
    if (!this.socket || this.socket.destroyed) throw new Error('socket closed');
    this.socket.write(buf);
  }

  // --- encoding ---------------------------------------------------------------

  _encodeConnect() {
    const id = Buffer.from(this.opts.clientId, 'utf8');
    const vh = Buffer.concat([
      this._str('MQTT'),
      Buffer.from([0x04, 0x02]), // protocol level 4, flags = clean session
      this._u16(this.opts.keepalive),
    ]);
    const payload = this._str(id);
    return this._packet(0x10, Buffer.concat([vh, payload]));
  }

  _encodeSubscribe(topics) {
    const id = this._nextId();
    const items = topics.map((t) => Buffer.concat([this._str(t), Buffer.from([0x00])]));
    return this._packet(0x82, Buffer.concat([this._u16(id), ...items]));
  }

  _encodePublish(topic, payload) {
    return this._packet(0x30, Buffer.concat([this._str(topic), payload]));
  }

  _packet(firstByte, rest) {
    return Buffer.concat([Buffer.from([firstByte]), this._varint(rest.length), rest]);
  }

  _str(s) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    return Buffer.concat([this._u16(b.length), b]);
  }

  _u16(n) {
    return Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  }

  _varint(n) {
    const bytes = [];
    do {
      let b = n & 0x7f;
      n >>= 7;
      if (n > 0) b |= 0x80;
      bytes.push(b);
    } while (n > 0);
    return Buffer.from(bytes);
  }

  _nextId() {
    this.packetId = (this.packetId % 65535) + 1;
    return this.packetId;
  }

  // --- decoding ---------------------------------------------------------------

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const { value: remLen, bytes: lenBytes } = this._readVarint(this.buffer, 1);
      if (remLen == null) return; // incomplete length
      const total = 1 + lenBytes + remLen;
      if (this.buffer.length < total) return; // wait for the rest
      const type = this.buffer[0] >> 4;
      const body = this.buffer.subarray(1 + lenBytes, total);
      this.buffer = this.buffer.subarray(total);
      this._dispatch(type, body);
    }
  }

  _dispatch(type, body) {
    switch (type) {
      case 2: // CONNACK
        if (body.length >= 2 && body[1] === 0) {
          this._mqttConnected = true;
          this._startPing();
          this.emit('connect');
        } else {
          this.emit('error', new Error(`CONNACK refused (code ${body[1]})`));
        }
        break;
      case 3: { // PUBLISH (QoS 0 only)
        const topicLen = body.readUInt16BE(0);
        const topic = body.toString('utf8', 2, 2 + topicLen);
        const payload = body.subarray(2 + topicLen);
        this.emit('message', topic, payload);
        break;
      }
      // 9 SUBACK, 13 PINGRESP: nothing to do
      default:
        break;
    }
  }

  _readVarint(buf, offset) {
    let multiplier = 1;
    let value = 0;
    let bytes = 0;
    for (;;) {
      if (offset + bytes >= buf.length) return { value: null, bytes: 0 };
      const b = buf[offset + bytes];
      value += (b & 0x7f) * multiplier;
      bytes += 1;
      if ((b & 0x80) === 0) break;
      multiplier *= 128;
      if (bytes > 4) return { value: null, bytes: 0 };
    }
    return { value, bytes };
  }

  _startPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try { this._write(Buffer.from([0xC0, 0x00])); } catch { /* ignore */ }
    }, this.opts.keepalive * 1000);
  }

  _onClose() {
    clearInterval(this.pingTimer);
    this._mqttConnected = false;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.emit('close');
  }

}

module.exports = MiniMqtt;
