const path = require('node:path');
const { extractFile } = require('@electron/asar');

module.exports = ({ appOutDir, packager }) => {
  const archive = path.join(packager.getResourcesDir(appOutDir), 'app.asar');
  let config;
  try {
    config = JSON.parse(extractFile(archive, 'electron/telemetry-endpoint.json').toString());
  } catch {
    throw new Error('Release package has no readable telemetry config. Run telemetry/write-endpoint.sh before packaging.');
  }
  if (config?.endpoint !== 'https://otel-collector-5phqzw3wxq-nw.a.run.app' ||
      typeof config.token !== 'string' || config.token.length < 16 || /\s/.test(config.token)) {
    throw new Error('Release package has an invalid telemetry config. Run telemetry/write-endpoint.sh before packaging.');
  }
};
