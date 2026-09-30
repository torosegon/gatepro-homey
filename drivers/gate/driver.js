'use strict';

const Homey = require('homey');
const ChowApi = require('../../lib/ChowApi');

const DEMO = 'demo';

class GateDriver extends Homey.Driver {

  async onInit() {
    this.stateChangedTrigger = this.homey.flow.getDeviceTriggerCard('gate_state_changed');

    this.homey.flow.getActionCard('gate_command')
      .registerRunListener(({ device, command }) => {
        switch (command) {
          case 'open': return device.open();
          case 'close': return device.close();
          case 'stop': return device.stop();
          case 'pedestrian': return device.pedestrianOpen();
          default: throw new Error(`Unknown command: ${command}`);
        }
      });
  }

  async onPair(session) {
    let credentials;
    let api;

    session.setHandler('login', async ({ username, password }) => {
      credentials = { username: String(username || '').trim(), password };
      if (credentials.username === DEMO) return true;
      api = new ChowApi({ ...credentials, log: this.log.bind(this) });
      try {
        await api.login();
      } catch (err) {
        this.error('Login failed:', err.message);
        throw new Error(this.homey.__('pair.login_failed'));
      }
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (credentials.username === DEMO) {
        return [{
          name: 'GatePro (demo)',
          data: { uuid: 'demo-gate' },
          store: { ...credentials },
        }];
      }
      const user = await api.getUser();
      const devices = await api.getDevices();
      return devices.map(({ uuid, name, iotEndpoint }) => ({
        name,
        data: { uuid },
        store: {
          ...credentials,
          token: api.token || null,
          refreshToken: api.refreshToken || null,
          iotEndpoint,
          userId: user.id,
        },
      }));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async ({ username, password }) => {
      username = String(username || '').trim();
      const api = new ChowApi({ username, password, log: this.log.bind(this) });
      try {
        await api.login();
      } catch (err) {
        this.error('Repair login failed:', err.message);
        throw new Error(this.homey.__('pair.login_failed'));
      }
      const user = await api.getUser();
      await device.updateCredentials({
        username,
        password,
        token: api.token || null,
        refreshToken: api.refreshToken || null,
        userId: user.id,
      });
      return true;
    });
  }

}

module.exports = GateDriver;
