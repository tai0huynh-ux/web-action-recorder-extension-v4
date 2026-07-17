import { button, codeBlock, el, field, parseJsonInput, section, setStatus, stableJson, table } from './dom.js';
import { refreshAll, refreshJob, refreshWorkflow, store, unwrap } from './state.js';
import { t } from './i18n.js';
import {
  WORKSPACE_SAMPLE_NODES,
  clampWorkspaceLayout,
  normalizeDeviceStatus,
  reduceDeviceSelection,
  selectedDevices,
} from './workspaceState.js';

let oneTimeSecret = null;
let pairingNotice = '';

export function clearPairingSecret() {
  oneTimeSecret = null;
  pairingNotice = '';
}

export function renderView(refresh) {
  if (store.view !== 'pairing') clearPairingSecret();
  if (store.view === 'workspace') return workspaceView(refresh);
  if (store.view === 'overview') return overviewView(refresh);
  if (store.view === 'pairing') return pairingView(refresh);
  if (store.view === 'devices') return devicesView();
  if (store.view === 'groups') return groupsView(refresh);
  if (store.view === 'workflows') return workflowsView(refresh);
  if (store.view === 'jobs') return jobsView(refresh);
  return diagnosticsView(refresh);
}

function workspaceView(refresh) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const selected = selectedDevices(store.devices, store.workspace.selection);
  const root = el('section', { className: layout.graphCollapsed ? 'workspace-view graph-collapsed' : 'workspace-view', ariaLabel: t('navigation.workspace') }, [
    workspaceMobileToolbar(),
    containersPane(refresh),
    inputPane(selected, refresh),
    graphPane(refresh),
  ]);
  if (root.style?.setProperty) {
    root.style.setProperty('--workspace-left', `${layout.leftWidth}px`);
    root.style.setProperty('--workspace-center', `${layout.centerWidth}px`);
  }
  return root;
}

function workspaceMobileToolbar() {
  return el('div', { className: 'workspace-mobile-toolbar', role: 'toolbar', ariaLabel: t('navigation.workspace') }, [
    button(t('workspace.toolbar.machines'), () => {}, { className: 'button compact' }),
    button(t('workspace.toolbar.input'), () => {}, { className: 'button compact' }),
    button(t('workspace.toolbar.graph'), () => {}, { className: 'button compact' }),
  ]);
}

function containersPane(refresh) {
  const devices = visibleWorkspaceDevices();
  const search = el('input', { type: 'search', placeholder: t('workspace.containers.search'), value: store.workspace.search, ariaLabel: t('workspace.containers.search') });
  search.addEventListener('input', () => {
    store.workspace.search = search.value;
    refresh();
  });
  const status = selectionStatus();
  return el('aside', { className: 'workspace-pane containers-pane', ariaLabel: t('workspace.containers.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.containers.title') }),
        el('p', { className: 'muted', text: status }),
      ]),
      button(`+ ${t('workspace.containers.add')}`, () => {
        store.workspace.addContainerOpen = !store.workspace.addContainerOpen;
        refresh();
      }, { className: 'button primary' }),
    ]),
    search,
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.all'), () => {}, { className: 'button chip' }),
      button(t('workspace.containers.filter'), () => {}, { className: 'button chip' }),
      button(t('workspace.containers.selectAll'), () => {
        store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'selectAllVisible' });
        refresh();
      }, { className: 'button chip' }),
      button(t('workspace.containers.clear'), () => {
        store.workspace.selection = reduceDeviceSelection(store.workspace.selection, devices, { type: 'clear' });
        refresh();
      }, { className: 'button chip' }),
    ]),
    store.workspace.addContainerOpen ? addContainerForm(refresh) : null,
    devices.length ? deviceList(devices, refresh) : el('p', { className: 'empty-state', text: t('workspace.containers.empty') }),
    store.containers.length ? managedContainerActions(refresh) : null,
  ]);
}

function addContainerForm(refresh) {
  const name = el('input', { type: 'text', value: '', placeholder: t('workspace.containers.namePlaceholder') });
  const image = el('input', { type: 'text', value: 'war-browser-agent:phase1', placeholder: t('workspace.containers.imagePlaceholder') });
  const dockerName = el('input', { type: 'text', value: '', placeholder: t('workspace.containers.dockerNamePlaceholder') });
  const status = el('p', { className: 'status', text: store.workspace.containerNotice || '' });
  return el('article', { className: 'prototype-note', role: 'form', ariaLabel: t('workspace.containers.add') }, [
    el('strong', { text: t('workspace.containers.add') }),
    field(t('workspace.containers.name'), name),
    field(t('workspace.containers.image'), image),
    field(t('workspace.containers.dockerName'), dockerName),
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.create'), async () => {
        const payload = {
          name: name.value.trim(),
          image: image.value.trim() || undefined,
          runtime: dockerName.value.trim() ? { dockerName: dockerName.value.trim() } : undefined,
        };
        if (!payload.name) {
          store.workspace.containerNotice = t('workspace.containers.nameRequired');
          status.textContent = store.workspace.containerNotice;
          return;
        }
        const result = await window.warController.containers.add(payload);
        if (result?.ok === false) {
          store.workspace.containerNotice = `${result.code || 'ERROR'}: ${result.message || 'Request failed'}`;
          status.textContent = store.workspace.containerNotice;
          return;
        }
        store.workspace.containerNotice = t('workspace.containers.createRequested');
        await refreshAll();
        refresh();
      }, { className: 'button primary' }),
    ]),
    status,
  ]);
}

function managedContainerActions(refresh) {
  return el('div', { className: 'device-list', ariaLabel: t('workspace.containers.managed') },
    store.containers.map((container) => {
      const disabled = container.status === 'deleted' || container.status === 'deleting';
      const status = normalizeDeviceStatus(container);
      return el('article', { className: 'device-card managed-container' }, [
        el('span', { className: 'device-name', text: container.name || container.id }),
        el('span', { className: `status-pill ${status}`, text: t(`status.${status}`) }),
        el('span', { className: 'device-meta', text: container.runtime?.dockerName || shortId(container.id) }),
        el('span', { className: 'device-meta', text: usageSummary(container.resourceUsage) }),
        container.lastError ? el('span', { className: 'device-meta error', text: container.lastError }) : null,
        el('div', { className: 'toolbar tight' }, [
          button(t('workspace.containers.start'), () => containerAction('start', container.id, refresh), { className: 'button chip', disabled }),
          button(t('workspace.containers.stop'), () => containerAction('stop', container.id, refresh), { className: 'button chip', disabled }),
          button(t('workspace.containers.restart'), () => containerAction('restart', container.id, refresh), { className: 'button chip', disabled }),
          button(t('workspace.containers.refreshStatus'), () => containerAction('refresh', container.id, refresh), { className: 'button chip', disabled }),
          button(t('workspace.containers.duplicate'), () => duplicateContainer(container, refresh), { className: 'button chip', disabled }),
          button(t('workspace.containers.delete'), () => containerAction('delete', container.id, refresh), { className: 'button chip', disabled }),
        ]),
      ]);
    }));
}

async function containerAction(action, containerId, refresh) {
  const result = await window.warController.containers[action]({ containerId });
  store.workspace.containerNotice = result?.ok === false ? `${result.code || 'ERROR'}: ${result.message || 'Request failed'}` : t('workspace.containers.actionDone');
  await refreshAll();
  refresh();
}

async function duplicateContainer(container, refresh) {
  const result = await window.warController.containers.duplicate({ containerId: container.id, name: `${container.name || container.id} copy` });
  store.workspace.containerNotice = result?.ok === false ? `${result.code || 'ERROR'}: ${result.message || 'Request failed'}` : t('workspace.containers.actionDone');
  await refreshAll();
  refresh();
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
  const card = el('button', {
    className: selected ? 'device-card selected' : 'device-card',
    role: 'option',
    ariaSelected: selected,
    ariaLabel: `${name} ${t(`status.${status}`)}`,
  }, [
    el('span', { className: 'device-name', text: name }),
    el('span', { className: `status-pill ${status}`, text: t(`status.${status}`) }),
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

function inputPane(selected, refresh) {
  return el('section', { className: 'workspace-pane input-pane', ariaLabel: t('workspace.input.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.input.title') }),
        el('p', { className: 'muted', text: t('workspace.input.draft') }),
      ]),
    ]),
    inputTabs(refresh),
    inputModeContent(selected),
    inputSummary(selected),
  ]);
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
  const devices = [
    ...store.devices,
    ...store.containers.map((container) => ({
      ...container,
      displayName: container.name,
      agentVersion: container.image,
      groupIds: [],
      lastSeenAt: container.updatedAt,
    })),
  ];
  if (!query) return devices;
  return devices.filter((device) => {
    const text = [device.id, device.deviceId, device.displayName, device.name, device.status].filter(Boolean).join(' ').toLowerCase();
    return text.includes(query);
  });
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

function inputModeContent(selected) {
  if (store.workspace.activeInputMode === 'grid') return gridInputPreview(selected);
  if (store.workspace.activeInputMode === 'picker') return pickerInputPreview();
  const textarea = el('textarea', {
    rows: 7,
    placeholder: 'group: 1\ndữ liệu ô 1|dữ liệu ô 2|dữ liệu ô 3 (máy 1)\ndữ liệu ô 1|dữ liệu ô 2|dữ liệu ô 3 (máy 2)',
  });
  return el('div', { className: 'input-mode' }, [
    field(t('workspace.input.textareaLabel'), textarea),
    el('p', { className: 'muted', text: `${t('workspace.input.separator')}: |` }),
    el('p', { className: 'muted', text: t('workspace.input.validation') }),
  ]);
}

function gridInputPreview(selected) {
  const rows = selected.length ? selected : store.devices.slice(0, 3);
  return el('div', { className: 'input-mode' }, [
    el('div', { className: 'group-chip', text: t('workspace.input.group') }),
    table([
      { key: 'machine', label: t('workspace.input.machine') },
      { key: 'cell1', label: t('workspace.input.cell1') },
      { key: 'cell2', label: t('workspace.input.cell2') },
      { key: 'cell3', label: t('workspace.input.cell3') },
    ], rows.map((device, index) => ({
      machine: device.displayName || device.name || device.deviceId || `${t('workspace.input.machine')} ${index + 1}`,
      cell1: `${t('workspace.input.cell1')} ${index + 1}`,
      cell2: `${t('workspace.input.cell2')} ${index + 1}`,
      cell3: `${t('workspace.input.cell3')} ${index + 1}`,
    }))),
  ]);
}

function pickerInputPreview() {
  return el('div', { className: 'input-mode picker-mode' }, [
    el('p', { text: t('workspace.input.chooseMachine') }),
    button(t('workspace.input.chooseCell'), () => {}, { disabled: true }),
    el('p', { text: t('workspace.input.pickedCount') }),
    el('p', { className: 'muted', text: t('workspace.input.pickerUnavailable') }),
  ]);
}

function inputSummary(selected) {
  return el('dl', { className: 'metric-grid compact-grid' }, [
    el('dt', { text: t('workspace.input.selectedMachines') }),
    el('dd', { text: selected.length }),
    el('dt', { text: t('workspace.input.groups') }),
    el('dd', { text: 1 }),
    el('dt', { text: t('workspace.input.targets') }),
    el('dd', { text: 3 }),
    el('dt', { text: t('workspace.input.totalValues') }),
    el('dd', { text: selected.length * 3 }),
  ]);
}

function graphPane(refresh) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const toggle = button(layout.graphCollapsed ? t('workspace.graph.expand') : t('workspace.graph.collapse'), async () => {
    store.settings.workspace = { ...layout, graphCollapsed: !layout.graphCollapsed };
    await window.warController.settings.update({ workspace: store.settings.workspace });
    refresh();
  }, { className: 'button compact' });
  return el('section', { className: 'workspace-pane graph-pane', ariaLabel: t('workspace.graph.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.graph.title') }),
        el('p', { className: 'muted', text: t('workspace.graph.sampleNotice') }),
      ]),
      toggle,
    ]),
    graphResizeHandle(refresh),
    graphToolbar(),
    layout.graphCollapsed ? el('p', { className: 'empty-state', text: t('workspace.graph.title') }) : graphCanvas(),
  ]);
}

function graphResizeHandle(refresh) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const handle = el('div', {
    className: 'resize-handle',
    role: 'separator',
    ariaLabel: t('workspace.graph.title'),
    ariaOrientation: 'vertical',
    ariaValueMin: 480,
    ariaValueMax: 1600,
    ariaValueNow: 900,
    tabIndex: 0,
  });
  handle.addEventListener('keydown', async (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? -20 : 20;
    store.settings.workspace = { ...layout, centerWidth: Math.max(320, Math.min(600, layout.centerWidth - delta)) };
    await window.warController.settings.update({ workspace: store.settings.workspace });
    refresh();
  });
  return handle;
}

function graphToolbar() {
  return el('div', { className: 'graph-toolbar', role: 'toolbar', ariaLabel: t('workspace.graph.title') }, [
    button('+', () => {}, { className: 'icon-button', disabled: false }),
    button('-', () => {}, { className: 'icon-button', disabled: false }),
    button(t('workspace.graph.fit'), () => {}, { className: 'button compact' }),
    button(t('workspace.graph.reset'), () => {}, { className: 'button compact' }),
    button(t('workspace.graph.undo'), () => {}, { className: 'button compact', disabled: true }),
    button(t('workspace.graph.redo'), () => {}, { className: 'button compact', disabled: true }),
  ]);
}

function graphCanvas() {
  return el('div', { className: 'graph-canvas', tabIndex: 0, ariaLabel: t('workspace.graph.title') }, [
    edgeLayer(),
    ...WORKSPACE_SAMPLE_NODES.map((node) => graphNode(node)),
  ]);
}

function edgeLayer() {
  return el('div', { className: 'graph-edges', ariaLabel: '' }, [
    el('span', { className: 'graph-edge edge-one', text: '' }),
    el('span', { className: 'graph-edge edge-two', text: '' }),
  ]);
}

function graphNode(node) {
  const item = el('article', { className: `graph-node ${node.type}` }, [
    el('div', { className: 'graph-node-header' }, [
      el('strong', { text: `Bước ${node.title}` }),
      button('×', () => {}, { className: 'node-delete', disabled: true }),
      el('span', { className: 'origin-badge strong', text: t('workspace.containers.origin') }),
    ]),
    el('div', { className: 'graph-node-body' }, [
      el('span', { className: 'port input-port', text: '' }),
      el('label', { className: 'delay-field' }, [
        el('span', { text: `${t('workspace.graph.delay')}:` }),
        el('input', { type: 'number', value: node.delay, disabled: true, ariaLabel: t('workspace.graph.delay') }),
        el('span', { text: 'ms' }),
      ]),
      el('span', { className: 'order-badge', text: node.badge }),
      el('input', { type: 'text', value: node.body, disabled: true, ariaLabel: node.type === 'input' ? t('workspace.graph.input') : t('workspace.graph.selector') }),
      el('span', { className: 'port output-port', text: '' }),
    ]),
  ]);
  if (item.style?.setProperty) {
    item.style.setProperty('--node-x', `${node.x}px`);
    item.style.setProperty('--node-y', `${node.y}px`);
  }
  return item;
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
    ], store.pairings.paired),
    ...store.pairings.paired.map((agent) => el('div', { className: 'row-actions' }, [
      el('span', { text: agent.deviceId }),
      button('Revoke', async () => { await window.warController.pairings.revoke({ deviceId: agent.deviceId }); await refreshAll(); refresh(); }),
    ])),
    el('h3', { text: 'One-time credential' }),
    secretBox,
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
  const originDevice = el('select', {}, [
    el('option', { value: '', text: 'Select origin device' }),
    ...store.sessions.filter((session) => session.status === 'online').map((session) => el('option', { value: session.deviceId, text: session.deviceId })),
  ]);
  const conflictPolicy = el('select', {}, [
    el('option', { value: 'preserveBoth', text: 'Preserve both' }),
    el('option', { value: 'skip', text: 'Skip conflicts' }),
  ]);
  const status = el('p', { className: 'status' });
  return section('Workflows', [
    el('h3', { text: 'Origin synchronization' }),
    field('Origin device', originDevice),
    field('Conflict policy', conflictPolicy),
    el('div', { className: 'toolbar' }, [
      button('Preview origin pull', async () => {
        if (!originDevice.value) { status.textContent = 'Select one connected origin device'; return; }
        const result = await window.warController.workflows.originPreview({ deviceId: originDevice.value });
        store.originSyncPreview = unwrap(result);
        setStatus(status, result, 'Origin preview loaded');
        refresh();
      }),
      button('Pull from origin', async () => {
        if (!originDevice.value) { status.textContent = 'Select one connected origin device'; return; }
        const result = await window.warController.workflows.originPull({ deviceId: originDevice.value, conflictPolicy: conflictPolicy.value });
        store.originSyncResult = unwrap(result);
        setStatus(status, result, 'Origin pull completed');
        await refreshAll();
        refresh();
      }),
    ]),
    store.originSyncPreview ? originPreviewPanel() : null,
    store.originSyncResult ? codeBlock(store.originSyncResult) : null,
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
    store.selectedWorkflow ? workflowDetails(store.selectedWorkflow) : el('p', { text: 'Select a workflow revision to inspect safe metadata.' }),
  ]);
}

function originPreviewPanel() {
  return el('article', { className: 'item-row' }, [
    el('div', {}, [
      el('strong', { text: `Origin workflows: ${store.originSyncPreview.counts?.workflows || 0}` }),
      table([
        { key: 'workflowId', label: 'Workflow' },
        { key: 'revision', label: 'Revision' },
        { key: 'name', label: 'Name' },
        { key: 'action', label: 'Action' },
        { key: 'conflict', label: 'Conflict' },
      ], store.originSyncPreview.workflows || []),
    ]),
  ]);
}

function workflowDetails(workflow) {
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
    codeBlock(workflow.profilePayload || {}),
  ]);
}

function jobsView(refresh) {
  const device = select('Device', store.devices.map((item) => [item.id, item.name || item.id]));
  const workflow = select('Workflow', store.workflows.map((item) => [`${item.workflowId}:${item.revision}`, `${item.workflowId} rev ${item.revision}`]));
  const deadline = el('input', { type: 'number', min: 10, max: 86400, step: 1, value: '300' });
  const payload = el('textarea', { rows: 8, placeholder: '{"inputName":"value"}' });
  const status = el('p', { className: 'status' });
  status.textContent = store.lastJobNotice || '';
  return section('Jobs', [
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
  return section('Diagnostics', [
    metricGrid([
      ['Application version', runtime.applicationVersion || store.bootstrap?.applicationVersion || 'unknown'],
      ['Protocol version', runtime.protocolVersion || 'v1'],
      ['WSS status', runtime.status || 'unknown'],
      ['Safe bind host', runtime.bindHost || '127.0.0.1'],
      ['Port', runtime.port ?? 0],
      ['Store', runtime.storeStatus || 'loaded'],
      ['Last refresh', store.lastRefresh || 'never'],
    ]),
    button('Refresh diagnostics', refresh),
  ]);
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
