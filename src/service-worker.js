import { STORAGE_KEYS, DEFAULT_SETTINGS, SAMPLE_PROFILE, clone, normalizeProfile, uid, isSupportedRunUrl, matchesSwitchTabPattern, normalizeSwitchTabPattern } from './shared.js';
import { findRootStepIds, validateGraph } from './graph.js';

const runtime = { running: new Map() };

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get([STORAGE_KEYS.profiles, STORAGE_KEYS.activeProfileId, STORAGE_KEYS.settings]);
  const updates = {};
  if (!Array.isArray(data[STORAGE_KEYS.profiles])) updates[STORAGE_KEYS.profiles] = [SAMPLE_PROFILE];
  if (!data[STORAGE_KEYS.activeProfileId]) updates[STORAGE_KEYS.activeProfileId] = SAMPLE_PROFILE.id;
  if (!data[STORAGE_KEYS.settings]) updates[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
  await configureCompanionPolling();
});

chrome.runtime.onStartup.addListener(configureCompanionPolling);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEYS.settings]) configureCompanionPolling();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'war-companion-poll') pollCompanion().catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'capture-target') {
    const tab = await getActiveTab();
    if (tab?.id) {
      const res = await sendToTab(tab.id, { type: 'WAR_CAPTURE_TARGET', mode: 'hotkey' }).catch(() => null);
      if (res && typeof res.isRecording === 'boolean') {
        chrome.runtime.sendMessage({ type: 'RECORDING_STATE_CHANGED', isRecording: res.isRecording }).catch(()=>null);
      }
    }
  }
  if (command === 'run-active-profile') await runActiveProfile();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'GET_STATE': return { ok: true, state: await getState() };
    case 'SAVE_PROFILES': await saveProfiles(message.profiles, message.activeProfileId); return { ok: true, state: await getState() };
    case 'RUN_PROFILE': return runProfileOnActiveTab(message.profileId, message.inputs || {});
    case 'STOP_PROFILE': return stopProfile(message.runId);
    case 'CLEAR_LOGS': await chrome.storage.local.set({ [STORAGE_KEYS.logs]: [] }); return { ok: true };
    case 'ADD_LIBRARY_ITEM': return addLibraryItem(message.item);
    case 'CONTENT_CAPTURED': return addLibraryItem({ ...message.item, source: 'content', capturedAt: new Date().toISOString(), tabId: sender.tab?.id });
    case 'CONTENT_LOG': await addLog(message.entry); return { ok: true };
    case 'WAR_CONTINUE_AFTER_NAVIGATION': return queueNavigationContinuation(sender.tab?.id, message);
    case 'WAR_RUN_FINISHED': runtime.running.delete(message.runId); return { ok: true };
    
    case 'WAR_SWITCH_TAB': return switchTab(message, sender);
    case 'FORWARD_ACTIVE_TAB': {
      const tab = await getTargetWebTab();
      if (!tab?.id) return { ok: false, error: 'No active tab' };
      if (['PICK_ELEMENT','WAR_CAPTURE_TARGET','WAR_CAPTURE_TYPE_TARGET','WAR_CAPTURE_DOMAIN_TARGET','WAR_CAPTURE_TEXT_TARGET'].includes(message.payload?.type)) {
        await chrome.tabs.update(tab.id,{active:true});
        await chrome.windows.update(tab.windowId,{focused:true});
      }
      return sendToTab(tab.id, message.payload).catch(e => ({ok: false, error: e.message}));
    }
    case 'OPEN_EDITOR_WINDOW': {
      const created=await chrome.windows.create({url:chrome.runtime.getURL('ui/sidepanel.html?standalone=1'),type:'popup',width:1100,height:850});
      return {ok:true,windowId:created.id};
    }
    default: return { ok: false, error: `Unknown message: ${message?.type}` };
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const key = `war_pending_${tabId}`;
  const data = await chrome.storage.session.get(key);
  const pending = data[key];
  if (!pending) return;
  await chrome.storage.session.remove(key);
  await sendToTab(tabId, { type: 'WAR_RUN_PROFILE', ...pending }).catch(async error => {
    await addLog({ level: 'error', message: `Không thể tiếp tục sau chuyển trang: ${error.message}`, runId: pending.runId });
    runtime.running.delete(pending.runId);
  });
});

async function queueNavigationContinuation(tabId, message) {
  if (!tabId) return { ok: false, error: 'Không xác định được tab để tiếp tục' };
  const key = `war_pending_${tabId}`;
  await chrome.storage.session.set({ [key]: { runId: message.runId, profile: message.profile, startIds: message.startIds, inputs: message.inputs || {} } });
  return { ok: true };
}

async function getState() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.profiles, STORAGE_KEYS.activeProfileId, STORAGE_KEYS.logs, STORAGE_KEYS.library, STORAGE_KEYS.settings]);
  return {
    profiles: data[STORAGE_KEYS.profiles] || [SAMPLE_PROFILE],
    activeProfileId: data[STORAGE_KEYS.activeProfileId] || SAMPLE_PROFILE.id,
    logs: data[STORAGE_KEYS.logs] || [],
    library: data[STORAGE_KEYS.library] || [],
    settings: { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.settings] || {}) }
  };
}

async function saveProfiles(profiles, activeProfileId) {
  const normalized = (profiles || []).map(normalizeProfile).map((profile) => ({
    ...profile,
    steps: profile.steps.map(({ isRoot, ...step }) => step)
  }));
  await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: normalized, [STORAGE_KEYS.activeProfileId]: activeProfileId || normalized[0]?.id || null });
}

async function addLibraryItem(item) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.library);
  const library = data[STORAGE_KEYS.library] || [];
  library.unshift({ id: uid('lib'), ...clone(item) });
  await chrome.storage.local.set({ [STORAGE_KEYS.library]: library.slice(0, 100) });
  await addLog({ level: 'info', message: `Captured ${item?.kind || item?.type || 'item'}` });
  
  // Broadcast to sidepanel that a new item was captured
  chrome.runtime.sendMessage({ type: 'CONTENT_CAPTURED' }).catch(() => null);
  
  return { ok: true, item: library[0] };
}

async function runActiveProfile() {
  const state = await getState();
  return runProfileOnActiveTab(state.activeProfileId);
}

async function runProfileOnActiveTab(profileId, inputs = {}) {
  const state = await getState();
  const profile = state.profiles.find((p) => p.id === profileId);
  if (!profile) return { ok: false, error: 'Profile not found' };
  if (!Array.isArray(profile.steps) || profile.steps.length === 0) return { ok: false, error: 'Profile has no steps' };
  profile.steps = profile.steps.map(({ isRoot, ...step }) => step);
  const graph = validateGraph(profile);
  if (!graph.ok) return { ok: false, error: graph.errors.join('; ') };
  graph.roots = findRootStepIds(profile.steps);
  if (!graph.roots.length) return { ok: false, error: 'Graph has no root step' };
  const tab = await getRunTargetTab();
  if (!tab?.id) return { ok: false, error: 'No supported web tab is available to run this profile' };
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
  const runId = uid('run');
  runtime.running.set(runId, { profileId, tabId: tab.id, startedAt: Date.now(), inputs });
  await addLog({ level: 'info', message: `Run started: ${profile.name}`, runId });
  const delivered = await sendRunProfileToTab(tab.id, { type: 'WAR_RUN_PROFILE', runId, profile, startIds: graph.roots, inputs }).catch(async (error) => {
    runtime.running.delete(runId);
    await addLog({ level: 'error', message: error.message, runId });
    return { ok: false, error: error.message };
  });
  if (!delivered?.ok) return { ok: false, error: delivered?.error || 'Could not start profile' };
  return { ok: true, runId, status: 'started' };
}

async function stopProfile(runId) {
  const run = runtime.running.get(runId);
  if (run) await sendToTab(run.tabId, { type: 'WAR_STOP_PROFILE', runId }).catch(() => {});
  runtime.running.delete(runId);
  await addLog({ level: 'warn', message: `Run stopped ${runId || ''}`, runId });
  return { ok: true };
}

async function addLog(entry) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.logs);
  const logs = data[STORAGE_KEYS.logs] || [];
  logs.unshift({ time: new Date().toISOString(), level: 'info', ...entry });
  await chrome.storage.local.set({ [STORAGE_KEYS.logs]: logs.slice(0, 300) });
}

async function getActiveTab() {
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tabs || tabs.length === 0) {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  return tabs[0];
}

async function getTargetWebTab() {
  const tabs=await chrome.tabs.query({});
  const candidates=tabs.filter(tab=>tab.id && isSupportedRunUrl(tab.url));
  return candidates.find(tab=>tab.active && tab.windowId!==chrome.windows.WINDOW_ID_NONE)
    || candidates.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message);
}

async function getRunTargetTab() {
  const active = await getActiveTab();
  if (active?.id && isSupportedRunUrl(active.url)) return active;
  return getTargetWebTab();
}

async function switchTab(message, sender) {
  let pattern;
  try {
    pattern = normalizeSwitchTabPattern(message.tabName);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  const sourceTabId = sender.tab?.id || message.sourceTabId || null;
  const tabs = await chrome.tabs.query({});
  const matches = tabs
    .filter((tab) => tab.id && matchesSwitchTabPattern(tab, pattern))
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const found = matches.find((tab) => tab.id !== sourceTabId) || matches[0];
  if (!found?.id) {
    const error = `No supported web tab matches Switch Tab pattern: ${pattern}`;
    await addLog({ level: 'error', message: error, runId: message.runId });
    return { ok: false, error };
  }
  await chrome.windows.update(found.windowId, { focused: true });
  await chrome.tabs.update(found.id, { active: true });
  await waitForTabReady(found.id);
  const startIds = Array.isArray(message.startIds) ? message.startIds : [];
  const previous = runtime.running.get(message.runId) || {};
  runtime.running.set(message.runId, {
    ...previous,
    profileId: message.profile?.id || previous.profileId,
    tabId: found.id,
    startedAt: previous.startedAt || Date.now(),
    inputs: message.inputs || {}
  });
  const delivered = await sendRunProfileToTab(found.id, {
    type: 'WAR_RUN_PROFILE',
    runId: message.runId,
    profile: message.profile,
    startIds,
    inputs: message.inputs || {}
  });
  if (!delivered?.ok) {
    await addLog({ level: 'error', message: delivered.error, runId: message.runId });
    return delivered;
  }
  return { ok: true, handedOff: true, tabId: found.id };
}

async function waitForTabReady(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, 15000);
    function done() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') done();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendRunProfileToTab(tabId, message) {
  try {
    return await sendToTab(tabId, message);
  } catch (firstError) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.id || !isSupportedRunUrl(tab.url)) throw firstError;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-script.js'] });
    try {
      return await sendToTab(tabId, message);
    } catch (secondError) {
      throw new Error(`Could not deliver profile to tab ${tabId}: ${secondError.message}`);
    }
  }
}

async function configureCompanionPolling() {
  const { [STORAGE_KEYS.settings]: raw } = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  await chrome.alarms.clear('war-companion-poll');
  if (!settings.externalApiEnabled) return;
  chrome.alarms.create('war-companion-poll', { periodInMinutes: Math.max(0.1, Number(settings.companionPollMs || 2000) / 60000) });
  pollCompanion().catch(() => {});
}

async function pollCompanion() {
  const state = await getState();
  let settings = state.settings;
  if (!settings.externalApiEnabled) return;
  const base = String(settings.companionUrl || '').replace(/\/$/, '');
  settings = await ensureCompanionDevice(base, settings, state);
  if (!settings.companionToken) return;
  const headers = { Authorization: `Bearer ${settings.companionToken}`, 'Content-Type': 'application/json' };
  await heartbeatCompanion(base, headers, settings, state).catch(() => {});
  const nextUrl = settings.companionDeviceId
    ? `${base}/v1/devices/${encodeURIComponent(settings.companionDeviceId)}/commands/next`
    : `${base}/v1/commands/next`;
  const response = await fetch(nextUrl, { headers });
  if (response.status === 204) return;
  if (!response.ok) throw new Error(`Companion HTTP ${response.status}`);
  const command = await response.json();
  if (settings.companionDeviceId && command.leaseId) {
    await fetch(`${base}/v1/devices/${encodeURIComponent(settings.companionDeviceId)}/commands/${encodeURIComponent(command.id)}/ack`, {
      method: 'POST', headers, body: JSON.stringify({ leaseId: command.leaseId })
    });
  }
  let result;
  try {
    if (command.type === 'run_profile') {
      const profile=state.profiles.find(p=>p.id===command.profileId);
      result=!profile?.enabled ? {ok:false,error:'Profile chưa được bật cho điều khiển từ xa'} : await runProfileOnActiveTab(command.profileId, command.inputs || {});
    }
    else if (command.type === 'stop_run') result = await stopProfile(command.runId);
    else if (command.type === 'get_state') result = { ok: true, profiles: state.profiles.map(p => ({ id: p.id, name: p.name, enabled: p.enabled })) };
    else result = { ok: false, error: 'Unsupported command type' };
  } catch (error) {
    result = { ok: false, error: error.message };
  }
  const resultUrl = settings.companionDeviceId
    ? `${base}/v1/devices/${encodeURIComponent(settings.companionDeviceId)}/commands/${encodeURIComponent(command.id)}/result`
    : `${base}/v1/commands/${encodeURIComponent(command.id)}/result`;
  const body = settings.companionDeviceId ? { leaseId: command.leaseId, result } : result;
  await fetch(resultUrl, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function ensureCompanionDevice(base, settings) {
  if (settings.companionDeviceId && settings.companionToken) return settings;
  if (!settings.companionEnrollmentToken) return settings;
  const name = settings.companionDeviceName || await defaultDeviceName();
  const response = await fetch(`${base}/v1/devices/enroll`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.companionEnrollmentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, extensionVersion: chrome.runtime.getManifest().version })
  });
  if (!response.ok) throw new Error(`Enroll failed HTTP ${response.status}`);
  const enrolled = await response.json();
  const next = { ...settings, companionDeviceId: enrolled.id, companionDeviceName: enrolled.name || name, companionToken: enrolled.deviceToken };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  await addLog({ level: 'info', message: `Companion enrolled: ${next.companionDeviceName}` });
  return next;
}

async function heartbeatCompanion(base, headers, settings, state) {
  if (!settings.companionDeviceId) return;
  await fetch(`${base}/v1/devices/${encodeURIComponent(settings.companionDeviceId)}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: runtime.running.size ? 'running' : 'online', runState: { running: runtime.running.size } })
  });
  await fetch(`${base}/v1/devices/${encodeURIComponent(settings.companionDeviceId)}/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: settings.companionDeviceName || await defaultDeviceName(),
      extensionVersion: chrome.runtime.getManifest().version,
      profiles: state.profiles.map((profile) => ({ id: profile.id, name: profile.name, enabled: profile.enabled }))
    })
  });
}

async function defaultDeviceName() {
  const platform = await chrome.runtime.getPlatformInfo().catch(() => null);
  return `Browser endpoint ${platform?.os || ''}`.trim();
}
