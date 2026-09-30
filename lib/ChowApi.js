'use strict';


/**
 * Client for the TMT Chow! cloud (Android app id: tw.timotion), derived from
 * captured app traffic (app build TMT/86).
 *
 * Two HTTP backends share the same JWT:
 *  - AUTH_URL issues access/refresh tokens (password / refresh_token grants).
 *  - API_URL is the device API (account, device list, AWS IoT provisioning).
 *
 * Gate commands and live state do NOT travel over HTTP: they go over AWS IoT
 * MQTT. This class only handles auth, device discovery and IoT certificate
 * provisioning; the MQTT control lives in ChowMqtt (see PROTOCOL.md).
 */
const AUTH_URL = 'https://chowmeet.kaitron.com/__api__';
const API_URL = 'https://installer.tmt-automation.com/v4.0';

// Identifies the Chow! app on the shared backend, present in every auth call.
const APP_TYPE_INDEX = 1;

const REQUEST_TIMEOUT_MS = 15000;
// Tokens live 24h; renew this long before the `exp` claim.
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60000;

const ERROR_CODES = Object.freeze({
  '-1001': 'Invalid username or password',
});

class ChowApiError extends Error {

  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }

}

class ChowApi {

  /**
   * @param {object} options
   * @param {string} options.username Chow! account name (not the e-mail).
   * @param {string} options.password
   */
  constructor({ username, password, token = null, refreshToken = null, onTokens = () => {}, log = () => {} }) {
    this.username = username;
    this.password = password;
    this.token = token;
    this.refreshToken = refreshToken;
    this.onTokens = onTokens;
    this.log = log;
  }

  async login() {
    const body = await this._fetch('POST', `${AUTH_URL}/tmt/token`, {
      grant_type: 'password',
      scope: 'user',
      app_type_index: APP_TYPE_INDEX,
      username: this.username,
      password: this.password,
    }, { auth: false });
    this._setTokens(body);
  }

  async renew() {
    const body = await this._fetch('POST', `${AUTH_URL}/tmt/token`, {
      grant_type: 'refresh_token',
      app_type_index: APP_TYPE_INDEX,
      username: this.username,
      refresh_token: this.refreshToken,
    }, { auth: false });
    this._setTokens(body);
  }

  getUser() {
    return this._request('GET', `${API_URL}/user/`);
  }

  /**
   * Gates the account can access.
   * @returns {Promise<Array<{uuid,name,model,iotEndpoint,role}>>}
   */
  async getDevices() {
    const body = await this._request('GET', `${API_URL}/user/devices/`);
    const names = new Map((body.custom_info || []).map((c) => [c.uuid, c.display_name]));
    const pick = (d, role) => ({
      uuid: d.uuid,
      name: names.get(d.uuid) || d.devies_type || d.uuid,
      model: d.devies_type || null,
      iotEndpoint: d.iot_endpoint || null,
      role,
    });
    return [
      ...(body.admin_devices || []).map((d) => pick(d, 'admin')),
      ...(body.user_devices || []).map((d) => pick(d, 'user')),
      ...(body.share_devices || []).map((d) => pick(d, 'shared')),
    ];
  }

  /**
   * Provision (or re-provision) an AWS IoT client certificate for this account
   * and attach it to the device, so an MQTT client can connect to the gate.
   * @returns {Promise<{certificateArn,certificatePem,privateKey,endpoint,thingName}>}
   */
  async provisionIot(uuid, endpoint) {
    const cert = await this._request('PUT', `${API_URL}/devices/iot/user/certificate/`, { app: APP_TYPE_INDEX });
    const policy = await this._request('PUT', `${API_URL}/devices/iot/device/policy/`, {
      user_certificateArn: cert.user_certificateArn,
      uuid,
      endpoint: `://${endpoint}`,
    });
    return {
      certificateArn: cert.user_certificateArn,
      certificatePem: cert.certificatePem,
      privateKey: cert.PrivateKey,
      endpoint,
      thingName: policy.thing_name || uuid,
    };
  }

  _setTokens(body) {
    this.token = body.access_token;
    this.refreshToken = body.refresh_token || this.refreshToken;
    if (!this.token) throw new ChowApiError('Auth response contained no access_token');
    this.onTokens({ token: this.token, refreshToken: this.refreshToken });
  }

  _tokenValid() {
    if (!this.token) return false;
    const exp = decodeJwtExp(this.token);
    return exp === null || Date.now() < exp - TOKEN_EXPIRY_MARGIN_MS;
  }

  async _ensureToken() {
    if (this._tokenValid()) return;
    if (this.refreshToken) {
      try {
        await this.renew();
        return;
      } catch (err) {
        this.log('Token renew failed, logging in again:', err.message);
      }
    }
    await this.login();
  }

  async _request(method, url, data) {
    await this._ensureToken();
    try {
      return await this._fetch(method, url, data);
    } catch (err) {
      if (err.status !== 401) throw err;
      // Token revoked server-side (e.g. re-login on the phone); retry once.
      await this.login();
      return this._fetch(method, url, data);
    }
  }

  async _fetch(method, url, data, { auth = true } = {}) {
    const headers = { Accept: '*/*', 'User-Agent': 'Homey-GatePro' };
    if (auth) headers.Authorization = `Bearer ${this.token}`;
    if (data !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      method,
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await res.text();
    const body = text ? safeJson(text) : {};

    if (!res.ok || (body && body.error_code)) {
      const code = body && body.error_code;
      const message = ERROR_CODES[code] || `HTTP ${res.status}${code ? ` (${code})` : ''}`;
      throw new ChowApiError(message, res.status, code);
    }
    return body;
  }

}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

ChowApi.ChowApiError = ChowApiError;

module.exports = ChowApi;
