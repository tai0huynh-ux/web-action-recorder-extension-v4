const path = require('node:path');

const channel = process.env.WAR_RELEASE_CHANNEL || 'development';
const signed = Boolean(process.env.WAR_WINDOWS_SIGN_CERT_PATH || process.env.CSC_LINK || process.env.WIN_CSC_LINK);
if (process.env.WAR_WINDOWS_SIGN_CERT_PATH && !process.env.CSC_LINK) {
  process.env.CSC_LINK = process.env.WAR_WINDOWS_SIGN_CERT_PATH;
}
if (process.env.WAR_WINDOWS_SIGN_CERT_PASSWORD && !process.env.CSC_KEY_PASSWORD) {
  process.env.CSC_KEY_PASSWORD = process.env.WAR_WINDOWS_SIGN_CERT_PASSWORD;
}

module.exports = {
  appId: 'com.webactionrecorder.controller',
  productName: 'WAR Controller',
  copyright: 'Copyright (c) Web Action Recorder',
  directories: {
    output: path.resolve('dist/release/controller-electron'),
  },
  asar: true,
  compression: 'normal',
  npmRebuild: false,
  buildDependenciesFromSource: false,
  electronVersion: '43.1.1',
  artifactName: `WAR-Controller-${channel}-${'${version}'}-windows-x64.${'${ext}'}`,
  files: [
    'package.json',
    'companion/store.js',
    'platform/controller-electron/src/**/*',
    'platform/controller-electron/renderer/**/*',
    'build/icon.svg',
    'platform/controller-electron/release/packagedSmoke.js',
    'platform/controller-core/src/**/*',
    'platform/controller-wss/src/**/*',
    'platform/diagnostics/src/**/*',
    'platform/container/security/**/*',
    'platform/input-parser/src/**/*',
    'platform/protocol/src/**/*',
    'platform/workflow-core/src/**/*',
    'src/graph.js',
    'src/shared.js',
    '!**/*.test.js',
    '!**/test/**',
    '!**/integration/**',
    '!**/*.map',
  ],
  extraMetadata: {
    main: 'platform/controller-electron/src/main.js',
    name: 'war-controller',
    productName: 'WAR Controller',
    dependencies: {
      ws: '8.21.1',
    },
  },
  win: {
    target: ['nsis', 'portable'],
    signExecutable: signed,
    signtoolOptions: {
      publisherName: process.env.WAR_WINDOWS_SIGN_PUBLISHER || 'Web Action Recorder',
    },
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    artifactName: `WAR-Controller-Setup-${channel}-${'${version}'}-windows-x64.${'${ext}'}`,
  },
  portable: {
    artifactName: `WAR-Controller-Portable-${channel}-${'${version}'}-windows-x64.${'${ext}'}`,
  },
  publish: null,
};
