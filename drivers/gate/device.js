'use strict';

const Homey = require('homey');
const ChowApi = require('../../lib/ChowApi');
const ChowMqtt = require('../../lib/ChowMqtt');
const ChowMqttSimulator = require('../../lib/ChowMqttSimulator');
const STATES = require('../../lib/states');

const DEMO = 'demo';
// Re-verify the gate position from the shadow on this cadence, as a heartbeat
// on top of the push updates.
const HEARTBEAT_MS = 60000;

class GateDevice extends Homey.Device {

  async onInit() {
    // Capability migration: bump CAP_VERSION to re-establish the set AND order.
    // Homey renders capabilities in add-order, so to reorder an existing device
    // we remove the affected ones and re-add them in the desired order (once).
    const CAP_VERSION = 5;
    // Main control is now windowcoverings (up/idle/down = open/stop/close).
    const ORDERED = ['windowcoverings_state', 'gate_state', 'cmd_open', 'cmd_close', 'cmd_stop', 'cmd_ped'];
    if (this.getStoreValue('capVersion') !== CAP_VERSION) {
      // The device keeps its paired class; switch it so garagedoor_closed is no
      // longer the protected primary and can be removed.
      if (this.getClass() !== 'windowcoverings') await this.setClass('windowcoverings').catch(this.error);
      const drop = ['garagedoor_closed', 'cmd_toggle',
        'button.toggle', 'button.open', 'button.close', 'button.stop', 'button.pedestrian'];
      for (const cap of [...drop, ...ORDERED]) {
        if (this.hasCapability(cap)) await this.removeCapability(cap).catch(this.error);
      }
      for (const cap of ORDERED) await this.addCapability(cap).catch(this.error);
      await this.setStoreValue('capVersion', CAP_VERSION);
    }

    // Main control: up = open, down = close, idle = stop.
    this.registerCapabilityListener('windowcoverings_state', (state) => {
      if (state === 'up') return this.mqtt.open();
      if (state === 'down') return this.mqtt.close();
      return this.mqtt.stop();
    });

    this.registerCapabilityListener('cmd_open', () => this.mqtt.open());
    this.registerCapabilityListener('cmd_close', () => this.mqtt.close());
    this.registerCapabilityListener('cmd_stop', () => this.mqtt.stop());
    // Pedestrian toggle: closed -> pedestrian open; otherwise -> close it back.
    this.registerCapabilityListener('cmd_ped', () => {
      return this.getCapabilityValue('gate_state') === STATES.CLOSED
        ? this.mqtt.pedestrianOpen()
        : this.mqtt.close();
    });

    await this._start();

    this.heartbeat = this.homey.setInterval(() => {
      try {
        this.mqtt.requestStatus();
      } catch (err) {
        this.log('Heartbeat skipped:', err.message);
      }
    }, HEARTBEAT_MS);
  }

  async onUninit() {
    this._stop();
  }

  async onDeleted() {
    this._stop();
  }

  open() {
    return this.mqtt.open();
  }

  close() {
    return this.mqtt.close();
  }

  stop() {
    return this.mqtt.stop();
  }

  pedestrianOpen() {
    return this.mqtt.pedestrianOpen();
  }

  /** Called by the driver's repair flow after a fresh login. */
  async updateCredentials({ username, password, token, refreshToken, userId }) {
    await this.setStoreValue('username', username);
    await this.setStoreValue('password', password);
    await this.setStoreValue('token', token);
    await this.setStoreValue('refreshToken', refreshToken);
    if (userId != null) await this.setStoreValue('userId', userId);
    await this.setStoreValue('cert', null);
    this._stop();
    await this._start();
  }

  async _start() {
    const log = (...a) => this.log(...a);

    if (this.getStoreValue('username') === DEMO) {
      this.mqtt = new ChowMqttSimulator({ log });
    } else {
      const bundle = await this._ensureCertificate();
      this.mqtt = new ChowMqtt({
        endpoint: bundle.endpoint,
        uuid: this.getData().uuid,
        cert: bundle.certificatePem,
        key: bundle.privateKey,
        srcTag: this._srcTag(),
        log,
      });
    }

    this.mqtt.on('state', (state) => this._onState(state).catch(this.error));
    this.mqtt.on('connected', () => this.setAvailable().catch(this.error));
    this.mqtt.on('disconnected', () => {
      this.setUnavailable(this.homey.__('errors.not_connected')).catch(this.error);
    });
    this.mqtt.on('reprovision', () => this._reprovision().catch(this.error));
    this.mqtt.on('error', (err) => this.error('MQTT:', err.message));

    this.mqtt.connect();
  }

  _stop() {
    this.homey.clearInterval(this.heartbeat);
    if (this.mqtt) {
      this.mqtt.removeAllListeners();
      this.mqtt.end();
      this.mqtt = null;
    }
  }

  _api() {
    const { username, password, token, refreshToken } = this.getStore();
    return new ChowApi({
      username,
      password,
      token,
      refreshToken,
      log: (...a) => this.log(...a),
      onTokens: (t) => {
        this.setStoreValue('token', t.token).catch(this.error);
        this.setStoreValue('refreshToken', t.refreshToken).catch(this.error);
      },
    });
  }

  /** Owner tag `P<accountId %07X>` required on control commands. */
  _srcTag() {
    const id = this.getStoreValue('userId');
    return id ? `P${(id >>> 0).toString(16).toUpperCase().padStart(7, '0')}` : null;
  }

  /** Return a cached AWS IoT certificate bundle, provisioning one if needed. */
  async _ensureCertificate() {
    const cached = this.getStoreValue('cert');
    if (cached && cached.certificatePem && cached.privateKey && cached.endpoint) return cached;
    return this._provision();
  }

  async _provision() {
    const { uuid } = this.getData();
    const endpoint = this.getStoreValue('iotEndpoint');
    const bundle = await this._api().provisionIot(uuid, endpoint);
    const cert = {
      certificatePem: bundle.certificatePem,
      privateKey: bundle.privateKey,
      endpoint: bundle.endpoint || endpoint,
    };
    await this.setStoreValue('cert', cert);
    return cert;
  }

  /** The shared user certificate was rotated (e.g. phone re-login); get a new one. */
  async _reprovision() {
    this.log('Re-provisioning AWS IoT certificate');
    this._stop();
    await this.setStoreValue('cert', null);
    await this._start();
  }

  async _onState(state) {
    if (state === this.getCapabilityValue('gate_state')) return;

    await this.setCapabilityValue('gate_state', state);

    // Reflect movement on the up/idle/down control.
    let wcs = 'idle';
    if (state === STATES.OPENING) wcs = 'up';
    else if (state === STATES.CLOSING) wcs = 'down';
    await this.setCapabilityValue('windowcoverings_state', wcs).catch(this.error);

    await this.driver.stateChangedTrigger.trigger(this, { state });
  }

}

module.exports = GateDevice;
