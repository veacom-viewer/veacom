const base = require('./package.json').build;
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const revision = existsSync(path.join(__dirname, '.git'))
  ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).stdout?.trim()
  : process.env.GITHUB_SHA;

module.exports = {
  ...base,
  appId: 'com.veacom.electron',
  productName: 'VEAcom Electron',
  extends: null,
  extraMetadata: { veacomBuildCommit: /^[0-9a-f]{40}$/.test(revision || '') ? revision : 'unknown' },
  directories: { ...base.directories, output: 'release-electron' },
  publish: null,
  afterPack: './packaging/verify-telemetry.cjs',
  forceCodeSigning: true,
  win: {
    ...base.win,
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'VEAcom-Electron-${version}-win-${arch}-Installer.${ext}',
  },
  nsis: {
    ...base.nsis,
    artifactName: 'VEAcom-Electron-${version}-win-${arch}-Installer.${ext}',
    oneClick: false,
    perMachine: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    buildUniversalInstaller: false,
  },
  mac: {
    ...base.mac,
    artifactName: 'VEAcom-Electron-${version}-mac-${arch}.${ext}',
  },
  dmg: { ...base.dmg, sign: true },
};
