'use strict';

/**
 * Runs the EXACT Homey app code path (lib/ChowApi provisioning + lib/ChowMqtt
 * over mqtt.js) outside Homey, with verbose logging, to reproduce an "offline"
 * device. Usage:
 *   CHOW_USER='<account name>' CHOW_PASS='<password>' node scripts/test-homey-path.js
 */

const ChowApi = require('../lib/ChowApi');
const ChowMqtt = require('../lib/ChowMqtt');

async function main() {
  const username = process.env.CHOW_USER;
  const password = process.env.CHOW_PASS;
  if (!username || !password) throw new Error('Set CHOW_USER and CHOW_PASS');

  const api = new ChowApi({ username, password, log: (...a) => console.error('[api]', ...a) });
  await api.login();
  const user = await api.getUser();
  const devices = await api.getDevices();
  const dev = devices[0];
  console.error('Device:', dev.uuid, '@', dev.iotEndpoint);

  const bundle = await api.provisionIot(dev.uuid, dev.iotEndpoint);
  console.error('Provisioned. endpoint =', bundle.endpoint,
    '| cert len', (bundle.certificatePem || '').length, '| key len', (bundle.privateKey || '').length);

  const srcTag = `P${(user.id >>> 0).toString(16).toUpperCase().padStart(7, '0')}`;
  const mqtt = new ChowMqtt({
    endpoint: bundle.endpoint,
    uuid: dev.uuid,
    cert: bundle.certificatePem,
    key: bundle.privateKey,
    srcTag,
    log: (...a) => console.error('[mqtt]', ...a),
  });

  mqtt.on('connected', () => console.error('>>> CONNECTED'));
  mqtt.on('disconnected', () => console.error('>>> DISCONNECTED'));
  mqtt.on('reprovision', () => console.error('>>> REPROVISION requested'));
  mqtt.on('state', (s) => console.error('>>> STATE', s));
  mqtt.on('ack', (a) => console.error('>>> ACK', a));
  mqtt.on('error', (e) => console.error('>>> ERROR', e.message));

  mqtt.connect();
  // Optional: CHOW_CMD=status|open|close|stop|ped runs a real command once connected.
  const cmd = (process.env.CHOW_CMD || 'status').toLowerCase();
  const run = {
    status: () => mqtt.requestStatus(),
    open: () => mqtt.open(),
    close: () => mqtt.close(),
    stop: () => mqtt.stop(),
    ped: () => mqtt.pedestrianOpen(),
  }[cmd] || (() => mqtt.requestStatus());
  mqtt.once('connected', () => setTimeout(() => {
    console.error(`>> running command: ${cmd}`);
    try { run(); } catch (e) { console.error('command error:', e.message); }
  }, 1000));
  console.error('Connecting... (Ctrl+C to stop)');
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
