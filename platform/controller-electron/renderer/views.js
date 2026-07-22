import { button, codeBlock, el, field, parseJsonInput, section, setStatus, stableJson, svgEl, table } from './dom.js';
import { controllerError, safeError } from './errors.js';
import { mergeConfiguredContainerHosts, refreshAll, refreshJob, refreshWorkflow, store, unwrap } from './state.js';
import { t } from './i18n.js';
import {
  WORKSPACE_SAMPLE_NODES,
  clampWorkspaceLayout,
  normalizeDeviceStatus,
  reduceDeviceSelection,
  selectedDevices,
} from './workspaceState.js';
import {
  normalizeRemoteSelection,
  pointForRemoteFrame,
  pollIntervalForFps,
  printableTextForKeyboardEvent,
  qualityForFps,
  remoteTargetsForAction,
  shortcutForKeyboardEvent,
} from './remoteControl.js';

let oneTimeSecret = null;
let pairingNotice = '';
let remotePolling = null;
let remoteScreens = new Map();
let remoteStatusNode = null;

export function clearPairingSecret() {
  oneTimeSecret = null;
  pairingNotice = '';
}

export function renderView(refresh) {
  if (store.view !== 'remote') stopRemotePolling();
  if (store.view !== 'pairing') clearPairingSecret();
  if (store.view === 'workspace') return workspaceView(refresh);
  if (store.view === 'overview') return overviewView(refresh);
  if (store.view === 'pairing') return pairingView(refresh);
  if (store.view === 'devices') return devicesView();
  if (store.view === 'groups') return groupsView(refresh);
  if (store.view === 'workflows') return workflowsView(refresh);
  if (store.view === 'jobs') return jobsView(refresh);
  if (store.view === 'trash') return trashView(refresh);
  if (store.view === 'remote') return remoteView(refresh);
  return diagnosticsView(refresh);
}

function workspaceView(refresh) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const selected = selectedDevices(allWorkspaceDevices(), store.workspace.selection);
  const root = el('section', { className: layout.graphCollapsed ? 'workspace-view graph-collapsed' : 'workspace-view', ariaLabel: t('navigation.workspace') });
  const machinesResizeHandle = panelResizeHandle(root, {
    setting: 'leftWidth',
    cssVariable: '--workspace-left',
    min: 220,
    max: 380,
    label: t('workspace.resize.machinesInput'),
    className: 'machines-input-resize',
    refresh,
  });
  const inputResizeHandle = layout.graphCollapsed ? null : panelResizeHandle(root, {
    setting: 'centerWidth',
    cssVariable: '--workspace-center',
    min: 320,
    max: 600,
    label: t('workspace.resize.inputGraph'),
    className: 'input-graph-resize',
    refresh,
  });
  root.replaceChildren(...[
    workspaceMobileToolbar(refresh),
    containersPane(refresh, workspacePaneActive('containers')),
    inputPane(selected, refresh, workspacePaneActive('input')),
    graphPane(refresh, workspacePaneActive('graph')),
    machinesResizeHandle,
    inputResizeHandle,
  ].filter(Boolean));
  if (root.style?.setProperty) {
    root.style.setProperty('--workspace-left', `${layout.leftWidth}px`);
    root.style.setProperty('--workspace-center', `${layout.centerWidth}px`);
  }
  return root;
}

function workspaceMobileToolbar(refresh) {
  return el('div', { className: 'workspace-mobile-toolbar', role: 'toolbar', ariaLabel: t('navigation.workspace') }, [
    workspacePaneButton('containers', t('workspace.toolbar.machines'), refresh),
    workspacePaneButton('input', t('workspace.toolbar.input'), refresh),
    workspacePaneButton('graph', t('workspace.toolbar.graph'), refresh),
  ]);
}

function workspacePaneButton(pane, label, refresh) {
  const active = workspacePaneActive(pane);
  const item = button(label, () => {
    store.workspace.activePane = pane;
    refresh();
  }, { className: `button compact mobile-pane-switch${active ? ' active' : ''}` });
  item.setAttribute('aria-pressed', String(active));
  return item;
}

function workspacePaneActive(pane) {
  return (store.workspace.activePane || 'containers') === pane;
}

function workspacePaneClass(baseClass, active) {
  return `workspace-pane ${baseClass}${active ? ' active-mobile-pane' : ''}`;
}

function containersPane(refresh, active = false) {
  const devices = visibleWorkspaceDevices();
  const search = el('input', { type: 'search', placeholder: t('workspace.containers.search'), value: store.workspace.search, ariaLabel: t('workspace.containers.search') });
  search.addEventListener('input', () => {
    store.workspace.search = search.value;
    refresh();
  });
  const status = selectionStatus();
  const pane = el('aside', { className: workspacePaneClass('containers-pane', active), ariaLabel: t('workspace.containers.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.containers.title') }),
        el('p', { className: 'muted', text: status }),
      ]),
      el('div', { className: 'toolbar tight' }, [
        button(t('workspace.containers.checkAll'), () => refreshAllContainers(refresh), { className: 'button compact', disabled: store.workspace.containerAllPending || !activeManagedContainers().length }),
        button(store.workspace.hostSetupOpen ? t('workspace.containers.collapseHostSetup') : `+ ${t('workspace.containers.addHost')}`, () => {
          store.workspace.hostSetupOpen = !store.workspace.hostSetupOpen;
          store.workspace.hostError = '';
          if (store.workspace.hostSetupOpen) {
            store.workspace.hostEditorId = '';
            store.workspace.hostDraft = emptyHostDraft();
          }
          refresh();
        }, { className: 'button compact' }),
        button(store.workspace.addContainerOpen ? t('workspace.containers.collapseAdd') : `+ ${t('workspace.containers.add')}`, async () => {
          const opening = !store.workspace.addContainerOpen;
          store.workspace.addContainerOpen = opening;
          if (opening) await loadContainerHosts(refresh);
          else refresh();
        }, { className: 'button primary' }),
      ]),
    ]),
    el('p', {
      className: 'status container-pane-status',
      text: store.workspace.containerNotice || '',
      ariaLive: 'polite',
    }),
    store.workspace.hostSetupOpen ? hostSetupForm(refresh) : null,
    hostDiagnosticsList(refresh),
    search,
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.all'), () => {
        store.workspace.deviceFilter = 'all';
        store.workspace.filterOpen = false;
        refresh();
      }, { className: `button chip${store.workspace.deviceFilter === 'all' ? ' active' : ''}` }),
      button(t('workspace.containers.filter'), () => {
        store.workspace.filterOpen = !store.workspace.filterOpen;
        refresh();
      }, { className: `button chip${store.workspace.filterOpen || store.workspace.deviceFilter !== 'all' ? ' active' : ''}` }),
      button(t('workspace.containers.selectAll'), () => {
        store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'selectAllVisible' });
        refresh();
      }, { className: 'button chip' }),
      button(t('workspace.containers.clear'), () => {
        store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'clear' });
        refresh();
      }, { className: 'button chip' }),
    ]),
    store.workspace.filterOpen ? containerFilterPanel(refresh) : null,
    store.workspace.addContainerOpen ? addContainerForm(refresh) : null,
    devices.length ? deviceList(devices, refresh) : el('p', { className: 'empty-state', text: t('workspace.containers.empty') }),
    activeManagedContainers().length ? managedContainerActions(refresh) : null,
  ]);
  pane.setAttribute('data-scroll-key', 'workspace-machines');
  return pane;
}

function containerFilterPanel(refresh) {
  const filter = el('select', { ariaLabel: t('workspace.containers.filter') }, [
    el('option', { value: 'all', text: t('workspace.containers.filterAll') }),
    el('option', { value: 'online', text: t('workspace.containers.filterOnline') }),
    el('option', { value: 'offline', text: t('workspace.containers.filterOffline') }),
    el('option', { value: 'containers', text: t('workspace.containers.filterContainers') }),
  ]);
  filter.value = store.workspace.deviceFilter || 'all';
  filter.addEventListener('change', () => {
    store.workspace.deviceFilter = filter.value;
    refresh();
  });
  return el('div', { className: 'filter-panel' }, [field(t('workspace.containers.filter'), filter)]);
}

async function loadContainerHosts(refresh) {
  if (store.workspace.containerHostStatus === 'loading') return;
  store.workspace.containerHostStatus = 'loading';
  store.workspace.containerNotice = t('workspace.containers.hostChecking');
  refresh();
  try {
    const result = await window.warController.containers.hosts();
    if (result?.ok === false) throw controllerError(result, 'SSH_HOST_LIST_FAILED');
    const data = unwrap(result) || {};
    store.workspace.containerHosts = mergeConfiguredContainerHosts(data.hosts, store.settings?.containerHosts);
    store.workspace.containerHostStatus = data.status || (store.workspace.containerHosts.length ? 'connected' : 'unavailable');
    const connectedHosts = store.workspace.containerHosts.filter((host) => host.connected);
    if (!connectedHosts.some((host) => host.id === store.workspace.containerHostId)) {
      store.workspace.containerHostId = connectedHosts[0]?.id || '';
    }
    store.workspace.containerNotice = connectedHosts.length
      ? t('workspace.containers.hostConnected')
      : t('workspace.containers.hostUnavailable');
  } catch (error) {
    store.workspace.containerHosts = mergeConfiguredContainerHosts([], store.settings?.containerHosts);
    store.workspace.containerHostId = '';
    store.workspace.containerHostStatus = 'unavailable';
    store.workspace.containerNotice = safeError(error, 'SSH_HOST_LIST_FAILED');
  } finally {
    refresh();
  }
}

function emptyHostDraft() {
  return { name: '', target: '', identityFile: '', controllerHost: '', controllerCaPath: '/etc/war/controller-ca.pem', image: 'war-browser-agent:phase1' };
}

function configuredHost(hostId) {
  return (store.settings?.containerHosts || []).find((host) => host?.id === hostId) || {};
}

function hostDraftFromHost(host) {
  const config = configuredHost(host.id);
  return {
    name: config.name || host.name || host.label || '',
    target: config.target || host.target || '',
    identityFile: config.identityFile || '',
    controllerHost: config.controllerHost || '',
    controllerCaPath: config.controllerCaPath || '/etc/war/controller-ca.pem',
    image: config.image || host.image || 'war-browser-agent:phase1',
  };
}

function selectHostForEdit(host, refresh) {
  store.workspace.hostEditorId = host.id;
  store.workspace.hostDraft = hostDraftFromHost(host);
  store.workspace.hostSetupOpen = true;
  store.workspace.hostError = '';
  store.workspace.containerNotice = '';
  refresh();
}

function hostSetupForm(refresh) {
  const draft = store.workspace.hostDraft || {};
  const editing = Boolean(store.workspace.hostEditorId);
  const name = el('input', { type: 'text', value: draft.name || '', placeholder: t('workspace.containers.hostNamePlaceholder') });
  const target = el('input', { type: 'text', value: draft.target || '', placeholder: 'root@192.168.1.201' });
  const identityFile = el('input', { type: 'text', value: draft.identityFile || '', placeholder: 'C:\\Users\\you\\.ssh\\id_ed25519' });
  const controllerHost = el('input', { type: 'text', value: draft.controllerHost || '', placeholder: t('workspace.containers.controllerHostPlaceholder') });
  const controllerCaPath = el('input', { type: 'text', value: draft.controllerCaPath || '/etc/war/controller-ca.pem', placeholder: t('workspace.containers.controllerCaPathPlaceholder') });
  const image = el('input', { type: 'text', value: draft.image || 'war-browser-agent:phase1', placeholder: 'war-browser-agent:phase1' });
  const rememberDraft = () => {
    store.workspace.hostDraft = {
      name: name.value,
      target: target.value,
      identityFile: identityFile.value,
      controllerHost: controllerHost.value,
      controllerCaPath: controllerCaPath.value,
      image: image.value,
    };
  };
  for (const input of [name, target, identityFile, controllerHost, controllerCaPath, image]) input.addEventListener('input', rememberDraft);
  const pending = Boolean(store.workspace.hostPending);
  const status = el('p', { className: store.workspace.hostError ? 'status error' : 'status', text: store.workspace.hostError || store.workspace.containerNotice || '', ariaLive: 'polite' });
  return el('article', { className: 'host-setup-card', role: 'form', ariaLabel: t('workspace.containers.addHost') }, [
      el('div', { className: 'host-setup-heading' }, [
      el('div', {}, [
        el('strong', { text: editing ? t('workspace.containers.editHost') : t('workspace.containers.addHost') }),
        el('p', { className: 'muted', text: t('workspace.containers.hostSetupHelp') }),
      ]),
      el('div', { className: 'toolbar tight' }, [
        el('span', { className: 'status-pill connecting', text: pending ? t('workspace.containers.hostWorking') : t('workspace.containers.sshKeyRequired') }),
        button(t('workspace.containers.collapseHostSetup'), () => {
          store.workspace.hostSetupOpen = false;
          refresh();
        }, { className: 'button compact' }),
      ]),
    ]),
    el('div', { className: 'form-grid host-form-grid' }, [
      field(t('workspace.containers.hostName'), name),
      field(t('workspace.containers.sshTarget'), target),
      field(t('workspace.containers.sshIdentity'), identityFile),
      field(t('workspace.containers.controllerHost'), controllerHost),
      field(t('workspace.containers.controllerCaPath'), controllerCaPath),
      field(t('workspace.containers.image'), image),
    ]),
    el('div', { className: 'toolbar tight' }, [
      button(editing ? t('workspace.containers.updateAndCheckHost') : t('workspace.containers.saveAndCheckHost'), () => submitHostSetup('check', status, refresh), { className: 'button', disabled: pending }),
      button(editing ? t('workspace.containers.updateRepairAndConnectHost') : t('workspace.containers.repairAndConnectHost'), () => submitHostSetup('repair', status, refresh), { className: 'button primary', disabled: pending }),
    ]),
    status,
  ]);
}

async function submitHostSetup(mode, status, refresh) {
  if (store.workspace.hostPending) return;
  const draft = store.workspace.hostDraft || {};
  const editing = Boolean(store.workspace.hostEditorId);
  const payload = {
    name: String(draft.name || '').trim(),
    target: String(draft.target || '').trim(),
    identityFile: String(draft.identityFile || '').trim(),
    controllerHost: String(draft.controllerHost || '').trim(),
    controllerCaPath: String(draft.controllerCaPath || '/etc/war/controller-ca.pem').trim(),
    image: String(draft.image || 'war-browser-agent:phase1').trim(),
    ipv6Driver: 'macvlan',
  };
  if (!payload.name || !payload.target || (!payload.identityFile && !editing) || !payload.controllerHost || !payload.controllerCaPath) {
    store.workspace.hostError = t('workspace.containers.hostFieldsRequired');
    status.textContent = store.workspace.hostError;
    status.className = 'status error';
    return;
  }
  store.workspace.hostPending = mode;
  store.workspace.hostError = '';
  store.workspace.containerNotice = mode === 'repair'
    ? t('workspace.containers.hostRepairing')
    : t('workspace.containers.hostChecking');
  refresh();
  try {
    const savedResult = editing
      ? await window.warController.containers.updateHost({ hostId: store.workspace.hostEditorId, ...payload })
      : await window.warController.containers.addHost(payload);
    if (savedResult?.ok === false) throw controllerError(savedResult, 'SSH_HOST_SAVE_FAILED');
    let host = unwrap(savedResult) || {};
    if (mode === 'repair') {
      const repairResult = await window.warController.containers.repairHost({ hostId: host.id });
      if (repairResult?.ok === false) throw controllerError(repairResult, 'SSH_HOST_REPAIR_FAILED');
      host = unwrap(repairResult) || host;
    }
    await refreshAll();
    await loadContainerHosts(refresh);
    store.workspace.containerHostId = host.connected ? host.id : store.workspace.containerHostId;
    store.workspace.hostEditorId = host.id;
    store.workspace.hostDraft = hostDraftFromHost(host);
    store.workspace.containerNotice = host.connected
      ? t('workspace.containers.hostConnected')
      : t('workspace.containers.hostRepairRequired');
    store.workspace.hostError = '';
  } catch (error) {
    await loadContainerHosts(refresh);
    store.workspace.hostError = safeError(error, 'SSH_HOST_ERROR');
    store.workspace.containerNotice = store.workspace.hostError;
  } finally {
    store.workspace.hostPending = '';
    refresh();
  }
}

function hostDiagnosticsList(refresh) {
  const hosts = store.workspace.containerHosts || [];
  if (!hosts.length) return el('p', { className: 'muted', text: t('workspace.containers.noHostConfigured') });
  return el('div', { className: 'host-diagnostics-list' }, hosts.map((host) => {
    const checks = host.diagnostics || {};
    const pending = store.workspace.trashPending?.[`host:${host.id}`];
    const config = configuredHost(host.id);
    const selected = store.workspace.hostEditorId === host.id;
    const select = el('button', {
      type: 'button',
      className: `host-card-select${selected ? ' selected' : ''}`,
      ariaLabel: `${host.label || host.id} - ${t('workspace.containers.selectHostToEdit')}`,
    }, [
      el('div', { className: 'host-card-title' }, [
        el('strong', { text: host.label || host.id }),
        el('span', { className: host.connected ? 'status-pill online' : 'status-pill failed', text: hostStatusText(host) }),
      ]),
      el('span', { className: 'device-meta', text: host.target || '' }),
      el('span', { className: 'device-meta', text: t('workspace.containers.hostCheckSummary', {
        docker: checkMark(checks.docker),
        image: checkMark(checks.image),
        app: checkMark(checks.source),
        policy: checkMark(checks.apparmor && checks.seccomp),
        ca: checkMark(checks.ca),
      }) }),
      el('span', { className: 'device-meta', text: `${t('workspace.containers.controllerHost')}: ${config.controllerHost || t('workspace.containers.unknown')}` }),
      el('span', { className: 'device-meta', text: `${t('workspace.containers.controllerCaPath')}: ${config.controllerCaPath || t('workspace.containers.unknown')}` }),
      el('span', { className: 'device-meta', text: `${t('workspace.containers.image')}: ${config.image || host.image || t('workspace.containers.unknown')} · ${config.identityFile ? t('workspace.containers.hostIdentityStored') : t('workspace.containers.sshKeyRequired')}` }),
      checks.error ? el('span', { className: 'device-meta host-diagnostic-error', text: checks.error }) : null,
      el('span', { className: 'host-card-hint', text: selected ? t('workspace.containers.editingHost') : t('workspace.containers.selectHostToEdit') }),
    ]);
    select.addEventListener('click', () => selectHostForEdit(host, refresh));
    return el('article', { className: `host-card${selected ? ' selected' : ''}` }, [
      select,
      button(t('workspace.containers.reconnect'), (event) => {
        event.stopPropagation?.();
        reconnectHost(host, refresh);
      }, {
        className: 'button compact',
        disabled: Boolean(pending) || Boolean(store.workspace.hostPending),
        ariaLabel: t('workspace.containers.reconnectHost', { name: host.label || host.id }),
        title: t('workspace.containers.reconnectHost', { name: host.label || host.id }),
      }),
      button('×', (event) => {
        event.stopPropagation?.();
        trashHost(host, refresh);
      }, {
        className: 'device-card-delete',
        disabled: Boolean(pending),
        ariaLabel: t('workspace.containers.moveHostToTrash', { name: host.label || host.id }),
        title: t('workspace.containers.moveHostToTrash', { name: host.label || host.id }),
      }),
    ]);
  }));
}

function checkMark(value) {
  return value ? 'OK' : '--';
}

function hostStatusText(host) {
  if (host.connected) return t('workspace.containers.hostReady');
  if (host.status === 'controller-required' || (host.diagnostics?.linuxReady && host.diagnostics?.wss === false)) {
    return t('workspace.containers.hostControllerRequired');
  }
  return t('workspace.containers.hostRepairRequired');
}

function trashView(refresh) {
  const containers = store.containers.filter((container) => container.status === 'deleted');
  const hosts = store.workspace.trashHosts || [];
  const count = containers.length + hosts.length;
  return el('section', { className: 'view-panel trash-view', ariaLabel: t('navigation.trash') }, [
    el('div', { className: 'trash-view-heading' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.containers.trash') }),
        el('p', { className: 'muted', text: t('workspace.containers.trashHelp') }),
      ]),
      el('span', { className: 'status-pill connecting', text: `${count} ${t('workspace.containers.trashItems')}` }),
    ]),
    trashContents(containers, hosts, refresh),
  ]);
}

function trashPanel(refresh) {
  const containers = store.containers.filter((container) => container.status === 'deleted');
  const hosts = store.workspace.trashHosts || [];
  const count = containers.length + hosts.length;
  const open = store.workspace.trashOpen === true;
  return el('section', { className: `trash-panel${open ? ' open' : ''}`, ariaLabel: t('workspace.containers.trash') }, [
    el('div', { className: 'trash-panel-heading' }, [
      el('div', {}, [
        el('h3', { text: t('workspace.containers.trash') }),
        el('p', { className: 'muted', text: t('workspace.containers.trashHelp') }),
      ]),
      button(`${open ? '−' : '+'} ${t('workspace.containers.trash')} (${count})`, () => {
        store.workspace.trashOpen = !open;
        refresh();
      }, { className: 'button compact', ariaLabel: t('workspace.containers.openTrash') }),
    ]),
    open ? trashContents(containers, hosts, refresh) : null,
  ]);
}

function trashContents(containers, hosts, refresh) {
  if (!containers.length && !hosts.length) return el('p', { className: 'empty-state', text: t('workspace.containers.trashEmpty') });
  return el('div', { className: 'trash-list' }, [
    ...hosts.map((host) => trashHostCard(host, refresh)),
    ...containers.map((container) => trashContainerCard(container, refresh)),
  ]);
}

function trashHostCard(host, refresh) {
  const pending = store.workspace.trashPending?.[`host:${host.id}`];
  return el('article', { className: 'trash-card' }, [
    el('div', {}, [
      el('strong', { text: host.label || host.name || host.id }),
      el('span', { className: 'device-meta', text: `${t('workspace.containers.linuxHost')} · ${host.target || host.id}` }),
    ]),
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.restore'), () => restoreTrashHost(host, refresh), { className: 'button compact', disabled: Boolean(pending) }),
      button(t('workspace.containers.purge'), () => purgeTrashHost(host, refresh), { className: 'button compact danger', disabled: Boolean(pending) }),
    ]),
  ]);
}

function trashContainerCard(container, refresh) {
  const pending = store.workspace.trashPending?.[`container:${container.id}`];
  return el('article', { className: 'trash-card' }, [
    el('div', {}, [
      el('strong', { text: container.name || container.id }),
      el('span', { className: 'device-meta', text: `${t('workspace.containers.container')} · ${container.host || t('workspace.containers.unknown')}` }),
      el('span', { className: 'device-meta', text: container.deletedAt || '' }),
    ]),
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.restore'), () => restoreTrashContainer(container, refresh), { className: 'button compact', disabled: Boolean(pending) }),
      button(t('workspace.containers.purge'), () => purgeTrashContainer(container, refresh), { className: 'button compact danger', disabled: Boolean(pending) }),
    ]),
  ]);
}

async function trashHost(host, refresh) {
  const hostId = host.id;
  if (store.workspace.trashPending?.[`host:${hostId}`]) return;
  if (!window.confirm(t('workspace.containers.moveHostToTrashConfirm', { name: host.label || host.id }))) return;
  store.workspace.trashPending = { ...store.workspace.trashPending, [`host:${hostId}`]: 'trash' };
  refresh();
  try {
    const result = await window.warController.containers.trashHost({ hostId });
    if (result?.ok === false) throw controllerError(result, 'HOST_TRASH_FAILED');
    store.workspace.containerNotice = t('workspace.containers.movedToTrash');
    if (store.workspace.hostEditorId === hostId) {
      store.workspace.hostEditorId = '';
      store.workspace.hostDraft = emptyHostDraft();
      store.workspace.hostSetupOpen = false;
    }
    await loadContainerHosts(refresh);
    await refreshAll();
  } catch (error) {
    store.workspace.trashError = safeError(error, 'HOST_TRASH_FAILED');
    store.workspace.containerNotice = store.workspace.trashError;
  } finally {
    const { [`host:${hostId}`]: _removed, ...remaining } = store.workspace.trashPending || {};
    store.workspace.trashPending = remaining;
    refresh();
  }
}

async function reconnectHost(host, refresh) {
  if (store.workspace.hostPending) return;
  store.workspace.hostPending = 'reconnect';
  store.workspace.containerNotice = t('workspace.containers.reconnecting', { name: host.label || host.id });
  refresh();
  try {
    const result = await window.warController.containers.reconnectHost({ hostId: host.id });
    if (result?.ok === false) throw controllerError(result, 'HOST_RECONNECT_FAILED');
    store.workspace.containerNotice = t('workspace.containers.reconnected', { name: host.label || host.id });
    await loadContainerHosts(refresh);
    await refreshAll();
  } catch (error) {
    store.workspace.containerNotice = safeError(error, 'HOST_RECONNECT_FAILED');
  } finally {
    store.workspace.hostPending = '';
    refresh();
  }
}

async function restoreTrashHost(host, refresh) {
  await trashHostAction('restoreHost', host, refresh, t('workspace.containers.restoredFromTrash'));
}

async function purgeTrashHost(host, refresh) {
  if (!window.confirm(t('workspace.containers.purgeConfirm', { name: host.label || host.id }))) return;
  await trashHostAction('purgeHost', host, refresh, t('workspace.containers.purgedFromTrash'));
}

async function trashHostAction(action, host, refresh, successNotice) {
  const key = `host:${host.id}`;
  if (store.workspace.trashPending?.[key]) return;
  store.workspace.trashPending = { ...store.workspace.trashPending, [key]: action };
  refresh();
  try {
    const result = await window.warController.containers[action]({ hostId: host.id });
    if (result?.ok === false) throw controllerError(result, 'HOST_TRASH_ACTION_FAILED');
    store.workspace.containerNotice = successNotice;
    await loadContainerHosts(refresh);
    await refreshAll();
  } catch (error) {
    store.workspace.trashError = safeError(error, 'HOST_TRASH_ACTION_FAILED');
    store.workspace.containerNotice = store.workspace.trashError;
  } finally {
    const { [key]: _removed, ...remaining } = store.workspace.trashPending || {};
    store.workspace.trashPending = remaining;
    refresh();
  }
}

async function restoreTrashContainer(container, refresh) {
  await trashContainerAction('restore', container, refresh, t('workspace.containers.restoredFromTrash'));
}

async function purgeTrashContainer(container, refresh) {
  if (!window.confirm(t('workspace.containers.purgeConfirm', { name: container.name || container.id }))) return;
  await trashContainerAction('purge', container, refresh, t('workspace.containers.purgedFromTrash'));
}

async function trashContainerAction(action, container, refresh, successNotice) {
  const key = `container:${container.id}`;
  if (store.workspace.trashPending?.[key]) return;
  store.workspace.trashPending = { ...store.workspace.trashPending, [key]: action };
  refresh();
  try {
    const result = await window.warController.containers[action]({ containerId: container.id });
    if (result?.ok === false || result?.data?.operation?.ok === false) throw controllerError(result?.data?.operation || result, 'CONTAINER_TRASH_ACTION_FAILED');
    store.workspace.containerNotice = successNotice;
    await refreshAll();
  } catch (error) {
    store.workspace.trashError = safeError(error, 'CONTAINER_TRASH_ACTION_FAILED');
    store.workspace.containerNotice = store.workspace.trashError;
  } finally {
    const { [key]: _removed, ...remaining } = store.workspace.trashPending || {};
    store.workspace.trashPending = remaining;
    refresh();
  }
}

function addContainerForm(refresh) {
  const initialPrefix = store.workspace.containerNamePrefix.trim() || latestContainerNamePrefix(store.containers) || 'Agent';
  const suggestedSequence = nextContainerSequence(initialPrefix, store.containers);
  const initialSequence = validContainerSequence(store.workspace.containerNameSequence)
    ? store.workspace.containerNameSequence
    : suggestedSequence;
  store.workspace.containerNamePrefix = initialPrefix;
  store.workspace.containerNameSequence = initialSequence;
  const namePrefix = el('input', { type: 'text', value: initialPrefix, placeholder: t('workspace.containers.namePrefixPlaceholder') });
  const nameSequence = el('input', { type: 'number', value: initialSequence, min: 1, max: 999999, step: 1, ariaLabel: t('workspace.containers.nameSequence') });
  const namePreview = el('p', { className: 'muted name-preview' });
  const updateNamePreview = () => {
    const sequence = parseContainerSequence(nameSequence.value);
    const completeName = sequence ? containerDisplayName(namePrefix.value, sequence) : namePrefix.value.trim();
    namePreview.textContent = t('workspace.containers.namePreview', { name: completeName || t('workspace.containers.unknown') });
  };
  namePrefix.addEventListener('input', () => {
    store.workspace.containerNamePrefix = namePrefix.value;
    const nextSequence = nextContainerSequence(namePrefix.value, store.containers);
    nameSequence.value = String(nextSequence);
    store.workspace.containerNameSequence = nextSequence;
    updateNamePreview();
  });
  nameSequence.addEventListener('input', () => {
    store.workspace.containerNameSequence = parseContainerSequence(nameSequence.value);
    updateNamePreview();
  });
  updateNamePreview();
  const hosts = store.workspace.containerHosts || [];
  const host = el('select', { ariaLabel: t('workspace.containers.host') }, [
    el('option', { value: '', text: hosts.some((item) => item.connected) ? t('workspace.containers.selectHost') : t('workspace.containers.noHost') }),
    ...hosts.map((item) => el('option', { value: item.id, text: containerHostLabel(item), disabled: !item.connected })),
  ]);
  host.value = store.workspace.containerHostId || '';
  host.addEventListener('change', () => {
    store.workspace.containerHostId = host.value;
    nickname.value = store.settings?.hostAliases?.[host.value] || hostLabelFromId(host.value);
  });
  const nickname = el('input', {
    type: 'text',
    value: store.settings?.hostAliases?.[store.workspace.containerHostId] || hostLabelFromId(store.workspace.containerHostId),
    placeholder: t('workspace.containers.hostNicknamePlaceholder'),
    ariaLabel: t('workspace.containers.hostNickname'),
  });
  const ipv4Enabled = el('input', { type: 'checkbox', checked: true });
  const ipv6Enabled = el('input', { type: 'checkbox', checked: false });
  const ipv6Suffix = el('input', { type: 'text', value: '', placeholder: t('workspace.containers.ipv6SuffixPlaceholder'), disabled: true, ariaLabel: t('workspace.containers.ipv6Suffix') });
  const randomIpv6 = button(t('workspace.containers.randomIpv6'), () => {
    ipv6Enabled.checked = true;
    ipv6Suffix.disabled = false;
    ipv6Suffix.value = randomIpv6Eui64Suffix();
  }, { className: 'button compact' });
  ipv6Enabled.addEventListener('change', () => {
    ipv6Suffix.disabled = !ipv6Enabled.checked;
  });
  const status = el('p', { className: 'status', text: store.workspace.containerNotice || '', ariaLive: 'polite' });
  const createDisabled = store.workspace.addContainerPending === true || !hosts.length;
  return el('article', { className: 'prototype-note', role: 'form', ariaLabel: t('workspace.containers.add') }, [
    el('div', { className: 'form-section-heading' }, [
      el('strong', { text: t('workspace.containers.add') }),
      button(t('workspace.containers.collapseAdd'), () => {
        store.workspace.addContainerOpen = false;
        refresh();
      }, { className: 'button compact' }),
    ]),
    field(t('workspace.containers.host'), host),
    el('div', { className: 'form-grid container-name-grid' }, [
      field(t('workspace.containers.namePrefix'), namePrefix),
      field(t('workspace.containers.nameSequence'), nameSequence),
    ]),
    field(t('workspace.containers.hostNickname'), nickname),
    namePreview,
    el('p', { className: 'muted', text: t('workspace.containers.autoProvisionHelp') }),
    field(t('workspace.containers.ipv4Enabled'), ipv4Enabled),
    field(t('workspace.containers.ipv6Enabled'), ipv6Enabled),
    el('div', { className: 'field' }, [
      el('span', { text: t('workspace.containers.ipv6Suffix') }),
      el('div', { className: 'inline-control' }, [ipv6Suffix, randomIpv6]),
      el('small', { className: 'muted', text: t('workspace.containers.ipv6StableHelp') }),
    ]),
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.create'), async () => {
        if (store.workspace.addContainerPending) return;
        const fixedName = namePrefix.value.trim();
        const sequenceNumber = parseContainerSequence(nameSequence.value);
        const payload = {
          name: fixedName && sequenceNumber ? containerDisplayName(fixedName, sequenceNumber) : '',
          host: host.value,
          runtime: {
            ipv4Enabled: ipv4Enabled.checked,
            ipv6Enabled: ipv6Enabled.checked,
            ipv6Suffix: ipv6Enabled.checked ? ipv6Suffix.value.trim() : null,
          },
        };
        if (!payload.host) {
          store.workspace.containerNotice = t('workspace.containers.hostRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        if (!fixedName) {
          store.workspace.containerNotice = t('workspace.containers.nameRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        if (!sequenceNumber) {
          store.workspace.containerNotice = t('workspace.containers.nameSequenceRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        if (!payload.runtime.ipv4Enabled && !payload.runtime.ipv6Enabled) {
          store.workspace.containerNotice = t('workspace.containers.networkRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        if (payload.runtime.ipv6Enabled && !payload.runtime.ipv6Suffix) {
          store.workspace.containerNotice = t('workspace.containers.ipv6SuffixRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        store.workspace.addContainerPending = true;
        store.workspace.containerNotice = t('workspace.containers.creating');
        refresh();
        try {
          const result = await window.warController.containers.add(payload);
          if (result?.ok === false) {
            store.workspace.containerNotice = safeError(result);
            status.textContent = store.workspace.containerNotice;
            return;
          }
          const hostAlias = nickname.value.trim();
          if (host.value && hostAlias) {
            const hostAliases = { ...(store.settings?.hostAliases || {}), [host.value]: hostAlias };
            await window.warController.settings.update({ hostAliases });
            store.settings = { ...store.settings, hostAliases };
          }
          store.workspace.containerNotice = t('workspace.containers.createdAndAdded');
          await refreshAll();
          store.workspace.containerNamePrefix = fixedName;
          store.workspace.containerNameSequence = nextContainerSequence(fixedName, store.containers);
        } catch (error) {
          store.workspace.containerNotice = safeError(error);
        } finally {
          store.workspace.addContainerPending = false;
          refresh();
        }
      }, { className: 'button primary', disabled: createDisabled }),
    ]),
    status,
  ]);
}

function managedContainerActions(refresh) {
  return el('div', { className: 'device-list', ariaLabel: t('workspace.containers.managed') },
    activeManagedContainers().map((container) => {
      const pendingAction = store.workspace.containerPending?.[container.id] || '';
      const displayStatus = pendingAction ? pendingStatus(pendingAction) : normalizeDeviceStatus(container);
      const terminalDisabled = container.status === 'deleted' || container.status === 'deleting';
      const busy = Boolean(pendingAction) || ['creating', 'pairing', 'starting', 'stopping', 'restarting', 'deleting'].includes(container.status);
      const error = store.workspace.containerErrors?.[container.id] || container.lastError;
      const agentOnline = isContainerAgentOnline(container);
      return el('article', { className: 'device-card managed-container' }, [
        el('span', { className: 'device-name', text: `${container.name || container.id} (${containerHostName(container)})` }),
        el('span', { className: `status-pill ${displayStatus}`, text: t(`status.${displayStatus}`) }),
        el('span', { className: agentOnline ? 'status-pill online' : 'status-pill offline', text: agentOnline ? t('workspace.containers.agentOnline') : t('workspace.containers.agentOffline') }),
        el('span', { className: 'device-meta', text: container.runtime?.dockerName || shortId(container.id) }),
        el('span', { className: 'device-meta', text: usageSummary(container.resourceUsage) }),
        el('span', { className: 'device-meta', text: containerNetworkSummary(container) }),
        container.runtime?.ipv6PrefixChanged ? el('span', { className: 'device-meta error', text: t('workspace.containers.ipv6PrefixChanged') }) : null,
        error ? el('span', { className: 'device-meta error', text: error, ariaLive: 'polite' }) : null,
        el('div', { className: 'toolbar tight' }, [
          button(t('workspace.containers.start'), () => containerAction('start', container, refresh), { className: 'button chip', disabled: terminalDisabled || busy || container.status === 'running' }),
          button(t('workspace.containers.stop'), () => containerAction('stop', container, refresh), { className: 'button chip', disabled: terminalDisabled || busy || container.status === 'stopped' }),
          button(t('workspace.containers.restart'), () => containerAction('restart', container, refresh), { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.reconnect'), () => containerAction('reconnect', container, refresh), { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.refreshStatus'), () => containerAction('refresh', container, refresh), { className: 'button chip', disabled: terminalDisabled || Boolean(pendingAction) }),
          button(t('workspace.containers.networkSettings'), () => {
            store.workspace.containerNetworkOpenId = store.workspace.containerNetworkOpenId === container.id ? '' : container.id;
            refresh();
          }, { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.duplicate'), () => duplicateContainer(container, refresh), { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.moveToTrash'), () => containerAction('delete', container, refresh), { className: 'button chip danger', disabled: terminalDisabled || busy }),
        ]),
        store.workspace.containerNetworkOpenId === container.id ? containerNetworkForm(container, refresh) : null,
      ]);
    }));
}

function containerNetworkForm(container, refresh) {
  const ipv4Enabled = el('input', { type: 'checkbox', checked: container.runtime?.ipv4Enabled !== false });
  const ipv6Enabled = el('input', { type: 'checkbox', checked: container.runtime?.ipv6Enabled === true });
  const ipv6Suffix = el('input', {
    type: 'text',
    value: container.runtime?.ipv6Suffix || '',
    placeholder: t('workspace.containers.ipv6SuffixPlaceholder'),
    disabled: !ipv6Enabled.checked,
    ariaLabel: t('workspace.containers.ipv6Suffix'),
  });
  const randomIpv6 = button(t('workspace.containers.randomIpv6'), () => {
    ipv6Enabled.checked = true;
    ipv6Suffix.disabled = false;
    ipv6Suffix.value = randomIpv6Eui64Suffix();
  }, { className: 'button compact' });
  ipv6Enabled.addEventListener('change', () => {
    ipv6Suffix.disabled = !ipv6Enabled.checked;
  });
  return el('div', { className: 'network-settings' }, [
    field(t('workspace.containers.ipv4Enabled'), ipv4Enabled),
    field(t('workspace.containers.ipv6Enabled'), ipv6Enabled),
    el('div', { className: 'field' }, [
      el('span', { text: t('workspace.containers.ipv6Suffix') }),
      el('div', { className: 'inline-control' }, [ipv6Suffix, randomIpv6]),
    ]),
    el('p', { className: 'muted', text: t('workspace.containers.ipv6StableHelp') }),
    button(t('workspace.containers.applyNetwork'), async () => {
      if (!ipv4Enabled.checked && !ipv6Enabled.checked) {
        store.workspace.containerErrors = { ...store.workspace.containerErrors, [container.id]: t('workspace.containers.networkRequired') };
        refresh();
        return;
      }
      if (ipv6Enabled.checked && !ipv6Suffix.value.trim()) {
        store.workspace.containerErrors = { ...store.workspace.containerErrors, [container.id]: t('workspace.containers.ipv6SuffixRequired') };
        refresh();
        return;
      }
      await updateContainerNetwork(container, {
        ipv4Enabled: ipv4Enabled.checked,
        ipv6Enabled: ipv6Enabled.checked,
        ipv6Suffix: ipv6Enabled.checked ? ipv6Suffix.value.trim() : undefined,
      }, refresh);
    }, { className: 'button primary' }),
  ]);
}

async function updateContainerNetwork(container, network, refresh) {
  const containerId = container.id;
  if (store.workspace.containerPending?.[containerId]) return;
  store.workspace.containerPending = { ...store.workspace.containerPending, [containerId]: 'network' };
  store.workspace.containerNotice = t('workspace.containers.networkUpdating', { name: container.name || container.id });
  refresh();
  try {
    const result = await window.warController.containers.updateNetwork({ containerId, ...network });
    if (result?.ok === false || result?.data?.operation?.ok === false) {
      const failure = result?.ok === false ? result : { code: 'CONTAINER_NETWORK_FAILED', message: result.data.operation.error };
      store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(failure) };
    } else {
      const { [containerId]: _clearedError, ...remainingErrors } = store.workspace.containerErrors || {};
      store.workspace.containerErrors = remainingErrors;
      store.workspace.containerNotice = t('workspace.containers.networkUpdated');
      store.workspace.containerNetworkOpenId = '';
      await refreshAll();
    }
  } catch (error) {
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(error) };
  } finally {
    const { [containerId]: _clearedPending, ...remainingPending } = store.workspace.containerPending || {};
    store.workspace.containerPending = remainingPending;
    refresh();
  }
}

async function containerAction(action, container, refresh) {
  const containerId = container.id;
  if (store.workspace.containerPending?.[containerId]) return;
  if (action === 'delete') {
    const label = container.name || container.id;
    if (!window.confirm(t('workspace.containers.moveContainerToTrashConfirm', { name: label, id: container.id }))) return;
  }
  store.workspace.containerPending = { ...store.workspace.containerPending, [containerId]: action };
  store.workspace.containerNotice = t('workspace.containers.actionPending', { action: t(`workspace.containers.${action}`), name: container.name || container.id });
  refresh();
  try {
    const result = await window.warController.containers[action]({ containerId });
    const data = unwrap(result) || {};
    const operationFailed = data.operation?.ok === false;
    if (result?.ok === false || operationFailed) {
      const failure = operationFailed ? data.operation : result;
      store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(failure) };
      store.workspace.containerNotice = store.workspace.containerErrors[containerId];
    } else {
      const { [containerId]: _clearedError, ...remainingErrors } = store.workspace.containerErrors || {};
      store.workspace.containerErrors = remainingErrors;
      store.workspace.containerNotice = t('workspace.containers.actionDone');
      await refreshAll();
    }
  } catch (error) {
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(error) };
    store.workspace.containerNotice = store.workspace.containerErrors[containerId];
  } finally {
    const { [containerId]: _clearedPending, ...remainingPending } = store.workspace.containerPending || {};
    store.workspace.containerPending = remainingPending;
    refresh();
  }
}

async function refreshAllContainers(refresh) {
  if (store.workspace.containerAllPending || !store.containers.length) return;
  store.workspace.containerAllPending = true;
  store.workspace.containerNotice = t('workspace.containers.checkingAll');
  refresh();
  const failures = [];
  try {
    for (const container of store.containers) {
      if (container.status === 'deleted') continue;
      store.workspace.containerPending = { ...store.workspace.containerPending, [container.id]: 'refresh' };
      refresh();
      try {
        const result = await window.warController.containers.refresh({ containerId: container.id });
        if (result?.ok === false || result?.data?.operation?.ok === false) failures.push(container.name || container.id);
      } catch {
        failures.push(container.name || container.id);
      } finally {
        const { [container.id]: _removed, ...remaining } = store.workspace.containerPending || {};
        store.workspace.containerPending = remaining;
      }
    }
    await refreshAll();
    store.workspace.containerNotice = failures.length
      ? t('workspace.containers.checkAllPartial', { count: failures.length })
      : t('workspace.containers.checkAllDone');
  } finally {
    store.workspace.containerAllPending = false;
    refresh();
  }
}

async function duplicateContainer(container, refresh) {
  const containerId = container.id;
  if (store.workspace.containerPending?.[containerId]) return;
  store.workspace.containerPending = { ...store.workspace.containerPending, [containerId]: 'duplicate' };
  store.workspace.containerNotice = t('workspace.containers.actionPending', { action: t('workspace.containers.duplicate'), name: container.name || container.id });
  refresh();
  try {
    const result = await window.warController.containers.duplicate({ containerId: container.id, name: `${container.name || container.id} copy` });
    if (result?.ok === false) {
      store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(result) };
      store.workspace.containerNotice = store.workspace.containerErrors[containerId];
    } else {
      const { [containerId]: _clearedError, ...remainingErrors } = store.workspace.containerErrors || {};
      store.workspace.containerErrors = remainingErrors;
      store.workspace.containerNotice = t('workspace.containers.actionDone');
      await refreshAll();
    }
  } catch (error) {
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError(error) };
    store.workspace.containerNotice = store.workspace.containerErrors[containerId];
  } finally {
    const { [containerId]: _clearedPending, ...remainingPending } = store.workspace.containerPending || {};
    store.workspace.containerPending = remainingPending;
    refresh();
  }
}

function deviceList(devices, refresh) {
  return el('div', { className: 'device-list', role: 'listbox', ariaLabel: t('workspace.containers.title') },
    devices.map((device, index) => deviceCard(device, devices, index, refresh)));
}

function deviceCard(device, devices, index, refresh) {
  const id = device.id || device.deviceId;
  const status = normalizeDeviceStatus(device);
  const name = device.displayName || device.name || id || t('workspace.containers.unknown');
  const selected = store.workspace.selection.selectedIds.has(id);
  const group = groupNames(device.groupIds || []);
  const managedContainer = device.managedContainer
    ? store.containers.find((container) => container.id === device.containerId)
      || { id: device.containerId, name: device.containerName || name, status: device.status }
    : null;
  const deleteDisabled = !managedContainer
    || managedContainer.status === 'deleted'
    || managedContainer.status === 'deleting'
    || Boolean(store.workspace.containerPending?.[managedContainer.id]);
  const card = el('article', {
    className: selected ? 'device-card selected' : 'device-card',
    role: 'option',
    ariaSelected: selected,
    ariaLabel: `${name} ${t(`status.${status}`)}`,
    tabIndex: 0,
  }, [
    el('div', { className: 'device-card-head' }, [
      el('span', { className: 'device-name', text: name }),
      el('span', { className: `status-pill ${status}`, text: t(`status.${status}`) }),
      managedContainer ? button('×', async (event) => {
        event.stopPropagation?.();
        await containerAction('delete', managedContainer, refresh);
      }, {
        className: 'device-card-delete',
        disabled: deleteDisabled,
        ariaLabel: t('workspace.containers.moveContainerToTrashConfirm', { name, id: managedContainer.id }),
        title: t('workspace.containers.moveToTrash'),
      }) : null,
    ]),
    el('span', { className: 'device-meta', text: shortId(id) }),
    el('span', { className: 'device-meta', text: versionSummary(device) }),
    group ? el('span', { className: 'device-meta', text: group }) : null,
    el('span', { className: 'device-meta', text: device.lastSeenAt || t('workspace.containers.unknown') }),
    el('span', { className: 'origin-badge', text: t('workspace.containers.origin') }),
  ]);
  card.addEventListener('click', (event) => {
    store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, selectionAction(event, id));
    refresh();
  });
  card.addEventListener('keydown', (event) => {
    if (event.target?.localName === 'input' || event.target?.localName === 'textarea') return;
    if (event.key === ' ') {
      event.preventDefault();
      store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'toggle', id });
      refresh();
    } else if (event.key === 'Escape') {
      store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'clear' });
      refresh();
    } else if (event.key === 'a' && event.ctrlKey) {
      event.preventDefault();
      store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'selectAllVisible' });
      refresh();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const nextIndex = Math.min(devices.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
      store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'single', id: devices[nextIndex].id || devices[nextIndex].deviceId });
      refresh();
    }
  });
  return card;
}

function inputPane(selected, refresh, active = false) {
  const pane = el('section', { className: workspacePaneClass('input-pane', active), ariaLabel: t('workspace.input.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.input.title') }),
        el('p', { className: 'muted', text: t('workspace.input.draft') }),
      ]),
    ]),
    inputTabs(refresh),
    inputModeContent(selected, refresh),
    inputSummary(selected),
  ]);
  pane.setAttribute('data-scroll-key', 'workspace-input');
  return pane;
}

function inputTabs(refresh) {
  const modes = [
    ['text', t('workspace.input.text')],
    ['grid', t('workspace.input.grid')],
    ['picker', t('workspace.input.picker')],
  ];
  return el('div', { className: 'segmented', role: 'tablist', ariaLabel: t('workspace.input.title') }, modes.map(([mode, label]) => {
    const active = store.workspace.activeInputMode === mode;
    const tab = button(label, () => {
      store.workspace.activeInputMode = mode;
      refresh();
    }, { className: active ? 'segment active' : 'segment' });
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active));
    return tab;
  }));
}

function visibleWorkspaceDevices() {
  const query = store.workspace.search.trim().toLowerCase();
  const filter = store.workspace.deviceFilter || 'all';
  return allWorkspaceDevices().filter((device) => {
    const status = normalizeDeviceStatus(device);
    if (filter === 'online' && status !== 'online') return false;
    if (filter === 'offline' && status !== 'offline') return false;
    if (filter === 'containers' && !device.managedContainer) return false;
    if (!query) return true;
    const text = [device.id, device.deviceId, device.displayName, device.name, device.status].filter(Boolean).join(' ').toLowerCase();
    return text.includes(query);
  });
}

function allWorkspaceDevices() {
  const activeContainers = activeManagedContainers();
  const deletedDeviceIds = new Set(store.containers
    .filter((container) => container.status === 'deleted' && container.deviceId)
    .map((container) => container.deviceId));
  const managedByDevice = new Map(activeContainers.map((container) => [container.deviceId, container]));
  const devices = store.devices.filter((device) => !deletedDeviceIds.has(device.id || device.deviceId)).map((device) => {
    const container = managedByDevice.get(device.id || device.deviceId);
    return container ? { ...device, managedContainer: true, containerId: container.id, containerName: container.name, containerHost: container.host } : device;
  });
  const known = new Set(devices.map((device) => device.id || device.deviceId));
  return [...devices, ...activeContainers.filter((container) => !known.has(container.deviceId)).map((container) => ({
    ...container,
    id: container.deviceId || container.id,
    displayName: container.name,
    status: isContainerAgentOnline(container) ? 'online' : 'offline',
    agentVersion: container.image,
    groupIds: [],
    lastSeenAt: container.updatedAt,
    managedContainer: true,
    containerId: container.id,
    containerName: container.name,
    containerHost: container.host,
  }))];
}

function activeManagedContainers() {
  return store.containers.filter((container) => container.status !== 'deleted');
}

function selectionStatus() {
  const count = store.workspace.selection.selectedIds.size;
  if (count === 0) return t('workspace.containers.selectedNone');
  if (count === 1) return t('workspace.containers.selectedOne');
  return t('workspace.containers.selectedMany', { count });
}

function selectionAction(event, id) {
  if (event.shiftKey) return { type: 'range', id };
  if (event.ctrlKey || event.metaKey) return { type: 'toggle', id };
  return { type: 'single', id };
}

function latestContainerNamePrefix(containers = []) {
  for (let index = containers.length - 1; index >= 0; index -= 1) {
    const parsed = splitContainerDisplayName(containers[index]?.name);
    if (parsed) return parsed.prefix;
  }
  return '';
}

function nextContainerSequence(prefix, containers = []) {
  const normalizedPrefix = normalizeContainerNamePrefix(prefix);
  if (!normalizedPrefix) return 1;
  let maximum = 0;
  for (const container of containers) {
    const parsed = splitContainerDisplayName(container?.name);
    if (parsed?.prefix.toLocaleLowerCase() === normalizedPrefix.toLocaleLowerCase()) maximum = Math.max(maximum, parsed.sequence);
  }
  return maximum + 1;
}

function splitContainerDisplayName(value) {
  const match = String(value || '').trim().match(/^(.*?)\s+(\d+)$/);
  if (!match) return null;
  const prefix = normalizeContainerNamePrefix(match[1]);
  const sequence = parseContainerSequence(match[2]);
  return prefix && sequence ? { prefix, sequence } : null;
}

function normalizeContainerNamePrefix(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseContainerSequence(value) {
  const sequence = Number(value);
  return validContainerSequence(sequence) ? sequence : null;
}

function validContainerSequence(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= 999999;
}

function containerDisplayName(prefix, sequence) {
  return `${normalizeContainerNamePrefix(prefix)} ${sequence}`;
}

function containerHostLabel(host) {
  const status = host.connected ? t('workspace.containers.hostConnectedShort') : t('workspace.containers.hostRepairRequired');
  if (host.label) return `${host.label} - ${status}`;
  const runtime = host.runtime === 'local-docker'
    ? t('workspace.containers.localDockerHost')
    : t('workspace.containers.sshDockerHost');
  return `${runtime} - ${status}`;
}

function hostLabelFromId(hostId, container = null) {
  if (!hostId) return '';
  const host = (store.workspace.containerHosts || []).find((item) => item.id === hostId);
  return host?.label
    || container?.hostLabel
    || container?.runtime?.hostLabel
    || container?.runtime?.host
    || store.runtime?.containers?.hostLabel
    || store.runtime?.containers?.host
    || hostId;
}

function containerHostName(container) {
  return store.settings?.hostAliases?.[container?.host]
    || hostLabelFromId(container?.host, container)
    || t('workspace.containers.unknown');
}

function randomIpv6Eui64Suffix() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  bytes[0] = (bytes[0] & 0xfc) | 0x02;
  if (bytes[2] === 0) bytes[2] = 1;
  const groups = [
    ((bytes[0] ^ 0x02) << 8) | bytes[1],
    (bytes[2] << 8) | 0xff,
    (0xfe << 8) | bytes[3],
    (bytes[4] << 8) | bytes[5],
  ];
  return groups.map((group) => group.toString(16)).join(':');
}

function shortId(id) {
  if (!id) return t('workspace.containers.unknown');
  return String(id).length > 12 ? `${String(id).slice(0, 8)}...` : String(id);
}

function versionSummary(device) {
  const version = device.agentVersion || device.extensionVersion;
  if (!version) return t('workspace.containers.unknown');
  return device.agentVersion && device.extensionVersion
    ? `Agent ${device.agentVersion} / Ext ${device.extensionVersion}`
    : version;
}

function groupNames(groupIds) {
  if (!groupIds.length) return '';
  const names = groupIds.map((id) => store.groups.find((group) => group.id === id)?.name || id);
  return names.join(', ');
}

function usageSummary(resourceUsage) {
  if (!resourceUsage) return t('workspace.containers.usageUnavailable');
  const cpu = resourceUsage.cpuPercent === null || resourceUsage.cpuPercent === undefined ? '?' : `${resourceUsage.cpuPercent}%`;
  const mem = resourceUsage.memoryBytes ? `${Math.round(resourceUsage.memoryBytes / 1024 / 1024)} MiB` : '?';
  return `${cpu} / ${mem}`;
}

function containerNetworkSummary(container) {
  const runtime = container.runtime || {};
  const families = [runtime.ipv4Enabled !== false ? 'IPv4' : null, runtime.ipv6Enabled ? 'IPv6' : null].filter(Boolean).join(' + ');
  if (!runtime.ipv6Enabled) return families || t('workspace.containers.networkUnavailable');
  return `${families}: ${runtime.ipv6Address || runtime.ipv6Suffix || t('workspace.containers.unknown')}`;
}

function isContainerAgentOnline(container) {
  if (!container?.deviceId) return false;
  return store.sessions.some((session) => session.deviceId === container.deviceId && session.status === 'online' && !session.revoked);
}

function pendingStatus(action) {
  if (action === 'start') return 'starting';
  if (action === 'stop') return 'stopping';
  if (action === 'restart') return 'restarting';
  if (action === 'reconnect') return 'restarting';
  if (action === 'delete') return 'deleting';
  if (action === 'duplicate') return 'creating';
  if (action === 'network') return 'restarting';
  return 'creating';
}

function inputModeContent(selected, refresh) {
  if (store.workspace.activeInputMode === 'grid') return gridInputEditor(selected, refresh);
  if (store.workspace.activeInputMode === 'picker') return pickerInputEditor(selected, refresh);
  const textarea = el('textarea', {
    rows: 7,
    placeholder: 'group: 1\ndữ liệu ô 1|dữ liệu ô 2|dữ liệu ô 3 (máy 1)\ndữ liệu ô 1|dữ liệu ô 2|dữ liệu ô 3 (máy 2)',
    value: store.workspace.inputDraft || '',
  });
  const validation = el('p', { className: 'status', text: inputDraftValidation(store.workspace.inputDraft).message, ariaLive: 'polite' });
  textarea.addEventListener('input', () => {
    store.workspace.inputDraft = textarea.value;
    const result = inputDraftValidation(textarea.value);
    validation.className = result.ok ? 'status' : 'status error';
    validation.textContent = result.message;
  });
  textarea.addEventListener('change', refresh);
  return el('div', { className: 'input-mode' }, [
    field(t('workspace.input.textareaLabel'), textarea),
    el('p', { className: 'muted', text: `${t('workspace.input.separator')}: |` }),
    validation,
  ]);
}

function gridInputEditor(selected, refresh) {
  if (!selected.length) return el('div', { className: 'input-mode' }, [
    el('p', { className: 'empty-state', text: t('workspace.input.chooseMachine') }),
  ]);
  const header = el('thead', {}, [el('tr', {}, [
    el('th', { text: t('workspace.input.machine') }),
    el('th', { text: t('workspace.input.cell1') }),
    el('th', { text: t('workspace.input.cell2') }),
    el('th', { text: t('workspace.input.cell3') }),
  ])]);
  const body = el('tbody', {}, selected.map((device, rowIndex) => {
    const deviceId = device.id || device.deviceId;
    const values = gridDraftValues(deviceId);
    return el('tr', {}, [
      el('td', { text: device.displayName || device.name || deviceId || `${t('workspace.input.machine')} ${rowIndex + 1}` }),
      ...values.map((value, cellIndex) => {
        const input = el('input', {
          type: 'text',
          value,
          ariaLabel: `${t('workspace.input.machine')} ${rowIndex + 1}, ${t(`workspace.input.cell${cellIndex + 1}`)}`,
        });
        input.addEventListener('input', () => updateGridDraft(deviceId, cellIndex, input.value));
        input.addEventListener('change', refresh);
        return el('td', {}, [input]);
      }),
    ]);
  }));
  return el('div', { className: 'input-mode' }, [
    el('div', { className: 'group-chip', text: t('workspace.input.group') }),
    el('div', { className: 'table-scroll' }, [el('table', { className: 'data-table editable-grid' }, [header, body])]),
  ]);
}

function pickerInputEditor(selected, refresh) {
  const picked = new Set(store.workspace.pickedCells || []);
  return el('div', { className: 'input-mode picker-mode' }, [
    el('p', { text: selected.length ? t('workspace.input.chooseCellHelp') : t('workspace.input.chooseMachine') }),
    el('div', { className: 'toolbar tight' }, [1, 2, 3].map((cell) => button(t(`workspace.input.cell${cell}`), () => {
      if (picked.has(cell)) picked.delete(cell);
      else picked.add(cell);
      store.workspace.pickedCells = [...picked].sort();
      refresh();
    }, { className: `button chip${picked.has(cell) ? ' active' : ''}`, disabled: !selected.length }))),
    el('p', { text: t('workspace.input.pickedCount', { count: picked.size }) }),
    el('p', { className: 'muted', text: t('workspace.input.pickerLocalHelp') }),
  ]);
}

function inputSummary(selected) {
  const stats = workspaceInputStats(selected);
  return el('dl', { className: 'metric-grid compact-grid' }, [
    el('dt', { text: t('workspace.input.selectedMachines') }),
    el('dd', { text: selected.length }),
    el('dt', { text: t('workspace.input.groups') }),
    el('dd', { text: stats.groups }),
    el('dt', { text: t('workspace.input.targets') }),
    el('dd', { text: stats.targets }),
    el('dt', { text: t('workspace.input.totalValues') }),
    el('dd', { text: stats.totalValues }),
  ]);
}

function inputDraftValidation(value) {
  const stats = inputDraftStats(value);
  if (!String(value || '').trim()) return { ok: true, message: t('workspace.input.validationEmpty'), stats };
  if (stats.invalidRows.length) return {
    ok: false,
    message: t('workspace.input.validationMismatch', { rows: stats.invalidRows.join(', ') }),
    stats,
  };
  return { ok: true, message: t('workspace.input.validationValid', { rows: stats.rows, values: stats.totalValues }), stats };
}

function inputDraftStats(value) {
  const lines = String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const groupHeaders = lines.filter((line) => /^group\s*:/i.test(line));
  const rows = lines.filter((line) => !/^group\s*:/i.test(line)).map((line) => line.split('|').map((item) => item.trim()));
  const targets = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const invalidRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.length !== targets).map(({ index }) => index + 1);
  return {
    groups: groupHeaders.length || (rows.length ? 1 : 0),
    rows: rows.length,
    targets,
    totalValues: rows.reduce((total, row) => total + row.filter(Boolean).length, 0),
    invalidRows,
  };
}

function gridDraftValues(deviceId) {
  const values = store.workspace.inputGrid?.[deviceId];
  return [0, 1, 2].map((index) => String(values?.[index] || ''));
}

function updateGridDraft(deviceId, cellIndex, value) {
  const values = gridDraftValues(deviceId);
  values[cellIndex] = value;
  store.workspace.inputGrid = { ...store.workspace.inputGrid, [deviceId]: values };
}

function workspaceInputStats(selected) {
  if (store.workspace.activeInputMode === 'text') return inputDraftStats(store.workspace.inputDraft);
  if (store.workspace.activeInputMode === 'picker') {
    const targets = (store.workspace.pickedCells || []).length;
    return { groups: selected.length ? 1 : 0, targets, totalValues: selected.length * targets };
  }
  const values = selected.flatMap((device) => gridDraftValues(device.id || device.deviceId));
  return { groups: selected.length ? 1 : 0, targets: selected.length ? 3 : 0, totalValues: values.filter(Boolean).length };
}

function graphPane(refresh, active = false, resizeHandle = null) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const toggle = button(layout.graphCollapsed ? t('workspace.graph.expand') : t('workspace.graph.collapse'), async () => {
    store.settings.workspace = { ...layout, graphCollapsed: !layout.graphCollapsed };
    await window.warController.settings.update({ workspace: store.settings.workspace });
    refresh();
  }, { className: 'button compact' });
  const nodes = workspaceGraphNodes();
  const canvas = graphCanvas(nodes, refresh);
  const pane = el('section', { className: workspacePaneClass('graph-pane', active), ariaLabel: t('workspace.graph.title') }, [
    resizeHandle,
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.graph.title') }),
        el('p', { className: 'muted', text: t('workspace.graph.draftNotice') }),
      ]),
      toggle,
    ]),
    graphGroupToolbar(refresh),
    graphToolbar(canvas, nodes, refresh),
    layout.graphCollapsed ? el('p', { className: 'empty-state', text: t('workspace.graph.title') }) : canvas,
  ]);
  pane.setAttribute('data-scroll-key', 'workspace-graph');
  return pane;
}

function graphGroupToolbar(refresh) {
  const editing = store.workspace.graphEditMode !== false;
  const groups = graphInputGroups();
  return el('div', { className: 'graph-groups', role: 'toolbar', ariaLabel: t('workspace.graph.groups') }, [
    el('span', { className: 'graph-groups-label', text: t('workspace.graph.groups') }),
    ...groups.map((group) => {
      const active = group.id === (store.workspace.graphActiveGroupId || groups[0]?.id);
      const chip = button(`${group.name} (${group.nodeIds.length})`, () => {
        store.workspace.graphActiveGroupId = group.id;
        refresh();
      }, { className: `button chip${active ? ' active' : ''}`, disabled: editing });
      chip.setAttribute('aria-pressed', String(active));
      return chip;
    }),
    button('+', () => addGraphGroup(refresh), { className: 'button chip graph-group-add', disabled: editing, ariaLabel: t('workspace.graph.addGroup') }),
  ]);
}

function panelResizeHandle(root, options) {
  const { setting, cssVariable, min, max, label, className, refresh } = options;
  const handle = el('div', {
    className: `resize-handle ${className}`,
    role: 'separator',
    ariaLabel: label,
    ariaOrientation: 'vertical',
    ariaValueMin: min,
    ariaValueMax: max,
    ariaValueNow: clampWorkspaceLayout(store.settings?.workspace)[setting],
    tabIndex: 0,
  });

  const applyWidth = (value) => {
    root.style?.setProperty?.(cssVariable, `${value}px`);
    handle.setAttribute('aria-valuenow', String(value));
  };
  const persistWidth = async (value) => {
    const currentLayout = clampWorkspaceLayout(store.settings?.workspace);
    if (currentLayout[setting] === value) return;
    store.settings.workspace = { ...currentLayout, [setting]: value };
    await window.warController.settings.update({ workspace: store.settings.workspace });
    refresh();
  };

  handle.addEventListener('keydown', async (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -20 : 20;
    const layout = clampWorkspaceLayout(store.settings?.workspace);
    const nextValue = clampWorkspaceLayout({ ...layout, [setting]: layout[setting] + delta })[setting];
    applyWidth(nextValue);
    await persistWidth(nextValue);
  });

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault?.();
    const pointerId = event.pointerId;
    const layout = clampWorkspaceLayout(store.settings?.workspace);
    const initialValue = layout[setting];
    const initialX = Number(event.clientX) || 0;
    let nextValue = initialValue;
    let finished = false;

    try {
      if (pointerId !== undefined) handle.setPointerCapture?.(pointerId);
    } catch {
      // Global listeners still keep the drag bounded when pointer capture is unavailable.
    }
    setClassToken(handle, 'is-resizing', true);
    setClassToken(root, 'is-panel-resizing', true);

    const cleanup = () => {
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', finish);
      globalThis.removeEventListener?.('pointercancel', cancel);
      setClassToken(handle, 'is-resizing', false);
      setClassToken(root, 'is-panel-resizing', false);
      try {
        if (pointerId !== undefined && (!handle.hasPointerCapture || handle.hasPointerCapture(pointerId))) {
          handle.releasePointerCapture?.(pointerId);
        }
      } catch {
        // Capture may already be released by the platform on cancellation.
      }
    };
    const move = (moveEvent) => {
      if (pointerId !== undefined && moveEvent.pointerId !== undefined && moveEvent.pointerId !== pointerId) return;
      const candidate = initialValue + ((Number(moveEvent.clientX) || 0) - initialX);
      nextValue = clampWorkspaceLayout({ ...layout, [setting]: Math.round(candidate) })[setting];
      applyWidth(nextValue);
    };
    const finish = async (upEvent) => {
      if (finished || (pointerId !== undefined && upEvent.pointerId !== undefined && upEvent.pointerId !== pointerId)) return;
      finished = true;
      cleanup();
      await persistWidth(nextValue);
    };
    const cancel = (cancelEvent) => {
      if (finished || (pointerId !== undefined && cancelEvent.pointerId !== undefined && cancelEvent.pointerId !== pointerId)) return;
      finished = true;
      cleanup();
      applyWidth(initialValue);
    };

    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', finish);
    globalThis.addEventListener?.('pointercancel', cancel);
  });
  return handle;
}

function setClassToken(node, token, enabled) {
  const tokens = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
  if (enabled) tokens.add(token);
  else tokens.delete(token);
  node.className = [...tokens].join(' ');
}

function graphToolbar(canvas, nodes, refresh) {
  const viewport = normalizeGraphViewport(store.workspace.graphViewport);
  const editing = store.workspace.graphEditMode !== false;
  return el('div', { className: 'graph-toolbar', role: 'toolbar', ariaLabel: t('workspace.graph.title') }, [
    button(editing ? t('workspace.graph.editing') : t('workspace.graph.editMode'), () => {
      store.workspace.graphEditMode = !editing;
      store.workspace.graphConnectingFrom = '';
      refresh();
    }, { className: `button compact ${editing ? 'primary' : ''}` }),
    button(t('workspace.graph.addStep'), () => addWorkspaceGraphNode(refresh), { className: 'button compact primary', disabled: !editing }),
    button(t('workspace.graph.zoomIn'), () => zoomGraphViewport(canvas, 0.1, refresh), { className: 'button compact' }),
    button(t('workspace.graph.zoomOut'), () => zoomGraphViewport(canvas, -0.1, refresh), { className: 'button compact' }),
    button(t('workspace.graph.fit'), () => fitGraphViewport(canvas, refresh, nodes), { className: 'button compact' }),
    button(t('workspace.graph.reset'), () => resetGraphViewport(refresh), { className: 'button compact' }),
    button(t('workspace.graph.restore'), () => restoreWorkspaceGraph(refresh), { className: 'button compact', disabled: !editing }),
    button(t('workspace.graph.undo'), () => undoWorkspaceGraph(refresh), { className: 'button compact', disabled: !editing || !store.workspace.graphHistory.length }),
    button(t('workspace.graph.redo'), () => redoWorkspaceGraph(refresh), { className: 'button compact', disabled: !editing || !store.workspace.graphFuture.length }),
    el('span', { className: 'graph-zoom-status', text: `${Math.round(viewport.scale * 100)}%` }),
    el('span', { className: 'graph-pan-help', text: t('workspace.graph.panHelp') }),
  ]);
}

function graphCanvas(nodes, refresh) {
  const viewport = normalizeGraphViewport(store.workspace.graphViewport);
  const stage = el('div', { className: 'graph-stage' }, [
    edgeLayer(nodes),
    ...nodes.map((node) => graphNode(node, refresh)),
  ]);
  stage.style?.setProperty('--graph-scale', String(viewport.scale));
  stage.style?.setProperty('--graph-offset-x', `${viewport.offsetX}px`);
  stage.style?.setProperty('--graph-offset-y', `${viewport.offsetY}px`);
  const canvas = el('div', { className: 'graph-canvas', tabIndex: 0, ariaLabel: t('workspace.graph.title') }, [stage]);
  installGraphCanvasPan(canvas, stage, refresh);
  canvas.addEventListener('wheel', (event) => {
    if (graphControlConsumesPointer(event.target)) return;
    const deltaY = Number(event.deltaY);
    if (!Number.isFinite(deltaY) || deltaY === 0) return;
    event.preventDefault?.();
    const rect = canvas.getBoundingClientRect?.() || { left: 0, top: 0 };
    const clientX = Number(event.clientX);
    const clientY = Number(event.clientY);
    zoomGraphViewport(canvas, deltaY < 0 ? 0.1 : -0.1, refresh, {
      x: Number.isFinite(clientX) ? clientX - Number(rect.left || 0) : undefined,
      y: Number.isFinite(clientY) ? clientY - Number(rect.top || 0) : undefined,
    });
  }, { passive: false });
  canvas.addEventListener('keydown', (event) => {
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomGraphViewport(canvas, 0.1, refresh);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomGraphViewport(canvas, -0.1, refresh);
    } else if (event.key === '0') {
      event.preventDefault();
      resetGraphViewport(refresh);
    }
  });
  scheduleInitialGraphFit(canvas, refresh, nodes);
  return canvas;
}

function edgeLayer(nodes) {
  const lookup = new Map(nodes.map((node) => [node.id, node]));
  const paths = graphEdges().map((edge) => {
    const from = lookup.get(edge.from);
    const to = lookup.get(edge.to);
    if (!from || !to) return null;
    return svgEl('path', { class: 'graph-edge', d: graphEdgePath(from, to), 'data-from': edge.from, 'data-to': edge.to });
  }).filter(Boolean);
  return svgEl('svg', { class: 'graph-edges', width: 2400, height: 1600, viewBox: '0 0 2400 1600', 'aria-label': t('workspace.graph.connections') }, [
    svgEl('defs', {}, [svgEl('marker', { id: 'graph-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' }, [svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'currentColor' })])]),
    ...paths,
    store.workspace.graphConnectingFrom ? svgEl('path', { class: 'graph-edge graph-preview', d: graphEdgePath(lookup.get(store.workspace.graphConnectingFrom), { x: 760, y: 320 }) }) : null,
  ]);
}

function graphNode(node, refresh) {
  const selected = store.workspace.graphSelectedNodeId === node.id;
  const editing = store.workspace.graphEditMode !== false;
  const title = el('input', { type: 'text', value: node.title, ariaLabel: t('workspace.graph.stepName'), disabled: !editing });
  const delay = el('input', { type: 'number', value: node.delay, min: 0, max: 3600000, step: 50, ariaLabel: t('workspace.graph.delay'), disabled: !editing });
  const body = el('input', { type: 'text', value: node.body, ariaLabel: t('workspace.graph.body'), disabled: !editing });
  const removeLabel = t('workspace.graph.deleteAction', { name: node.title });
  const remove = button('×', (event) => {
    event.stopPropagation?.();
    removeWorkspaceGraphNode(node.id, refresh);
  }, { className: 'node-delete', disabled: !editing });
  remove.title = removeLabel;
  remove.setAttribute('aria-label', removeLabel);
  for (const control of [title, delay, body, remove]) {
    control.addEventListener('click', (event) => event.stopPropagation?.());
  }
  title.addEventListener('change', () => updateWorkspaceGraphNode(node.id, { title: title.value.trim() || node.title }, refresh));
  delay.addEventListener('change', () => updateWorkspaceGraphNode(node.id, { delay: normalizeGraphDelay(delay.value) }, refresh));
  body.addEventListener('change', () => updateWorkspaceGraphNode(node.id, { body: body.value }, refresh));
  const item = el('article', {
    className: `graph-node ${node.type}${selected ? ' selected' : ''}${editing ? ' edit-mode' : ' select-mode'}`,
    role: 'group',
    tabIndex: 0,
    ariaLabel: `${t('workspace.graph.step')} ${node.title}`,
  }, [
    el('div', { className: 'graph-node-header' }, [
      title,
      remove,
      el('span', { className: 'origin-badge strong', text: t('workspace.containers.origin') }),
    ]),
    el('div', { className: 'graph-node-body' }, [
      el('span', { className: 'port input-port', text: '' }),
      el('div', { className: 'delay-field' }, [
        el('span', { text: `${t('workspace.graph.delay')}:` }),
        delay,
        el('span', { text: 'ms' }),
      ]),
      el('span', { className: 'order-badge', text: graphNodeBadge(node) }),
      body,
      el('span', { className: 'port output-port', text: '' }),
    ]),
  ]);
  if (item.style?.setProperty) {
    item.style.setProperty('--node-x', `${node.x}px`);
    item.style.setProperty('--node-y', `${node.y}px`);
  }
  item.setAttribute('data-node-id', node.id);
  const inputPort = item.childNodes?.[1]?.childNodes?.[0];
  const outputPort = item.childNodes?.[1]?.childNodes?.[4];
  if (inputPort) {
    inputPort.setAttribute('data-port', 'input');
    inputPort.setAttribute('role', 'button');
    inputPort.setAttribute('aria-label', t('workspace.graph.connectInput', { name: node.title }));
    inputPort.tabIndex = editing ? 0 : -1;
    inputPort.addEventListener('pointerup', (event) => finishGraphConnection(node.id, event, refresh));
  }
  if (outputPort) {
    outputPort.setAttribute('data-port', 'output');
    outputPort.setAttribute('role', 'button');
    outputPort.setAttribute('aria-label', t('workspace.graph.connectOutput', { name: node.title }));
    outputPort.tabIndex = editing ? 0 : -1;
    outputPort.addEventListener('pointerdown', (event) => startGraphConnection(node.id, event, refresh));
  }
  item.addEventListener('click', () => {
    if (!editing && graphNodeAcceptsGroupedInput(node)) toggleGraphGroupNode(node.id, refresh);
    else selectGraphNode(node.id, refresh);
  });
  installGraphNodeDrag(item, node, refresh, editing);
  item.addEventListener('keydown', (event) => {
    if (event.target !== item) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!editing && graphNodeAcceptsGroupedInput(node)) toggleGraphGroupNode(node.id, refresh);
    else selectGraphNode(node.id, refresh);
  });
  item.setAttribute('data-groupable', String(graphNodeAcceptsGroupedInput(node)));
  return item;
}

function workspaceGraphNodes() {
  const nodes = Array.isArray(store.workspace.graphDraftNodes) ? store.workspace.graphDraftNodes : [];
  return nodes.map((node) => ({ ...node }));
}

function graphSnapshot(nodes = workspaceGraphNodes()) {
  return {
    nodes: nodes.map((node) => ({ ...node })),
    edges: graphEdges().map((edge) => ({ ...edge })),
    groups: graphInputGroups().map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
  };
}

function commitWorkspaceGraph(nextNodes, refresh, nextEdges = graphEdges(), nextGroups = graphInputGroups(), activeGroupId = '') {
  const current = graphSnapshot();
  const next = {
    nodes: nextNodes.map((node) => ({ ...node })),
    edges: nextEdges.map((edge) => ({ ...edge })),
    groups: nextGroups.map((group) => ({ ...group, nodeIds: [...group.nodeIds] })),
  };
  if (JSON.stringify(current) === JSON.stringify(next)) return;
  store.workspace.graphHistory = [...store.workspace.graphHistory.slice(-49), current];
  store.workspace.graphFuture = [];
  store.workspace.graphDraftNodes = next.nodes;
  store.workspace.graphDraftEdges = next.edges;
  store.workspace.graphInputGroups = next.groups;
  if (activeGroupId && next.groups.some((group) => group.id === activeGroupId)) {
    store.workspace.graphActiveGroupId = activeGroupId;
  }
  if (!next.nodes.some((node) => node.id === store.workspace.graphSelectedNodeId)) {
    store.workspace.graphSelectedNodeId = next.nodes[0]?.id || '';
  }
  refresh();
}

function updateWorkspaceGraphNode(nodeId, patch, refresh) {
  commitWorkspaceGraph(workspaceGraphNodes().map((node) => node.id === nodeId ? { ...node, ...patch } : node), refresh);
}

function removeWorkspaceGraphNode(nodeId, refresh) {
  const nextGroups = graphInputGroups().map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }));
  const nextEdges = graphEdges().filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
  commitWorkspaceGraph(workspaceGraphNodes().filter((node) => node.id !== nodeId), refresh, nextEdges, nextGroups);
}

function addWorkspaceGraphNode(refresh) {
  const nodes = workspaceGraphNodes();
  let sequence = nodes.length + 1;
  while (nodes.some((node) => node.id === `draft-step-${sequence}`)) sequence += 1;
  const column = nodes.length % 3;
  const row = Math.floor(nodes.length / 3);
  const node = {
    id: `draft-step-${sequence}`,
    type: 'input',
    title: t('workspace.graph.newStep', { count: sequence }),
    delay: 250,
    body: t('workspace.graph.newStepBody'),
    badge: '',
    x: 110 + column * 410,
    y: 54 + row * 220,
  };
  store.workspace.graphSelectedNodeId = node.id;
  commitWorkspaceGraph([...nodes, node], refresh, graphEdges(), graphInputGroups());
}

function restoreWorkspaceGraph(refresh) {
  const groups = [{ id: 'group-1', name: `${t('workspace.graph.groupDefault')} 1`, nodeIds: [] }];
  commitWorkspaceGraph(WORKSPACE_SAMPLE_NODES, refresh, [
    { from: 'sample-switch', to: 'sample-click' },
    { from: 'sample-click', to: 'sample-input' },
  ], groups);
}

function undoWorkspaceGraph(refresh) {
  if (!store.workspace.graphHistory.length) return;
  const history = [...store.workspace.graphHistory];
  const previous = history.pop();
  const current = graphSnapshot();
  store.workspace.graphFuture = [current, ...store.workspace.graphFuture].slice(0, 50);
  store.workspace.graphHistory = history;
  const snapshot = normalizeGraphSnapshot(previous);
  store.workspace.graphDraftNodes = snapshot.nodes;
  store.workspace.graphDraftEdges = snapshot.edges;
  store.workspace.graphInputGroups = snapshot.groups;
  reconcileGraphSelection(store.workspace.graphDraftNodes);
  refresh();
}

function redoWorkspaceGraph(refresh) {
  if (!store.workspace.graphFuture.length) return;
  const [next, ...future] = store.workspace.graphFuture;
  store.workspace.graphHistory = [...store.workspace.graphHistory.slice(-49), graphSnapshot()];
  store.workspace.graphFuture = future;
  const snapshot = normalizeGraphSnapshot(next);
  store.workspace.graphDraftNodes = snapshot.nodes;
  store.workspace.graphDraftEdges = snapshot.edges;
  store.workspace.graphInputGroups = snapshot.groups;
  reconcileGraphSelection(store.workspace.graphDraftNodes);
  refresh();
}

function reconcileGraphSelection(nodes) {
  if (!nodes.some((node) => node.id === store.workspace.graphSelectedNodeId)) {
    store.workspace.graphSelectedNodeId = nodes[0]?.id || '';
  }
}

function normalizeGraphDelay(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay)) return 0;
  return Math.max(0, Math.min(3600000, Math.round(delay)));
}

function selectGraphNode(nodeId, refresh) {
  store.workspace.graphSelectedNodeId = nodeId;
  refresh();
}

function graphEdges() {
  return Array.isArray(store.workspace.graphDraftEdges) ? store.workspace.graphDraftEdges : [];
}

function graphInputGroups() {
  const groups = Array.isArray(store.workspace.graphInputGroups) && store.workspace.graphInputGroups.length
    ? store.workspace.graphInputGroups
    : [{ id: 'group-1', name: '', nodeIds: [] }];
  store.workspace.graphInputGroups = groups.map((group, index) => ({
    id: group.id || `group-${index + 1}`,
    name: group.name || `${t('workspace.graph.groupDefault')} ${index + 1}`,
    nodeIds: Array.isArray(group.nodeIds) ? [...new Set(group.nodeIds)] : [],
  }));
  if (!store.workspace.graphActiveGroupId || !store.workspace.graphInputGroups.some((group) => group.id === store.workspace.graphActiveGroupId)) {
    store.workspace.graphActiveGroupId = store.workspace.graphInputGroups[0].id;
  }
  return store.workspace.graphInputGroups;
}

function addGraphGroup(refresh) {
  if (store.workspace.graphEditMode !== false) return;
  const groups = graphInputGroups();
  const id = `group-${groups.length + 1}`;
  const next = [...groups, { id, name: `${t('workspace.graph.groupDefault')} ${groups.length + 1}`, nodeIds: [] }];
  commitWorkspaceGraph(workspaceGraphNodes(), refresh, graphEdges(), next, id);
}

function toggleGraphGroupNode(nodeId, refresh) {
  const node = workspaceGraphNodes().find((item) => item.id === nodeId);
  if (!graphNodeAcceptsGroupedInput(node)) {
    selectGraphNode(nodeId, refresh);
    return;
  }
  const groups = graphInputGroups();
  const activeId = store.workspace.graphActiveGroupId || groups[0].id;
  const active = groups.find((group) => group.id === activeId) || groups[0];
  const alreadyInActive = active.nodeIds.includes(nodeId);
  const next = groups.map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) }));
  if (!alreadyInActive) next.find((group) => group.id === active.id).nodeIds.push(nodeId);
  store.workspace.graphInputGroups = next;
  store.workspace.graphSelectedNodeId = nodeId;
  refresh();
}

function graphNodeAcceptsGroupedInput(node) {
  return Boolean(node && Object.prototype.hasOwnProperty.call(node, 'body'));
}

function graphNodeBadge(node) {
  const group = graphInputGroups().find((item) => item.nodeIds.includes(node.id));
  if (!group) return t('workspace.graph.unassigned');
  return `${group.nodeIds.indexOf(node.id) + 1} : ${group.name}`;
}

function normalizeGraphSnapshot(snapshot) {
  if (Array.isArray(snapshot)) return { nodes: snapshot.map((node) => ({ ...node })), edges: graphEdges(), groups: graphInputGroups() };
  return {
    nodes: Array.isArray(snapshot?.nodes) ? snapshot.nodes.map((node) => ({ ...node })) : [],
    edges: Array.isArray(snapshot?.edges) ? snapshot.edges.map((edge) => ({ ...edge })) : [],
    groups: Array.isArray(snapshot?.groups) ? snapshot.groups.map((group) => ({ ...group, nodeIds: [...(group.nodeIds || [])] })) : graphInputGroups(),
  };
}

function graphPortPoint(node, side) {
  return { x: node.x + (side === 'output' ? 364 : -4), y: node.y + 88 };
}

function graphEdgePath(from, to) {
  if (!from || !to) return '';
  const start = graphPortPoint(from, 'output');
  const end = graphPortPoint(to, 'input');
  const bend = Math.max(80, Math.abs(end.x - start.x) * 0.45);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function installGraphNodeDrag(item, node, refresh, editing) {
  if (!editing) return;
  const header = item.childNodes?.[0];
  header?.addEventListener?.('pointerdown', (event) => {
    if (event.target?.localName === 'input' || event.target?.localName === 'button') return;
    event.preventDefault?.();
    const scale = normalizeGraphViewport(store.workspace.graphViewport).scale;
    const startX = Number(event.clientX) || 0;
    const startY = Number(event.clientY) || 0;
    const original = { x: node.x, y: node.y };
    let moved = false;
    const move = (moveEvent) => {
      moved = true;
      const x = Math.max(12, original.x + ((Number(moveEvent.clientX) || 0) - startX) / scale);
      const y = Math.max(12, original.y + ((Number(moveEvent.clientY) || 0) - startY) / scale);
      item.style?.setProperty('--node-x', `${x}px`);
      item.style?.setProperty('--node-y', `${y}px`);
    };
    const up = (upEvent) => {
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', up);
      if (!moved) return;
      const x = Math.max(12, original.x + ((Number(upEvent.clientX) || 0) - startX) / scale);
      const y = Math.max(12, original.y + ((Number(upEvent.clientY) || 0) - startY) / scale);
      updateWorkspaceGraphNode(node.id, { x, y }, refresh);
    };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', up, { once: true });
  });
}

function startGraphConnection(nodeId, event, refresh) {
  if (store.workspace.graphEditMode === false) return;
  event.preventDefault?.();
  store.workspace.graphConnectingFrom = nodeId;
  refresh();
  const move = (moveEvent) => {
    const preview = document.querySelector?.('.graph-preview');
    const from = workspaceGraphNodes().find((node) => node.id === nodeId);
    if (!preview || !from) return;
    const canvas = document.querySelector?.('.graph-canvas');
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return;
    const viewport = normalizeGraphViewport(store.workspace.graphViewport);
    const target = { x: (moveEvent.clientX - rect.left - viewport.offsetX) / viewport.scale, y: (moveEvent.clientY - rect.top - viewport.offsetY) / viewport.scale };
    preview.setAttribute('d', graphEdgePath(from, target));
  };
  const cancel = () => {
    globalThis.removeEventListener?.('pointermove', move);
    globalThis.removeEventListener?.('pointerup', up);
    globalThis.removeEventListener?.('pointercancel', cancel);
    store.workspace.graphConnectingFrom = '';
    refresh();
  };
  const up = () => cancel();
  globalThis.addEventListener?.('pointermove', move);
  globalThis.addEventListener?.('pointerup', up, { once: true });
  globalThis.addEventListener?.('pointercancel', cancel, { once: true });
}

function finishGraphConnection(nodeId, _event, refresh) {
  const from = store.workspace.graphConnectingFrom;
  if (!from || from === nodeId || store.workspace.graphEditMode === false) return;
  store.workspace.graphConnectingFrom = '';
  if (!graphEdges().some((edge) => edge.from === from && edge.to === nodeId)) {
    commitWorkspaceGraph(workspaceGraphNodes(), refresh, [...graphEdges(), { from, to: nodeId }], graphInputGroups());
  }
}

function normalizeGraphViewport(value = {}) {
  const scale = Number(value.scale);
  const offsetX = Number(value.offsetX);
  const offsetY = Number(value.offsetY);
  return {
    scale: Number.isFinite(scale) ? Math.max(0.5, Math.min(1.6, scale)) : 1,
    offsetX: Number.isFinite(offsetX) ? Math.max(-2000, Math.min(2000, offsetX)) : 0,
    offsetY: Number.isFinite(offsetY) ? Math.max(-2000, Math.min(2000, offsetY)) : 0,
  };
}

function installGraphCanvasPan(canvas, stage, refresh) {
  canvas.addEventListener('pointerdown', (event) => {
    if (event.target !== canvas && event.target !== stage) return;
    event.preventDefault?.();
    const startX = Number(event.clientX) || 0;
    const startY = Number(event.clientY) || 0;
    const original = normalizeGraphViewport(store.workspace.graphViewport);
    let latest = original;
    let moved = false;
    canvas.className = `${canvas.className} panning`;

    const move = (moveEvent) => {
      const x = Number(moveEvent.clientX) || 0;
      const y = Number(moveEvent.clientY) || 0;
      moved ||= x !== startX || y !== startY;
      latest = normalizeGraphViewport({
        ...original,
        offsetX: original.offsetX + x - startX,
        offsetY: original.offsetY + y - startY,
      });
      stage.style?.setProperty('--graph-offset-x', `${latest.offsetX}px`);
      stage.style?.setProperty('--graph-offset-y', `${latest.offsetY}px`);
    };
    const finish = () => {
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', finish);
      globalThis.removeEventListener?.('pointercancel', cancel);
      canvas.className = canvas.className.replace(/\s+panning\b/g, '');
      if (!moved) return;
      store.workspace.graphViewport = latest;
      store.workspace.graphViewportInitialized = true;
      refresh();
    };
    const cancel = () => {
      globalThis.removeEventListener?.('pointermove', move);
      globalThis.removeEventListener?.('pointerup', finish);
      globalThis.removeEventListener?.('pointercancel', cancel);
      canvas.className = canvas.className.replace(/\s+panning\b/g, '');
      stage.style?.setProperty('--graph-offset-x', `${original.offsetX}px`);
      stage.style?.setProperty('--graph-offset-y', `${original.offsetY}px`);
    };
    globalThis.addEventListener?.('pointermove', move);
    globalThis.addEventListener?.('pointerup', finish, { once: true });
    globalThis.addEventListener?.('pointercancel', cancel, { once: true });
  });
}

function graphControlConsumesPointer(target) {
  return ['input', 'button', 'select', 'textarea'].includes(target?.localName)
    || Boolean(target?.getAttribute?.('data-port'));
}

function zoomGraphViewport(canvas, delta, refresh, anchor = null) {
  const current = normalizeGraphViewport(store.workspace.graphViewport);
  const scale = Math.max(0.5, Math.min(1.6, Number((current.scale + delta).toFixed(2))));
  const width = Number(canvas?.clientWidth) || 900;
  const height = Number(canvas?.clientHeight) || 620;
  const ratio = scale / current.scale;
  const anchorX = Number.isFinite(Number(anchor?.x)) ? Number(anchor.x) : width / 2;
  const anchorY = Number.isFinite(Number(anchor?.y)) ? Number(anchor.y) : height / 2;
  store.workspace.graphViewport = normalizeGraphViewport({
    scale,
    offsetX: anchorX - (anchorX - current.offsetX) * ratio,
    offsetY: anchorY - (anchorY - current.offsetY) * ratio,
  });
  store.workspace.graphViewportInitialized = true;
  refresh();
}

function fitGraphViewport(canvas, refresh, nodes = workspaceGraphNodes()) {
  const width = Math.max(320, Number(canvas?.clientWidth) || 900);
  const height = Math.max(320, Number(canvas?.clientHeight) || 620);
  const bounds = sampleGraphBounds(nodes);
  const scale = Math.max(0.5, Math.min(1.4, Math.min((width - 48) / bounds.width, (height - 48) / bounds.height)));
  store.workspace.graphViewport = {
    scale,
    offsetX: (width - bounds.width * scale) / 2 - bounds.left * scale,
    offsetY: (height - bounds.height * scale) / 2 - bounds.top * scale,
  };
  store.workspace.graphViewportInitialized = true;
  refresh();
}

function resetGraphViewport(refresh) {
  store.workspace.graphViewport = { scale: 1, offsetX: 0, offsetY: 0 };
  store.workspace.graphViewportInitialized = true;
  refresh();
}

function scheduleInitialGraphFit(canvas, refresh, nodes) {
  if (store.workspace.graphViewportInitialized || typeof globalThis.requestAnimationFrame !== 'function') return;
  globalThis.requestAnimationFrame(() => {
    if (store.workspace.graphViewportInitialized || !canvas?.clientWidth || !canvas?.clientHeight) return;
    fitGraphViewport(canvas, refresh, nodes);
  });
}

function sampleGraphBounds(nodes = workspaceGraphNodes()) {
  if (!nodes.length) return { left: 0, top: 0, width: 360, height: 160 };
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + 360));
  const bottom = Math.max(...nodes.map((node) => node.y + 160));
  return { left, top, width: right - left, height: bottom - top };
}

function overviewView(refresh) {
  const runtime = store.runtime || {};
  const bootstrap = store.bootstrap || {};
  return section('Overview', [
    metricGrid([
      ['Controller runtime state', runtime.status || 'unknown'],
      ['WSS', runtime.enabled ? 'enabled' : runtime.status || 'disabled'],
      ['Safe bind', `${runtime.bindHost || '127.0.0.1'}:${runtime.port ?? 0}`],
      ['Devices', bootstrap.deviceCount ?? store.devices.length],
      ['Active sessions', bootstrap.sessionCount ?? store.sessions.length],
      ['Groups', bootstrap.groupCount ?? store.groups.length],
      ['Workflows', bootstrap.workflowCount ?? store.workflows.length],
      ['Recent jobs', store.jobs.length],
    ]),
    el('h3', { text: 'Recent jobs' }),
    table([
      { key: 'id', label: 'Job' },
      { key: 'status', label: 'Execution status' },
      { key: 'delivery', label: 'Transport delivery' },
      { key: 'deviceId', label: 'Device' },
    ], store.jobs.slice(0, 8).map((job) => ({ ...job, delivery: job.transport?.delivered ? 'delivered' : 'persisted or warning' }))),
    button('Refresh', refresh),
  ]);
}

function pairingView(refresh) {
  const descriptor = el('textarea', { rows: 10, placeholder: '{...DeviceDescriptor JSON...}' });
  const display = el('input', { type: 'text', placeholder: 'Optional display name' });
  const code = el('input', { type: 'text', placeholder: 'Pairing code' });
  const status = el('p', { className: 'status' });
  status.textContent = pairingNotice;
  const secretBox = el('pre', { className: 'secret-box' });
  secretBox.textContent = oneTimeSecret || 'No one-time credential displayed';
  const activeAgents = store.pairings.paired.filter((agent) => !agent.revokedAt);
  const revokedAgents = store.pairings.paired.filter((agent) => agent.revokedAt);
  return section('Pairing', [
    field('DeviceDescriptor JSON', descriptor),
    field('Display name override', display),
    el('div', { className: 'toolbar' }, [
      button('Import JSON', async () => {
        const result = unwrap(await window.warController.dialogs.importDeviceDescriptor());
        if (!result?.canceled) {
          descriptor.value = stableJson(result.value);
          if (result.value?.displayName) display.value = result.value.displayName;
        }
      }),
      button('Request pairing', async () => {
        try {
          const device = parseJsonInput(descriptor.value);
          const result = await window.warController.pairings.request({ device, displayName: display.value || undefined });
          pairingNotice = `Pairing requested. Code: ${unwrap(result)?.code || ''}`;
          setStatus(status, result, pairingNotice);
          await refreshAll();
          refresh();
        } catch (error) {
          pairingNotice = error.message;
          status.textContent = error.message;
        }
      }),
    ]),
    field('Pairing code', code),
    el('div', { className: 'toolbar' }, [
      button('Clear one-time credential', () => { oneTimeSecret = null; secretBox.textContent = 'Cleared'; }),
    ]),
    status,
    el('h3', { text: 'Pending pairings' }),
    ...store.pairings.pending.map((item) => pairingRow(item, code, refresh, secretBox, status)),
    el('h3', { text: 'Paired agents' }),
    table([
      { key: 'deviceId', label: 'Device' },
      { key: 'pairedAt', label: 'Paired at' },
      { key: 'revokedAt', label: 'Revoked at' },
      { key: 'sessionStatus', label: 'Session' },
    ], activeAgents.map((agent) => ({ ...agent, sessionStatus: sessionForDevice(agent.deviceId)?.status || 'offline' }))),
    ...activeAgents.map((agent) => pairingAgentActions(agent, refresh, status)),
    revokedAgents.length ? el('h3', { text: 'Revoked pairing history' }) : null,
    revokedAgents.length ? table([
      { key: 'deviceId', label: 'Device' },
      { key: 'revokedAt', label: 'Revoked at' },
    ], revokedAgents) : null,
    el('h3', { text: 'One-time credential' }),
    secretBox,
  ]);
}

function sessionForDevice(deviceId) {
  return store.sessions.find((session) => session.deviceId === deviceId) || null;
}

function pairingAgentActions(agent, refresh, status) {
  const busy = store.diagnosticsPending;
  return el('div', { className: 'row-actions' }, [
    el('span', { text: agent.deviceId }),
    button('Reconnect', async () => {
      try {
        const result = await window.warController.pairings.reconnect({ deviceId: agent.deviceId });
        setStatus(status, result, 'Reconnect requested');
        await refreshAll();
        refresh();
      } catch (error) { status.textContent = safeError(error, 'PAIRING_RECONNECT_FAILED'); }
    }, { disabled: busy || Boolean(agent.revokedAt) }),
    button('Delete', async () => {
      if (!window.confirm(`Delete pairing ${agent.deviceId}?`)) return;
      try {
        const result = await window.warController.pairings.revoke({ deviceId: agent.deviceId });
        setStatus(status, result, 'Pairing deleted');
        await refreshAll();
        refresh();
      } catch (error) { status.textContent = safeError(error, 'PAIRING_DELETE_FAILED'); }
    }, { className: 'button danger', disabled: busy || Boolean(agent.revokedAt) }),
  ]);
}

function pairingRow(item, codeInput, refresh, secretBox, status) {
  return el('div', { className: 'item-row' }, [
    el('div', {}, [
      el('strong', { text: item.displayName || item.requestId }),
      el('p', { text: `${item.requestId} expires ${item.expiresAt}` }),
    ]),
    el('div', { className: 'toolbar' }, [
      button('Confirm', async () => {
        const result = await window.warController.pairings.confirm({ requestId: item.requestId, code: codeInput.value });
        const data = unwrap(result);
        oneTimeSecret = data?.credential || null;
        pairingNotice = 'Pairing confirmed';
        secretBox.textContent = oneTimeSecret || 'No one-time credential returned';
        setStatus(status, result, pairingNotice);
        await refreshAll();
        refresh();
      }),
      button('Reject', async () => { await window.warController.pairings.reject({ pairingId: item.requestId, reason: 'renderer rejection' }); pairingNotice = 'Pairing rejected'; await refreshAll(); refresh(); }),
    ]),
  ]);
}

function devicesView() {
  return section('Devices', [
    table([
      { key: 'id', label: 'Device ID' },
      { key: 'name', label: 'Display name' },
      { key: 'status', label: 'State' },
      { key: 'extensionVersion', label: 'Agent version' },
      { key: 'capabilities', label: 'Capabilities' },
      { key: 'groupIds', label: 'Groups' },
      { key: 'revoked', label: 'Revoked' },
      { key: 'lastSeenAt', label: 'Last seen' },
    ], store.devices),
  ]);
}

function remoteView(refresh) {
  store.remote ||= { selectedDeviceIds: [], selectionInitialized: false, activeDeviceId: '', synchronized: false, fps: 3, live: true, frames: {}, pending: {}, updating: {}, errors: {}, notice: '', error: '' };
  store.remote.updating ||= {};
  store.remote.errors ||= {};
  const targets = allWorkspaceDevices().filter((device) => device.managedContainer && isContainerAgentOnline(device.managedContainer ? store.containers.find((item) => item.id === device.containerId) : device));
  const ids = targets.map((device) => device.id || device.deviceId).filter(Boolean);
  store.remote.selectedDeviceIds = normalizeRemoteSelection(store.remote.selectedDeviceIds, ids);
  if (!store.remote.selectionInitialized) {
    if (!store.remote.selectedDeviceIds.length && ids.length) store.remote.selectedDeviceIds = [ids[0]];
    store.remote.selectionInitialized = true;
  }
  if (!ids.includes(store.remote.activeDeviceId)) store.remote.activeDeviceId = store.remote.selectedDeviceIds[0] || ids[0] || '';
  remoteScreens = new Map();
  const selected = new Set(store.remote.selectedDeviceIds);
  const sync = el('input', { type: 'checkbox', checked: store.remote.synchronized === true, ariaLabel: t('remote.sync') });
  sync.addEventListener('change', () => { store.remote.synchronized = sync.checked; refresh(); });
  const fps = el('select', { ariaLabel: t('remote.fps') }, [
    el('option', { value: '1', text: '1 FPS' }),
    el('option', { value: '3', text: '3 FPS' }),
    el('option', { value: '6', text: '6 FPS' }),
  ]);
  fps.value = String(store.remote.fps || 3);
  fps.addEventListener('change', () => { store.remote.fps = Number(fps.value); refresh(); });
  const live = button(store.remote.live ? t('remote.pause') : t('remote.resume'), () => {
    store.remote.live = !store.remote.live;
    if (!store.remote.live) stopRemotePolling();
    refresh();
  }, { className: 'button primary' });
  const status = el('p', { className: store.remote.error ? 'status error' : 'status', text: store.remote.error || store.remote.notice || (ids.length ? t('remote.help') : t('remote.empty')), ariaLive: 'polite' });
  remoteStatusNode = status;
  const root = section(t('remote.title'), [
    el('p', { className: 'muted', text: t('remote.description') }),
    el('div', { className: 'remote-toolbar' }, [
      field(t('remote.sync'), sync),
      field(t('remote.fps'), fps),
      button(t('remote.selectAll'), () => { store.remote.selectedDeviceIds = ids.slice(0, 8); refresh(); }, { className: 'button compact', disabled: !ids.length }),
      button(t('remote.clear'), () => { store.remote.selectedDeviceIds = []; refresh(); }, { className: 'button compact', disabled: !selected.size }),
      live,
    ]),
    status,
    ids.length ? el('div', { className: 'remote-target-list' }, targets.map((device) => remoteTargetCheckbox(device, selected, refresh))) : null,
    ids.length ? el('div', { className: 'remote-grid' }, targets.filter((device) => selected.has(device.id || device.deviceId)).map((device) => remoteTile(device, refresh))) : el('p', { className: 'empty-state', text: t('remote.empty') }),
    el('p', { className: 'remote-key-help', text: t('remote.keyHelp') }),
  ]);
  if (store.remote.live && ids.length && typeof window.warController?.remote?.capture === 'function') {
    queueMicrotask(() => startRemotePolling());
  }
  return root;
}

function remoteTargetCheckbox(device, selected, refresh) {
  const id = device.id || device.deviceId;
  const checkbox = el('input', { type: 'checkbox', checked: selected.has(id), ariaLabel: device.displayName || device.name || id });
  checkbox.addEventListener('change', () => {
    const next = new Set(store.remote.selectedDeviceIds);
    if (checkbox.checked) next.add(id);
    else next.delete(id);
    store.remote.selectedDeviceIds = [...next].slice(0, 8);
    if (!store.remote.activeDeviceId || checkbox.checked) store.remote.activeDeviceId = id;
    refresh();
  });
  return el('label', { className: 'remote-target-chip' }, [checkbox, el('span', { text: device.displayName || device.name || id })]);
}

function remoteTile(device, refresh) {
  const id = device.id || device.deviceId;
  const frame = store.remote.frames?.[id];
  const image = el('img', { className: 'remote-screen', tabIndex: 0, ariaLabel: t('remote.screen', { name: device.displayName || device.name || id }) });
  const placeholder = frame ? null : el('span', { className: 'remote-screen-placeholder', text: store.remote.updating?.[id] ? t('remote.updating') : (store.remote.errors?.[id] || t('remote.waiting')) });
  image.setAttribute('alt', t('remote.screen', { name: device.displayName || device.name || id }));
  image.setAttribute('draggable', 'false');
  if (frame?.data) image.setAttribute('src', `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`);
  remoteScreens.set(id, { image, placeholder });
  image.addEventListener('pointerdown', (event) => {
    store.remote.activeDeviceId = id;
    image.focus?.();
    const point = pointForRemoteFrame(event, image.getBoundingClientRect?.(), store.remote.frames?.[id]);
    image._remotePointer = { point, moved: false, lastMoveAt: 0 };
    if (point) sendRemoteCommand('input.mouseDown', { ...point, button: 'left' });
  });
  image.addEventListener('pointermove', (event) => {
    const pointer = image._remotePointer;
    const point = pointForRemoteFrame(event, image.getBoundingClientRect?.(), store.remote.frames?.[id]);
    if (!pointer || !point) return;
    if (pointer.point) {
      const distance = Math.abs(point.x - pointer.point.x) + Math.abs(point.y - pointer.point.y);
      if (distance > 3) pointer.moved = true;
    }
    pointer.point = point;
    if (Date.now() - pointer.lastMoveAt < 50) return;
    pointer.lastMoveAt = Date.now();
    sendRemoteCommand('input.mouseMove', point);
  });
  image.addEventListener('pointerup', (event) => {
    const point = pointForRemoteFrame(event, image.getBoundingClientRect?.(), store.remote.frames?.[id]);
    if (point) sendRemoteCommand('input.mouseUp', { ...point, button: 'left' });
    image._remotePointer = null;
  });
  image.addEventListener('pointercancel', () => { image._remotePointer = null; sendRemoteCommand('input.stopAll', {}); });
  image.addEventListener('wheel', (event) => {
    event.preventDefault?.();
    const point = pointForRemoteFrame(event, image.getBoundingClientRect?.(), store.remote.frames?.[id]);
    if (point) sendRemoteCommand('input.wheel', { ...point, deltaX: event.deltaX || 0, deltaY: event.deltaY || 0 });
  }, { passive: false });
  image.addEventListener('keydown', (event) => handleRemoteKey(event));
  image.addEventListener('keyup', (event) => {
    if (shortcutForKeyboardEvent(event) || printableTextForKeyboardEvent(event)) return;
    sendRemoteCommand('input.keyUp', { key: mapRemoteKey(event.key), space: 'browser' });
  });
  return el('article', { className: `remote-tile${store.remote.activeDeviceId === id ? ' active' : ''}` }, [
    el('div', { className: 'remote-tile-heading' }, [
      el('strong', { text: device.displayName || device.name || id }),
      el('span', { className: 'status-pill online', text: t('status.online') }),
    ]),
    el('div', { className: 'remote-screen-wrap' }, [image, placeholder]),
    el('div', { className: 'toolbar tight' }, [
      button(t('remote.focus'), () => { store.remote.activeDeviceId = id; refresh(); }, { className: 'button compact' }),
      button(t('remote.stopInput'), () => sendRemoteCommand('input.stopAll', {}), { className: 'button compact danger' }),
    ]),
    frame ? el('span', { className: 'device-meta', text: `${frame.width}x${frame.height} · ${Math.round((frame.data?.length || 0) * 0.75 / 1024)} KB` }) : null,
  ]);
}

function startRemotePolling() {
  if (remotePolling || store.view !== 'remote' || !store.remote.live) return;
  const state = { inFlight: false, timer: null };
  remotePolling = state;
  const tick = async () => {
    if (remotePolling !== state || store.view !== 'remote' || !store.remote.live) return;
    if (!state.inFlight) {
      state.inFlight = true;
      const ids = store.remote.selectedDeviceIds.slice(0, 8);
      try {
        await Promise.all(ids.map(async (deviceId) => {
          try {
            const result = unwrap(await window.warController.remote.capture({ deviceId, quality: qualityForFps(store.remote.fps) }));
            const frame = result?.frame;
            if (result?.status === 'updating') {
              store.remote.updating[deviceId] = true;
              delete store.remote.errors[deviceId];
              store.remote.notice = t('remote.updating');
              const screen = remoteScreens.get(deviceId);
              if (screen?.placeholder && !store.remote.frames?.[deviceId]) {
                screen.placeholder.textContent = t('remote.updating');
                screen.placeholder.hidden = false;
              }
              updateRemoteStatus();
              return;
            }
            if (!frame?.data) return;
            delete store.remote.updating[deviceId];
            delete store.remote.errors[deviceId];
            store.remote.error = Object.values(store.remote.errors).find(Boolean) || '';
            store.remote.notice = Object.values(store.remote.updating).some(Boolean) ? t('remote.updating') : '';
            store.remote.frames = { ...store.remote.frames, [deviceId]: frame };
            const screen = remoteScreens.get(deviceId);
            if (screen?.image) screen.image.setAttribute('src', `data:${frame.mimeType || 'image/jpeg'};base64,${frame.data}`);
            if (screen?.placeholder) screen.placeholder.hidden = true;
            updateRemoteStatus();
          } catch (error) {
            const message = safeError(error, 'REMOTE_CAPTURE_FAILED');
            store.remote.errors[deviceId] = message;
            store.remote.error = Object.values(store.remote.errors).find(Boolean) || message;
            delete store.remote.updating[deviceId];
            const screen = remoteScreens.get(deviceId);
            if (screen?.placeholder && !store.remote.frames?.[deviceId]) {
              screen.placeholder.textContent = message;
              screen.placeholder.hidden = false;
            }
            updateRemoteStatus();
          }
        }));
      } finally {
        state.inFlight = false;
      }
    }
    if (remotePolling !== state || store.view !== 'remote' || !store.remote.live) return;
    state.timer = setTimeout(tick, pollIntervalForFps(store.remote.fps));
  };
  tick();
}

function stopRemotePolling() {
  if (remotePolling?.timer) clearTimeout(remotePolling.timer);
  remotePolling = null;
  remoteScreens.clear();
  remoteStatusNode = null;
}

async function sendRemoteCommand(command, payload) {
  const targets = remoteTargetsForAction({
    selectedDeviceIds: store.remote.selectedDeviceIds,
    activeDeviceId: store.remote.activeDeviceId,
    synchronized: store.remote.synchronized,
  });
  if (!targets.length) {
    store.remote.error = t('remote.selectTarget');
    updateRemoteStatus();
    return;
  }
  store.remote.error = '';
  try {
    const result = await window.warController.remote.control({ deviceIds: targets, command, payload, synchronized: store.remote.synchronized });
    if (result?.ok === false) throw controllerError(result, 'REMOTE_CONTROL_FAILED');
    const data = unwrap(result) || {};
    const failed = (data.targets || []).filter((item) => !item.ok);
    const updating = failed.some((item) => item.error?.code === 'REMOTE_AGENT_UPDATING');
    store.remote.notice = updating ? t('remote.updating') : (failed.length ? `${t('remote.partialFailure')} ${failed.length}` : t('remote.commandSent'));
    updateRemoteStatus();
  } catch (error) {
    store.remote.error = safeError(error, 'REMOTE_CONTROL_FAILED');
    updateRemoteStatus();
  }
}

function updateRemoteStatus() {
  if (!remoteStatusNode) return;
  remoteStatusNode.className = store.remote.error ? 'status error' : 'status';
  remoteStatusNode.textContent = store.remote.error || store.remote.notice || t('remote.help');
}

function handleRemoteKey(event) {
  const shortcut = shortcutForKeyboardEvent(event);
  if (shortcut) {
    event.preventDefault?.();
    if (shortcut === 'CTRL+V' && globalThis.navigator?.clipboard?.readText) {
      globalThis.navigator.clipboard.readText().then((text) => {
        if (text) sendRemoteCommand('input.insertText', { text, space: 'browser' });
      }).catch(() => sendRemoteCommand('input.shortcut', { keys: shortcut, space: 'browser' }));
    } else {
      sendRemoteCommand('input.shortcut', { keys: shortcut, space: 'browser' });
    }
    return;
  }
  const text = printableTextForKeyboardEvent(event);
  if (text) {
    event.preventDefault?.();
    sendRemoteCommand('input.insertText', { text, space: 'browser' });
    return;
  }
  const key = mapRemoteKey(event.key);
  if (key) {
    event.preventDefault?.();
    sendRemoteCommand('input.keyDown', { key, space: 'browser' });
  }
}

function mapRemoteKey(key) {
  const aliases = { Esc: 'Escape', ' ': 'Space', Ctrl: 'Control', Cmd: 'Meta', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };
  const value = aliases[key] || key;
  return value || '';
}

function groupsView(refresh) {
  const name = el('input', { type: 'text', placeholder: 'Group name' });
  const status = el('p', { className: 'status' });
  return section('Groups', [
    field('New group', name),
    button('Create', async () => {
      const value = name.value.trim();
      if (!value) { status.textContent = 'Group name is required'; return; }
      const result = await window.warController.groups.create({ name: value });
      setStatus(status, result, 'Group created');
      if (result?.ok === false) return;
      name.value = '';
      status.textContent = '';
      await refreshAll();
      refresh();
    }),
    status,
    ...store.groups.map((group) => groupEditor(group, refresh)),
  ]);
}

function groupEditor(group, refresh) {
  const name = el('input', { type: 'text', value: group.name || group.id });
  const device = el('select', {}, [
    el('option', { value: '', text: 'Select device' }),
    ...store.devices.map((item) => el('option', { value: item.id, text: item.name || item.id })),
  ]);
  return el('article', { className: 'item-row' }, [
    el('div', {}, [
      el('strong', { text: group.id }),
      field('Name', name),
      el('p', { text: `Devices: ${(group.deviceIds || []).join(', ') || 'none'}` }),
    ]),
    el('div', { className: 'toolbar vertical' }, [
      button('Rename', async () => { await window.warController.groups.update({ groupId: group.id, name: name.value.trim() || group.name }); await refreshAll(); refresh(); }),
      button('Delete', async () => { if (window.confirm('Delete this group?')) { await window.warController.groups.remove({ groupId: group.id }); await refreshAll(); refresh(); } }),
      device,
      button('Add device', async () => { if (device.value) { await window.warController.groups.addDevice({ groupId: group.id, deviceId: device.value }); await refreshAll(); refresh(); } }),
      button('Remove device', async () => { if (device.value) { await window.warController.groups.removeDevice({ groupId: group.id, deviceId: device.value }); await refreshAll(); refresh(); } }),
    ]),
  ]);
}

function workflowsView(refresh) {
  const imported = el('textarea', { rows: 10, placeholder: '{...WorkflowRevision JSON...}' });
  const originState = store.originSync || {};
  const originDevice = el('select', { ariaLabel: t('originSync.device') }, [
    el('option', { value: '', text: t('originSync.selectDevice') }),
    ...validOriginSessions().map((session) => el('option', { value: session.deviceId, text: originDeviceLabel(session.deviceId) })),
  ]);
  originDevice.value = originState.deviceId || '';
  originDevice.addEventListener('change', () => {
    store.originSync.deviceId = originDevice.value;
    store.originSyncPreview = null;
    store.originSyncResult = null;
    refresh();
  });
  const conflictPolicy = el('select', { ariaLabel: t('originSync.conflictPolicy') }, [
    el('option', { value: 'preserveBoth', text: t('originSync.preserveBoth') }),
    el('option', { value: 'skip', text: t('originSync.skipConflicts') }),
  ]);
  conflictPolicy.value = originState.conflictPolicy || 'preserveBoth';
  conflictPolicy.addEventListener('change', () => {
    store.originSync.conflictPolicy = conflictPolicy.value;
    store.originSyncResult = null;
    refresh();
  });
  const status = el('p', { className: originState.error ? 'status error' : 'status', text: originState.error || originState.notice || '', ariaLive: 'polite' });
  const previewPending = originState.pending === 'preview';
  const pullPending = originState.pending === 'pull';
  const canPreview = Boolean(originDevice.value) && !previewPending && !pullPending;
  const canPull = Boolean(originDevice.value) && Boolean(store.originSyncPreview) && !previewPending && !pullPending;
  return section('Workflows', [
    el('h3', { text: t('originSync.title') }),
    field(t('originSync.device'), originDevice),
    field(t('originSync.conflictPolicy'), conflictPolicy),
    el('div', { className: 'toolbar' }, [
      button(t('originSync.preview'), () => originSyncAction('preview', { originDevice, conflictPolicy, refresh }), { disabled: !canPreview }),
      button(t('originSync.pull'), () => originSyncAction('pull', { originDevice, conflictPolicy, refresh }), { disabled: !canPull }),
    ]),
    store.originSyncPreview ? originPreviewPanel() : null,
    store.originSyncResult ? originResultPanel() : null,
    field('WorkflowRevision JSON', imported),
    el('div', { className: 'toolbar' }, [
      button('Import file', async () => {
        const result = unwrap(await window.warController.dialogs.importWorkflow());
        if (!result?.canceled) imported.value = stableJson(result.value);
      }),
      button('Import workflow', async () => {
        try {
          const workflow = parseJsonInput(imported.value);
          setStatus(status, await window.warController.workflows.importFile({ workflow }), 'Workflow imported');
          await refreshAll();
          refresh();
        } catch (error) {
          status.textContent = error.message;
        }
      }),
    ]),
    status,
    table([
      { key: 'workflowId', label: 'Workflow' },
      { key: 'revision', label: 'Revision' },
      { key: 'name', label: 'Name' },
      { key: 'createdAt', label: 'Created' },
    ], store.workflows),
    ...store.workflows.map((workflow) => el('div', { className: 'row-actions' }, [
      el('span', { text: `${workflow.workflowId} rev ${workflow.revision}` }),
      button('View revision', async () => { await refreshWorkflow(workflow.workflowId, workflow.revision); refresh(); }),
    ])),
    store.selectedWorkflow ? workflowDetails(store.selectedWorkflow, refresh) : el('p', { text: 'Select a workflow revision to inspect safe metadata.' }),
  ]);
}

function originPreviewPanel() {
  const preview = store.originSyncPreview || {};
  const counts = originCounts(preview);
  return el('article', { className: 'item-row' }, [
    el('div', {}, [
      el('strong', { text: t('originSync.previewLoaded') }),
      metricGrid([
        [t('originSync.workflows'), counts.workflows],
        [t('originSync.imported'), counts.imported],
        [t('originSync.skipped'), counts.skipped],
        [t('originSync.conflicted'), counts.conflicted],
        [t('originSync.errors'), counts.errors],
      ]),
      table([
        { key: 'workflowId', label: t('originSync.workflow') },
        { key: 'revision', label: t('originSync.revision') },
        { key: 'name', label: t('originSync.name') },
        { key: 'action', label: t('originSync.action') },
        { key: 'conflict', label: t('originSync.conflict') },
      ], preview.workflows || []),
    ]),
  ]);
}

function originResultPanel() {
  const result = store.originSyncResult || {};
  const counts = originCounts(result);
  return el('article', { className: 'details' }, [
    el('h3', { text: t('originSync.result') }),
    metricGrid([
      [t('originSync.imported'), counts.imported],
      [t('originSync.skipped'), counts.skipped],
      [t('originSync.conflicted'), counts.conflicted],
      [t('originSync.errors'), counts.errors],
    ]),
    table([
      { key: 'workflowId', label: t('originSync.workflow') },
      { key: 'revision', label: t('originSync.revision') },
      { key: 'decision', label: t('originSync.decision') },
    ], originAuditRows(result)),
  ]);
}

async function originSyncAction(action, { originDevice, conflictPolicy, refresh }) {
  if (store.originSync?.pending) return;
  const deviceId = originDevice.value;
  if (!deviceId) {
    store.originSync.error = t('originSync.selectOne');
    refresh();
    return;
  }
  if (action === 'pull' && !store.originSyncPreview) {
    store.originSync.error = t('originSync.previewRequired');
    refresh();
    return;
  }
  store.originSync = {
    ...store.originSync,
    deviceId,
    conflictPolicy: conflictPolicy.value,
    pending: action,
    notice: action === 'preview' ? t('originSync.previewLoading') : t('originSync.pullLoading'),
    error: '',
  };
  refresh();
  try {
    const result = action === 'preview'
      ? await window.warController.workflows.originPreview({ deviceId })
      : await window.warController.workflows.originPull({ deviceId, conflictPolicy: conflictPolicy.value });
    if (result?.ok === false) {
      store.originSync.error = safeError(result);
      store.originSync.notice = '';
      return;
    }
    const data = unwrap(result);
    if (action === 'preview') {
      store.originSyncPreview = data;
      store.originSyncResult = null;
      store.originSync.notice = t('originSync.previewLoaded');
    } else {
      store.originSyncResult = data;
      store.originSync.notice = t('originSync.pullDone');
      await refreshAll();
      store.originSync = { ...store.originSync, deviceId, conflictPolicy: conflictPolicy.value };
    }
    store.originSync.error = '';
  } catch (error) {
    store.originSync.error = safeError(error);
    store.originSync.notice = '';
  } finally {
    store.originSync.pending = '';
    refresh();
  }
}

function validOriginSessions() {
  const paired = new Map((store.pairings?.paired || []).map((item) => [item.deviceId, item]));
  return store.sessions.filter((session) => {
    const deviceId = session.deviceId;
    const device = store.devices.find((item) => (item.id || item.deviceId) === deviceId);
    const pairing = paired.get(deviceId);
    if (session.status !== 'online' || session.revoked) return false;
    if (device?.revoked || device?.status === 'revoked' || device?.status === 'offline') return false;
    if (pairing?.revokedAt) return false;
    return true;
  });
}

function originDeviceLabel(deviceId) {
  const device = store.devices.find((item) => (item.id || item.deviceId) === deviceId);
  return device?.displayName || device?.name || deviceId;
}

function originCounts(value = {}) {
  const workflows = value.counts?.workflows ?? value.workflows?.length ?? 0;
  const imported = value.counts?.imported ?? value.imported?.length ?? value.workflows?.filter((item) => item.action === 'importNew').length ?? 0;
  const skipped = value.counts?.skipped ?? value.skipped?.length ?? value.workflows?.filter((item) => item.action === 'skip').length ?? 0;
  const conflicted = value.counts?.conflicted ?? value.conflicted?.length ?? value.conflicts?.length ?? value.workflows?.filter((item) => item.conflict).length ?? 0;
  const errors = value.counts?.errors ?? value.errors?.length ?? 0;
  return { workflows, imported, skipped, conflicted, errors };
}

function originAuditRows(result = {}) {
  const imported = (result.imported || []).map((item) => ({ ...item, decision: t('originSync.imported') }));
  const skipped = (result.skipped || []).map((item) => ({ ...item, decision: t('originSync.skipped') }));
  const conflicted = (result.conflicted || result.conflicts || []).map((item) => ({ ...item, decision: t('originSync.conflicted') }));
  const errors = (result.errors || []).map((item) => ({ ...item, decision: t('originSync.errors') }));
  return [...imported, ...skipped, ...conflicted, ...errors];
}

function workflowDetails(workflow, refresh) {
  const sensitive = (workflow.requiredInputs || []).some((item) => item.sensitive);
  return el('article', { className: 'details' }, [
    el('h3', { text: workflow.name || workflow.workflowId }),
    el('p', { text: sensitive ? 'Sensitive workflow inputs are unsupported.' : 'Required inputs can be supplied at dispatch.' }),
    table([
      { key: 'name', label: 'Input' },
      { key: 'type', label: 'Type' },
      { key: 'required', label: 'Required' },
      { key: 'sensitive', label: 'Sensitive' },
    ], workflow.requiredInputs || []),
    graphEditorPanel(workflow, refresh),
  ]);
}

function graphEditorPanel(workflow, refresh) {
  const editor = store.graphEditor || {};
  const graph = editor.graph;
  const selected = graph?.nodes?.find((node) => node.id === editor.selectedNodeId) || graph?.nodes?.[0] || null;
  const nodeSelect = el('select', { ariaLabel: t('graphEditor.node') }, (graph?.nodes || []).map((node) => el('option', { value: node.id, text: `${node.name || node.id} (${node.type})` })));
  nodeSelect.value = selected?.id || '';
  nodeSelect.addEventListener('change', () => {
    store.graphEditor.selectedNodeId = nodeSelect.value;
    refresh();
  });
  const name = el('input', { type: 'text', value: selected?.name || '' });
  const message = el('input', { type: 'text', value: selected?.message || selected?.text || selected?.selector || '' });
  const from = el('select', { ariaLabel: t('graphEditor.from') }, (graph?.nodes || []).map((node) => el('option', { value: node.id, text: node.name || node.id })));
  const to = el('select', { ariaLabel: t('graphEditor.to') }, (graph?.nodes || []).map((node) => el('option', { value: node.id, text: node.name || node.id })));
  from.value = graph?.nodes?.[0]?.id || '';
  to.value = graph?.nodes?.[1]?.id || graph?.nodes?.[0]?.id || '';
  const status = el('p', { className: editor.error ? 'status error' : 'status', text: editor.error || editor.notice || '', ariaLive: 'polite' });
  const pending = Boolean(editor.pending);
  const invalid = graph?.validation?.ok === false;
  return el('section', { className: 'details', ariaLabel: t('graphEditor.title') }, [
    el('h3', { text: t('graphEditor.title') }),
    el('div', { className: 'toolbar' }, [
      button(t('graphEditor.load'), () => graphAction('load', { workflow, refresh }), { disabled: pending }),
      button(t('graphEditor.preview'), () => graphAction('preview', { workflow, refresh }), { disabled: pending || !editor.unsaved }),
      button(t('graphEditor.save'), () => graphAction('save', { workflow, refresh }), { disabled: pending || !editor.unsaved || invalid }),
      button(t('graphEditor.discard'), () => graphDiscard(refresh), { disabled: pending || !editor.unsaved }),
    ]),
    status,
    graph ? metricGrid([
      [t('graphEditor.nodes'), graph.nodes?.length || 0],
      [t('graphEditor.edges'), graph.edges?.length || 0],
      [t('graphEditor.executionPlan'), (graph.executionPlan || []).join(' > ') || t('workspace.containers.unknown')],
      [t('graphEditor.validation'), graph.validation?.ok ? t('graphEditor.valid') : t('graphEditor.invalid')],
      [t('graphEditor.unsaved'), editor.unsaved ? t('graphEditor.yes') : t('graphEditor.no')],
    ]) : el('p', { className: 'empty-state', text: t('graphEditor.loadPrompt') }),
    graph ? table([
      { key: 'id', label: t('graphEditor.nodeId') },
      { key: 'type', label: t('graphEditor.type') },
      { key: 'name', label: t('graphEditor.name') },
    ], graph.nodes || []) : null,
    graph ? table([
      { key: 'from', label: t('graphEditor.from') },
      { key: 'to', label: t('graphEditor.to') },
    ], graph.edges || []) : null,
    graph?.validation?.errors?.length ? el('p', { className: 'status error', text: graph.validation.errors.join('; '), ariaLive: 'polite' }) : null,
    graph ? el('div', { className: 'form-grid' }, [
      field(t('graphEditor.node'), nodeSelect),
      field(t('graphEditor.nodeName'), name),
      field(t('graphEditor.nodeValue'), message),
      field(t('graphEditor.from'), from),
      field(t('graphEditor.to'), to),
    ]) : null,
    graph ? el('div', { className: 'toolbar' }, [
      button(t('graphEditor.updateNode'), () => graphQueueOperation({ type: 'updateNode', nodeId: nodeSelect.value, patch: graphNodePatch(selected, name.value, message.value) }, refresh), { disabled: pending || !nodeSelect.value }),
      button(t('graphEditor.addNode'), () => graphQueueOperation({ type: 'addNode', node: { type: 'log', name: t('graphEditor.newNode'), message: '' } }, refresh), { disabled: pending }),
      button(t('graphEditor.removeNode'), () => graphQueueOperation({ type: 'removeNode', nodeId: nodeSelect.value }, refresh), { disabled: pending || !nodeSelect.value }),
      button(t('graphEditor.addEdge'), () => graphQueueOperation({ type: 'addEdge', from: from.value, to: to.value }, refresh), { disabled: pending || !from.value || !to.value || from.value === to.value }),
      button(t('graphEditor.removeEdge'), () => graphQueueOperation({ type: 'removeEdge', from: from.value, to: to.value }, refresh), { disabled: pending || !from.value || !to.value }),
    ]) : null,
  ]);
}

async function graphAction(action, { workflow, refresh }) {
  if (store.graphEditor?.pending) return;
  if (action !== 'load' && !store.graphEditor.graph) {
    store.graphEditor.error = t('graphEditor.loadRequired');
    refresh();
    return;
  }
  store.graphEditor = {
    ...store.graphEditor,
    workflowId: workflow.workflowId,
    revision: workflow.revision,
    pending: action,
    notice: action === 'load' ? t('graphEditor.loading') : action === 'preview' ? t('graphEditor.previewing') : t('graphEditor.saving'),
    error: '',
  };
  refresh();
  try {
    if (!graphOperationsAreSafe(store.graphEditor.operations || [])) {
      store.graphEditor.error = 'INVALID_GRAPH_OPERATION';
      return;
    }
    const payload = { workflowId: workflow.workflowId, revision: workflow.revision, operations: store.graphEditor.operations || [] };
    const result = action === 'load'
      ? await window.warController.workflows.graphGet({ workflowId: workflow.workflowId, revision: workflow.revision })
      : action === 'preview'
        ? await window.warController.workflows.graphPreview(payload)
        : await window.warController.workflows.graphSave(payload);
    if (result?.ok === false) {
      store.graphEditor.error = safeError(result);
      store.graphEditor.notice = '';
      return;
    }
    const data = unwrap(result);
    if (action === 'save') {
      store.graphEditor.graph = data.graph;
      store.graphEditor.operations = [];
      store.graphEditor.unsaved = false;
      store.graphEditor.notice = t('graphEditor.saveDone');
      await refreshAll();
      if (data.saved?.revision) store.selectedWorkflow = data.saved.revision;
    } else {
      store.graphEditor.graph = data;
      store.graphEditor.notice = action === 'load' ? t('graphEditor.loaded') : t('graphEditor.previewDone');
      if (action === 'load') {
        store.graphEditor.operations = [];
        store.graphEditor.unsaved = false;
      }
    }
    store.graphEditor.selectedNodeId = store.graphEditor.selectedNodeId || store.graphEditor.graph?.nodes?.[0]?.id || '';
    store.graphEditor.error = '';
  } catch (error) {
    store.graphEditor.error = safeError(error);
    store.graphEditor.notice = '';
  } finally {
    store.graphEditor.pending = '';
    refresh();
  }
}

function graphQueueOperation(operation, refresh) {
  if (!['addNode', 'updateNode', 'removeNode', 'addEdge', 'removeEdge'].includes(operation?.type)) {
    store.graphEditor.error = 'INVALID_GRAPH_OPERATION';
    refresh();
    return;
  }
  store.graphEditor.operations = [...(store.graphEditor.operations || []), operation];
  store.graphEditor.unsaved = true;
  store.graphEditor.notice = t('graphEditor.unsavedNotice');
  store.graphEditor.error = '';
  refresh();
}

function graphOperationsAreSafe(operations) {
  return Array.isArray(operations) && operations.every((operation) => ['addNode', 'updateNode', 'removeNode', 'addEdge', 'removeEdge'].includes(operation?.type));
}

function graphDiscard(refresh) {
  if (!window.confirm(t('graphEditor.discardConfirm'))) return;
  store.graphEditor.operations = [];
  store.graphEditor.unsaved = false;
  store.graphEditor.notice = t('graphEditor.discarded');
  store.graphEditor.error = '';
  refresh();
}

function graphNodePatch(node, name, value) {
  const patch = { name: String(name || '').trim() || node?.name || node?.id };
  if (node?.type === 'click') patch.selector = value;
  else if (node?.type === 'input') patch.text = value;
  else patch.message = value;
  return patch;
}

function taskPackagePanel(refresh) {
  const taskState = taskPackageState();
  const devices = taskPackageDevices();
  const workflows = taskPackageWorkflows();
  if (!taskState.deviceSelectionInitialized) {
    const selected = store.workspace.selection?.selectedIds || new Set();
    taskState.selectedDeviceIds = devices.map((device) => device.id).filter((id) => selected.has(id));
    taskState.deviceSelectionInitialized = true;
  }

  const name = el('input', { type: 'text', value: taskState.name, placeholder: t('taskPackage.namePlaceholder') });
  const mode = el('select', { ariaLabel: t('taskPackage.mode') }, [
    el('option', { value: 'matrix', text: t('taskPackage.matrixMode') }),
    el('option', { value: 'paired', text: t('taskPackage.pairedMode') }),
  ]);
  mode.value = taskState.mode || 'matrix';
  const workflowSelect = el('select', {
    multiple: true,
    size: Math.max(3, Math.min(8, workflows.length || 3)),
    ariaLabel: t('taskPackage.workflows'),
  }, workflows.map((workflow) => {
    const option = el('option', { value: workflow.key, text: workflow.label });
    option.selected = taskState.selectedWorkflowKeys.includes(workflow.key);
    return option;
  }));
  const deviceSelect = el('select', {
    multiple: true,
    size: Math.max(3, Math.min(8, devices.length || 3)),
    ariaLabel: t('taskPackage.devices'),
  }, devices.map((device) => {
    const option = el('option', { value: device.id, text: device.label });
    option.selected = taskState.selectedDeviceIds.includes(device.id);
    return option;
  }));
  const inputs = el('textarea', { rows: 5, value: taskState.inputs, placeholder: '{"query":"value"}' });
  inputs.value = taskState.inputs || '';
  const deadline = el('input', { type: 'number', min: 10, max: 86400, step: 1, value: taskState.deadlineSeconds ?? 300 });
  let dispatchButton = null;
  const invalidate = () => {
    store.taskPackagePreview = null;
    store.taskPackageResult = null;
    taskState.notice = '';
    taskState.error = '';
    if (dispatchButton) dispatchButton.disabled = true;
  };
  name.addEventListener('input', () => { taskState.name = name.value; invalidate(); });
  mode.addEventListener('change', () => { taskState.mode = mode.value; invalidate(); refresh(); });
  workflowSelect.addEventListener('change', () => { taskState.selectedWorkflowKeys = selectedOptionValues(workflowSelect); invalidate(); });
  deviceSelect.addEventListener('change', () => { taskState.selectedDeviceIds = selectedOptionValues(deviceSelect); invalidate(); });
  inputs.addEventListener('input', () => { taskState.inputs = inputs.value; invalidate(); });
  deadline.addEventListener('input', () => { taskState.deadlineSeconds = Number(deadline.value); invalidate(); });

  const previewButton = button(t('taskPackage.preview'), () => {
    if (taskState.pending) return;
    try {
      const plan = buildTaskPackagePlan();
      store.taskPackagePreview = plan;
      store.taskPackageResult = null;
      taskState.error = '';
      taskState.notice = t('taskPackage.previewReady', { count: plan.assignments.length });
    } catch (error) {
      store.taskPackagePreview = null;
      taskState.notice = '';
      taskState.error = error.message;
    }
    refresh();
  }, { disabled: taskState.pending });
  dispatchButton = button(t('taskPackage.dispatch'), () => dispatchTaskPackage(refresh), {
    className: 'button primary',
    disabled: taskState.pending || !store.taskPackagePreview,
  });
  const status = el('p', {
    className: taskState.error ? 'status error' : 'status',
    text: taskState.error || taskState.notice || '',
    ariaLive: 'polite',
  });

  return el('section', { className: 'details task-package', ariaLabel: t('taskPackage.title') }, [
    el('div', { className: 'task-package-heading' }, [
      el('div', {}, [
        el('h3', { text: t('taskPackage.title') }),
        el('p', { className: 'muted', text: t('taskPackage.guidance') }),
      ]),
      el('span', { className: 'task-package-mode', text: mode.value === 'paired' ? t('taskPackage.pairedMode') : t('taskPackage.matrixMode') }),
    ]),
    el('div', { className: 'form-grid task-package-grid' }, [
      field(t('taskPackage.name'), name),
      field(t('taskPackage.mode'), mode),
      field(t('taskPackage.workflows'), workflowSelect),
      field(t('taskPackage.devices'), deviceSelect),
      field(t('taskPackage.inputs'), inputs),
      field(t('taskPackage.deadline'), deadline),
    ]),
    el('div', { className: 'toolbar' }, [previewButton, dispatchButton]),
    status,
    store.taskPackagePreview ? taskPackagePlanPanel(store.taskPackagePreview) : null,
    store.taskPackageResult ? taskPackageResultPanel(store.taskPackageResult) : null,
  ]);
}

function taskPackageState() {
  store.taskPackage ||= {
    name: '',
    mode: 'matrix',
    selectedWorkflowKeys: [],
    selectedDeviceIds: [],
    deviceSelectionInitialized: false,
    inputs: '',
    deadlineSeconds: 300,
    pending: false,
    notice: '',
    error: '',
  };
  return store.taskPackage;
}

function taskPackageDevices() {
  const seen = new Set();
  const devices = [];
  for (const device of allWorkspaceDevices()) {
    const id = device.id || device.deviceId;
    if (!id || seen.has(id)) continue;
    const name = device.displayName || device.name || id;
    const host = hostLabelFromId(device.containerHost, device);
    const item = { id, label: host ? `${name} (${host})` : name, status: normalizeDeviceStatus(device) };
    seen.add(id);
    if (item.status !== 'revoked') devices.push(item);
  }
  return devices;
}

function taskPackageWorkflows() {
  return store.workflows.map((workflow) => ({
    key: `${workflow.workflowId}:${workflow.revision}`,
    workflowId: workflow.workflowId,
    revision: workflow.revision,
    name: workflow.name || workflow.workflowId,
    label: `${workflow.name || workflow.workflowId} - rev ${workflow.revision}`,
  }));
}

function buildTaskPackagePlan() {
  const taskState = taskPackageState();
  const name = String(taskState.name || '').trim();
  if (!name) throw new Error(t('taskPackage.nameRequired'));
  if (name.length > 120) throw new Error(t('taskPackage.nameTooLong'));
  const workflowKeys = [...new Set(taskState.selectedWorkflowKeys)];
  const deviceIds = [...new Set(taskState.selectedDeviceIds)];
  const workflows = workflowKeys.map((key) => taskPackageWorkflows().find((workflow) => workflow.key === key));
  if (!workflows.length) throw new Error(t('taskPackage.workflowRequired'));
  const devices = deviceIds.map((id) => taskPackageDevices().find((device) => device.id === id));
  if (!devices.length) throw new Error(t('taskPackage.deviceRequired'));
  if (workflows.some((workflow) => !workflow) || devices.some((device) => !device)) throw new Error(t('taskPackage.invalidSelection'));
  const deadlineSeconds = Number(taskState.deadlineSeconds);
  if (!Number.isInteger(deadlineSeconds) || deadlineSeconds < 10 || deadlineSeconds > 86400) throw new Error(t('taskPackage.invalidDeadline'));
  const mode = taskState.mode === 'paired' ? 'paired' : 'matrix';
  if (mode === 'paired' && workflows.length !== devices.length) throw new Error(t('taskPackage.pairedCountMismatch'));
  const inputs = parseJsonInput(taskState.inputs);
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) throw new Error(t('taskPackage.invalidInputs'));
  const assignments = mode === 'paired'
    ? workflows.map((workflow, index) => ({ workflow, device: devices[index] }))
    : workflows.flatMap((workflow) => devices.map((device) => ({ workflow, device })));
  if (assignments.length > 200) throw new Error(t('taskPackage.planTooLarge', { count: 200 }));
  return {
    name,
    mode,
    workflows,
    devices,
    inputs,
    deadlineSeconds,
    assignments,
    signature: JSON.stringify({ name, mode, workflowKeys: workflows.map((item) => item.key), deviceIds: devices.map((item) => item.id), inputs, deadlineSeconds }),
  };
}

async function dispatchTaskPackage(refresh) {
  const taskState = taskPackageState();
  if (taskState.pending) return;
  let plan;
  try {
    plan = buildTaskPackagePlan();
    if (!store.taskPackagePreview || store.taskPackagePreview.signature !== plan.signature) throw new Error(t('taskPackage.previewRequired'));
  } catch (error) {
    taskState.error = error.message;
    taskState.notice = '';
    refresh();
    return;
  }
  taskState.pending = true;
  taskState.error = '';
  taskState.notice = t('taskPackage.dispatching', { name: plan.name });
  refresh();
  try {
    const items = await Promise.all(plan.assignments.map(async ({ workflow, device }) => {
      try {
        const result = await window.warController.jobs.dispatch({
          deviceId: device.id,
          workflowId: workflow.workflowId,
          revision: workflow.revision,
          inputs: plan.inputs,
          deadlineSeconds: plan.deadlineSeconds,
        });
        if (result?.ok === false) throw controllerError(result, 'JOB_DISPATCH_FAILED');
        const data = unwrap(result);
        if (data?.job?.id && data.transport) store.jobTransports[data.job.id] = data.transport;
        return {
          deviceId: device.id,
          device: device.label,
          workflow: workflow.name,
          revision: workflow.revision,
          jobId: data?.job?.id || '',
          ok: true,
          status: data?.transport?.delivered === false ? t('taskPackage.persistedOffline') : t('taskPackage.submitted'),
        };
      } catch (error) {
        return {
          deviceId: device.id,
          device: device.label,
          workflow: workflow.name,
          revision: workflow.revision,
          jobId: '',
          ok: false,
          status: `${t('taskPackage.failed')}: ${safeError(error)}`,
        };
      }
    }));
    const succeeded = items.filter((item) => item.ok).length;
    const failed = items.length - succeeded;
    store.taskPackageResult = { name: plan.name, mode: plan.mode, requested: items.length, succeeded, failed, items };
    taskState.notice = t('taskPackage.dispatchDone', { succeeded, failed });
    taskState.error = failed === items.length ? taskState.notice : '';
    await refreshAll();
  } catch (error) {
    taskState.error = safeError(error);
    taskState.notice = '';
  } finally {
    taskState.pending = false;
    refresh();
  }
}

function taskPackagePlanPanel(plan) {
  return el('div', { className: 'task-package-plan' }, [
    el('strong', { text: `${t('taskPackage.task')}: ${plan.name}` }),
    table([
      { key: 'device', label: t('taskPackage.machine') },
      { key: 'workflow', label: t('taskPackage.workflow') },
      { key: 'revision', label: t('taskPackage.revision') },
    ], plan.assignments.map(({ device, workflow }) => ({ device: device.label, workflow: workflow.name, revision: workflow.revision }))),
  ]);
}

function taskPackageResultPanel(result) {
  return el('div', { className: 'task-package-result' }, [
    el('strong', { text: `${t('taskPackage.task')}: ${result.name}` }),
    table([
      { key: 'device', label: t('taskPackage.machine') },
      { key: 'workflow', label: t('taskPackage.workflow') },
      { key: 'revision', label: t('taskPackage.revision') },
      { key: 'jobId', label: t('taskPackage.job') },
      { key: 'status', label: t('taskPackage.status') },
    ], result.items),
  ]);
}

function jobsView(refresh) {
  const device = select('Device', store.devices.map((item) => [item.id, item.name || item.id]));
  const workflow = select('Workflow', store.workflows.map((item) => [`${item.workflowId}:${item.revision}`, `${item.workflowId} rev ${item.revision}`]));
  const deadline = el('input', { type: 'number', min: 10, max: 86400, step: 1, value: '300' });
  const payload = el('textarea', { rows: 8, placeholder: '{"inputName":"value"}' });
  const groupedState = store.groupedInput || {};
  const groupedDevices = el('select', { multiple: true, size: Math.max(2, Math.min(6, store.devices.length || 2)), ariaLabel: t('groupedInput.devices') }, store.devices.map((item) => {
    const option = el('option', { value: item.id, text: item.name || item.id });
    option.selected = groupedState.selectedDeviceIds?.includes(item.id);
    return option;
  }));
  const groupedMode = el('select', { ariaLabel: t('groupedInput.mode') }, [
    el('option', { value: 'text', text: t('groupedInput.textMode') }),
    el('option', { value: 'table', text: t('groupedInput.tableMode') }),
    el('option', { value: 'cell', text: t('groupedInput.cellMode') }),
  ]);
  groupedMode.value = groupedState.mode || 'text';
  const groupedInput = el('textarea', { rows: 6, placeholder: groupedInputPlaceholder(groupedMode.value), ariaDescribedBy: 'grouped-input-help' });
  groupedInput.value = groupedState.text || '';
  const broadcast = el('input', { type: 'checkbox', checked: groupedState.broadcastSingleRow !== false });
  groupedMode.addEventListener('change', () => {
    store.groupedInput.mode = groupedMode.value;
    store.groupedInput.error = '';
    store.groupedInput.notice = '';
    store.groupedInputPreview = null;
    store.groupedInputResult = null;
    refresh();
  });
  groupedInput.addEventListener('input', () => {
    store.groupedInput.text = groupedInput.value;
    store.groupedInput.error = '';
    store.groupedInputPreview = null;
    store.groupedInputResult = null;
  });
  groupedDevices.addEventListener('change', () => {
    store.groupedInput.selectedDeviceIds = selectedOptionValues(groupedDevices);
    store.groupedInputPreview = null;
    store.groupedInputResult = null;
  });
  broadcast.addEventListener('change', () => {
    store.groupedInput.broadcastSingleRow = broadcast.checked;
    store.groupedInputPreview = null;
    store.groupedInputResult = null;
  });
  const status = el('p', { className: 'status' });
  status.textContent = store.lastJobNotice || '';
  const groupedStatus = el('p', { className: groupedState.error ? 'status error' : 'status', text: groupedState.error || groupedState.notice || '', ariaLive: 'polite' });
  const groupedPending = Boolean(groupedState.pending);
  const canDispatchGrouped = Boolean(store.groupedInputPreview) && !groupedPending && !groupedState.error;
  return section('Jobs', [
    taskPackagePanel(refresh),
    el('div', { className: 'form-grid' }, [
      device.label,
      workflow.label,
      field('Deadline seconds', deadline),
      field('Workflow inputs', payload),
    ]),
    el('div', { className: 'toolbar' }, [
      button('Dispatch', async () => {
        try {
          const [workflowId, revisionText] = workflow.control.value.split(':');
          const result = await window.warController.jobs.dispatch({
            deviceId: device.control.value,
            workflowId,
            revision: Number(revisionText),
            deadlineSeconds: Number(deadline.value),
            inputs: parseJsonInput(payload.value),
          });
          const data = unwrap(result);
          store.lastJobNotice = transportSummary(data);
          if (data?.job?.id && data.transport) store.jobTransports[data.job.id] = data.transport;
          setStatus(status, result, store.lastJobNotice);
          await refreshAll();
          refresh();
        } catch (error) {
          status.textContent = error.message;
        }
      }),
      button('Manual refresh', async () => { await refreshAll(); refresh(); }),
    ]),
    el('h3', { text: t('groupedInput.title') }),
    el('div', { className: 'form-grid' }, [
      field(t('groupedInput.devices'), groupedDevices),
      field(t('groupedInput.mode'), groupedMode),
      field(t('groupedInput.rows'), groupedInput),
      field(t('groupedInput.broadcast'), broadcast),
    ]),
    el('p', { id: 'grouped-input-help', className: 'muted', text: t('groupedInput.guidance') }),
    el('div', { className: 'toolbar' }, [
      button(t('groupedInput.preview'), async () => groupedInputAction('preview', { workflow, deadline, groupedDevices, groupedMode, groupedInput, broadcast, refresh }), { disabled: groupedPending }),
      button(t('groupedInput.dispatch'), async () => groupedInputAction('dispatch', { workflow, deadline, groupedDevices, groupedMode, groupedInput, broadcast, refresh }), { disabled: !canDispatchGrouped }),
    ]),
    groupedStatus,
    store.groupedInputPreview ? groupedInputPanel(store.groupedInputPreview) : null,
    store.groupedInputResult ? groupedDispatchPanel(store.groupedInputResult) : null,
    status,
    table([
      { key: 'id', label: 'Job' },
      { key: 'deviceId', label: 'Device' },
      { key: 'profileId', label: 'Workflow' },
      { key: 'status', label: 'Execution status' },
      { key: 'cancelledAt', label: 'Cancel state' },
    ], store.jobs),
    ...store.jobs.map((job) => el('div', { className: 'row-actions' }, [
      el('span', { text: job.id }),
      button('Details', async () => { await refreshJob(job.id); refresh(); }),
      button('Cancel', async () => { await window.warController.jobs.cancel({ jobId: job.id }); await refreshAll(); refresh(); }),
    ])),
    store.selectedJob ? jobDetails() : el('p', { text: 'Select a job to inspect persisted and execution state.' }),
  ]);
}

async function groupedInputAction(action, { workflow, deadline, groupedDevices, groupedMode, groupedInput, broadcast, refresh }) {
  if (store.groupedInput?.pending) return;
  if (action === 'dispatch' && !store.groupedInputPreview) {
    store.groupedInput.error = t('groupedInput.previewRequired');
    refresh();
    return;
  }
  store.groupedInput = {
    ...store.groupedInput,
    mode: groupedMode.value,
    text: groupedInput.value,
    selectedDeviceIds: selectedOptionValues(groupedDevices),
    broadcastSingleRow: broadcast.checked,
    pending: action,
    notice: action === 'preview' ? t('groupedInput.previewLoading') : t('groupedInput.dispatchLoading'),
    error: '',
  };
  refresh();
  try {
    const [workflowId, revisionText] = workflow.control.value.split(':');
    const deviceIds = store.groupedInput.selectedDeviceIds;
    const request = {
      workflowId,
      revision: Number(revisionText),
      deviceIds,
      text: groupedInput.value,
      mode: groupedMode.value,
      broadcastSingleRow: broadcast.checked,
      deadlineSeconds: Number(deadline.value),
    };
    const result = action === 'preview'
      ? await window.warController.jobs.groupedPreview(request)
      : await window.warController.jobs.groupedDispatch(request);
    if (result?.ok === false) {
      store.groupedInput.error = safeError(result);
      store.groupedInput.notice = '';
      return;
    }
    const data = unwrap(result);
    store.groupedInputPreview = data;
    if (action === 'dispatch') store.groupedInputResult = data;
    store.groupedInput.notice = action === 'preview' ? t('groupedInput.previewReady') : t('groupedInput.dispatchDone');
    store.groupedInput.error = '';
    if (action === 'dispatch') await refreshAll();
  } catch (error) {
    store.groupedInput.error = safeError(error);
    store.groupedInput.notice = '';
  } finally {
    store.groupedInput.pending = '';
    refresh();
  }
}

function groupedInputPanel(plan) {
  return el('article', { className: 'details' }, [
    el('h3', { text: t('groupedInput.previewReady') }),
    metricGrid([
      [t('groupedInput.deviceCount'), plan.counts?.devices ?? 0],
      [t('groupedInput.rowCount'), plan.counts?.rows ?? 0],
      [t('groupedInput.assignmentCount'), plan.counts?.assignments ?? 0],
    ]),
    table([
      { key: 'deviceId', label: t('groupedInput.device') },
      { key: 'sourceRowIndex', label: t('groupedInput.row') },
      { key: 'preview', label: t('groupedInput.inputs') },
    ], (plan.assignments || []).map((item) => ({ ...item, preview: JSON.stringify(item.preview) }))),
  ]);
}

function groupedDispatchPanel(result) {
  return el('article', { className: 'details' }, [
    el('h3', { text: t('groupedInput.dispatchDone') }),
    table([
      { key: 'deviceId', label: t('groupedInput.device') },
      { key: 'jobId', label: t('groupedInput.job') },
      { key: 'status', label: t('groupedInput.status') },
    ], (result.dispatched || []).map((item) => ({
      deviceId: item.deviceId,
      jobId: item.job?.id || item.jobId || '',
      status: item.transport?.delivered ? t('groupedInput.delivered') : (item.transport?.warningCode || t('groupedInput.persisted')),
    }))),
  ]);
}

function selectedOptionValues(selectNode) {
  return [...(selectNode.options || [])].filter((option) => option.selected).map((option) => option.value);
}

function groupedInputPlaceholder(mode) {
  if (mode === 'table') return 'url|query\nexample.test|hôm nay thật vui';
  if (mode === 'cell') return 'hôm nay thật vui|ô 2|ô 3';
  return 'value-a|value-b\nvalue-c|value-d';
}

function jobDetails() {
  const transport = store.selectedJob?.transport || store.jobTransports?.[store.selectedJob?.id] || {};
  return el('article', { className: 'details' }, [
    el('h3', { text: 'Job details' }),
    metricGrid([
      ['Job persisted', store.selectedJob?.id ? 'yes' : 'no'],
      ['Transport delivered', transport.delivered ? 'yes' : 'see warning or state'],
      ['Transport warning', transport.warningCode || 'none'],
      ['Acknowledged', store.selectedJob?.acknowledgedAt || 'not yet'],
      ['Execution status', store.selectedJob?.status || 'unknown'],
      ['Cancel state', store.selectedJob?.cancelledAt || 'not cancelled'],
    ]),
    codeBlock(store.selectedJob),
    el('h3', { text: 'Execution events' }),
    table([
      { key: 'eventType', label: 'Event' },
      { key: 'sentAt', label: 'Sent at' },
      { key: 'message', label: 'Message' },
    ], store.jobEvents),
  ]);
}

function diagnosticsView(refresh) {
  const runtime = store.runtime || {};
  const diagnostics = store.diagnostics;
  const status = el('p', { className: store.diagnosticsError ? 'status error' : 'status', text: store.diagnosticsError || store.diagnosticsNotice || '', ariaLive: 'polite' });
  return section('Diagnostics', [
    metricGrid([
      ['Application version', runtime.applicationVersion || store.bootstrap?.applicationVersion || 'unknown'],
      ['Protocol version', runtime.protocolVersion || 'v1'],
      ['WSS status', runtime.status || 'unknown'],
      ['Safe bind host', runtime.bindHost || '127.0.0.1'],
      ['Port', runtime.port ?? 0],
      ['Store', runtime.storeStatus || 'loaded'],
      ['Last refresh', store.lastRefresh || 'never'],
      ['Checks', diagnostics?.summary?.total ?? 'not run'],
      ['Errors', diagnostics?.summary?.error ?? 'not run'],
      ['Warnings', diagnostics?.summary?.warning ?? 'not run'],
    ]),
    el('div', { className: 'toolbar' }, [
      button(store.diagnosticsPending ? 'Checking...' : 'Run diagnostics', () => runDiagnostics(refresh, status), { className: 'button primary', disabled: store.diagnosticsPending }),
      button('Fix detected issues', () => repairDiagnostics('', refresh, status), { className: 'button', disabled: store.diagnosticsPending || !diagnostics?.summary?.fixable }),
      button('Refresh controller state', refresh),
    ]),
    status,
    diagnostics?.checks?.length ? el('div', { className: 'diagnostics-list' }, diagnostics.checks.map((check) => diagnosticCheck(check, refresh, status))) : el('p', { className: 'empty-state', text: 'Run diagnostics to inspect WSS, Linux, container, and Agent connectivity.' }),
  ]);
}

function diagnosticCheck(check, refresh, status) {
  return el('article', { className: `diagnostic-card ${check.severity || 'warning'}` }, [
    el('div', { className: 'diagnostic-card-heading' }, [
      el('strong', { text: `${check.area || 'system'} · ${check.code || 'CHECK'}` }),
      el('span', { className: `status-pill ${check.severity === 'ok' ? 'online' : check.severity === 'error' ? 'failed' : 'connecting'}`, text: check.severity || 'warning' }),
    ]),
    el('p', { className: 'device-meta', text: check.message || '' }),
    check.targetId ? el('span', { className: 'device-meta', text: check.targetId }) : null,
    check.fixable ? button(check.action === 'refresh-wss' ? 'Reload WSS/TLS' : 'Fix', () => repairDiagnostics(check.targetId || (check.action === 'refresh-wss' ? 'wss' : ''), refresh, status), { className: check.severity === 'error' ? 'button primary' : 'button compact' }) : null,
  ]);
}

async function runDiagnostics(refresh, status) {
  if (store.diagnosticsPending) return;
  store.diagnosticsPending = true;
  store.diagnosticsError = '';
  store.diagnosticsNotice = 'Running connectivity and security checks...';
  refresh();
  try {
    const result = await window.warController.diagnostics.run();
    if (result?.ok === false) throw controllerError(result, 'DIAGNOSTICS_FAILED');
    store.diagnostics = unwrap(result);
    store.diagnosticsNotice = `Diagnostics complete: ${store.diagnostics.summary?.error || 0} errors, ${store.diagnostics.summary?.warning || 0} warnings.`;
    status.textContent = store.diagnosticsNotice;
  } catch (error) {
    store.diagnosticsError = safeError(error, 'DIAGNOSTICS_FAILED');
    status.textContent = store.diagnosticsError;
  } finally {
    store.diagnosticsPending = false;
    refresh();
  }
}

async function repairDiagnostics(targetId, refresh, status) {
  if (store.diagnosticsPending) return;
  store.diagnosticsPending = true;
  store.diagnosticsError = '';
  store.diagnosticsNotice = 'Applying safe repairs...';
  refresh();
  try {
    const result = await window.warController.diagnostics.repair({ targetId: targetId || undefined });
    if (result?.ok === false) throw controllerError(result, 'DIAGNOSTICS_REPAIR_FAILED');
    const data = unwrap(result) || {};
    store.diagnostics = data.diagnostics || store.diagnostics;
    store.diagnosticsNotice = data.failures?.length ? `Repair completed with ${data.failures.length} failure(s).` : 'Repairs completed.';
    status.textContent = store.diagnosticsNotice;
  } catch (error) {
    store.diagnosticsError = safeError(error, 'DIAGNOSTICS_REPAIR_FAILED');
    status.textContent = store.diagnosticsError;
  } finally {
    store.diagnosticsPending = false;
    refresh();
  }
}

function metricGrid(items) {
  return el('dl', { className: 'metric-grid' }, items.flatMap(([label, value]) => [
    el('dt', { text: label }),
    el('dd', { text: value }),
  ]));
}

function select(labelText, options) {
  const control = el('select', {}, [
    el('option', { value: '', text: `Select ${labelText.toLowerCase()}` }),
    ...options.map(([value, label]) => el('option', { value, text: label })),
  ]);
  return { control, label: field(labelText, control) };
}

function transportSummary(data) {
  const transport = data?.transport || {};
  if (transport.delivered) return 'Job persisted. Transport delivered. Execution awaits agent events.';
  return `Job persisted. Transport warning: ${transport.warningCode || 'not delivered'}.`;
}
