const release = require('../electron-builder.release.cjs');

module.exports = {
  ...release,
  files: [...release.files, '!electron/telemetry-endpoint.json*'],
  afterPack: null,
};
