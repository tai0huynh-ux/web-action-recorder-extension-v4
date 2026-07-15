import { STORAGE_KEYS, DEFAULT_SETTINGS } from '../src/shared.js';

const watcher = document.getElementById('watcher');
const externalApi = document.getElementById('externalApi');
const companionUrl = document.getElementById('companionUrl');
const companionToken = document.getElementById('companionToken');
const companionEnrollmentToken = document.getElementById('companionEnrollmentToken');
const companionDeviceId = document.getElementById('companionDeviceId');
const companionDeviceName = document.getElementById('companionDeviceName');
const status = document.getElementById('companionStatus');

chrome.storage.local.get(STORAGE_KEYS.settings).then((data) => {
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) };
  watcher.checked = Boolean(settings.globalWatcherEnabled);
  externalApi.checked = Boolean(settings.externalApiEnabled);
  companionUrl.value = settings.companionUrl || DEFAULT_SETTINGS.companionUrl;
  companionToken.value = settings.companionToken || '';
  companionEnrollmentToken.value = settings.companionEnrollmentToken || '';
  companionDeviceId.value = settings.companionDeviceId || '';
  companionDeviceName.value = settings.companionDeviceName || '';
});

watcher.onchange = async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: {
      ...DEFAULT_SETTINGS,
      ...(data[STORAGE_KEYS.settings] || {}),
      globalWatcherEnabled: watcher.checked
    }
  });
};

document.getElementById('saveCompanion').onclick = async () => {
  const data = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(data[STORAGE_KEYS.settings] || {}),
    externalApiEnabled: externalApi.checked,
    companionUrl: companionUrl.value.trim(),
    companionToken: companionToken.value,
    companionEnrollmentToken: companionEnrollmentToken.value,
    companionDeviceId: companionDeviceId.value,
    companionDeviceName: companionDeviceName.value.trim()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
  status.textContent = 'Da luu. Extension se enroll/poll Companion khi duoc bat.';
};
