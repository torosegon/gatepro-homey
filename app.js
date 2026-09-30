'use strict';

const Homey = require('homey');

class GateProApp extends Homey.App {

  async onInit() {
    this.log('GatePro app initialized');
  }

}

module.exports = GateProApp;
