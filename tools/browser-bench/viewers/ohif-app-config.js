/** @type {AppTypes.Config} */
// The benchmark's app-config.js for @ohif/app 3.13.14 (tools/browser-bench/viewers.json serves it in place of dist/app-config.js).
// Same as the shipped config/default.js except: the only data source is
// `dicomlocal` (local files), so nothing calls the AWS demo DICOMweb server;
// the investigational-use dialog is turned off so it does not cover the drop zone.
window.config = {
  name: 'veacom-bench/ohif-local',
  routerBasename: null,
  extensions: [],
  modes: [],
  customizationService: {},
  showStudyList: true,
  maxNumberOfWebWorkers: 3,
  showWarningMessageForCrossOrigin: true,
  showCPUFallbackMessage: true,
  showLoadingIndicator: true,
  experimentalStudyBrowserSort: false,
  strictZSpacingForVolumeViewport: true,
  groupEnabledModesFirst: true,
  allowMultiSelectExport: false,
  maxNumRequests: {
    interaction: 100,
    thumbnail: 5,
    prefetch: 25,
  },
  showErrorDetails: 'always',
  investigationalUseDialog: {
    option: 'never',
  },
  defaultDataSourceName: 'dicomlocal',
  dataSources: [
    {
      namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
      sourceName: 'dicomlocal',
      configuration: {
        friendlyName: 'dicom local',
      },
    },
  ],
  httpErrorHandler: error => {
    console.warn(error.status);
  },
};
