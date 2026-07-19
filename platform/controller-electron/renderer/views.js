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
  const ipv4Enabled = el('input', { type: 'checkbox', checked: true });
  const ipv6Enabled = el('input', { type: 'checkbox', checked: false });
  const ipv6Suffix = el('input', { type: 'text', value: '', placeholder: t('workspace.containers.ipv6SuffixPlaceholder'), disabled: true });
  ipv6Enabled.addEventListener('change', () => {
    ipv6Suffix.disabled = !ipv6Enabled.checked;
  });
  const status = el('p', { className: 'status', text: store.workspace.containerNotice || '', ariaLive: 'polite' });
  const createDisabled = store.workspace.addContainerPending === true;
  return el('article', { className: 'prototype-note', role: 'form', ariaLabel: t('workspace.containers.add') }, [
    el('strong', { text: t('workspace.containers.add') }),
    field(t('workspace.containers.name'), name),
    field(t('workspace.containers.image'), image),
    field(t('workspace.containers.dockerName'), dockerName),
    field(t('workspace.containers.ipv4Enabled'), ipv4Enabled),
    field(t('workspace.containers.ipv6Enabled'), ipv6Enabled),
    field(t('workspace.containers.ipv6Suffix'), ipv6Suffix),
    el('div', { className: 'toolbar tight' }, [
      button(t('workspace.containers.create'), async () => {
        if (store.workspace.addContainerPending) return;
        const payload = {
          name: name.value.trim(),
          image: image.value.trim() || undefined,
          runtime: {
            ...(dockerName.value.trim() ? { dockerName: dockerName.value.trim() } : {}),
            ipv4Enabled: ipv4Enabled.checked,
            ipv6Enabled: ipv6Enabled.checked,
            ipv6Suffix: ipv6Enabled.checked ? ipv6Suffix.value.trim() : null,
          },
        };
        if (!payload.name) {
          store.workspace.containerNotice = t('workspace.containers.nameRequired');
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
          store.workspace.containerNotice = t('workspace.containers.createRequested');
          await refreshAll();
        } catch (error) {
          store.workspace.containerNotice = safeError({ code: 'ERROR', message: error.message });
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
    store.containers.map((container) => {
      const pendingAction = store.workspace.containerPending?.[container.id] || '';
      const displayStatus = pendingAction ? pendingStatus(pendingAction) : normalizeDeviceStatus(container);
      const terminalDisabled = container.status === 'deleted' || container.status === 'deleting';
      const busy = Boolean(pendingAction) || ['creating', 'pairing', 'starting', 'stopping', 'restarting', 'deleting'].includes(container.status);
      const error = store.workspace.containerErrors?.[container.id] || container.lastError;
      const agentOnline = isContainerAgentOnline(container);
      return el('article', { className: 'device-card managed-container' }, [
        el('span', { className: 'device-name', text: container.name || container.id }),
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
          button(t('workspace.containers.refreshStatus'), () => containerAction('refresh', container, refresh), { className: 'button chip', disabled: terminalDisabled || Boolean(pendingAction) }),
          button(t('workspace.containers.networkSettings'), () => {
            store.workspace.containerNetworkOpenId = store.workspace.containerNetworkOpenId === container.id ? '' : container.id;
            refresh();
          }, { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.duplicate'), () => duplicateContainer(container, refresh), { className: 'button chip', disabled: terminalDisabled || busy }),
          button(t('workspace.containers.delete'), () => containerAction('delete', container, refresh), { className: 'button chip danger', disabled: terminalDisabled || busy }),
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
  });
  ipv6Enabled.addEventListener('change', () => {
    ipv6Suffix.disabled = !ipv6Enabled.checked;
  });
  return el('div', { className: 'network-settings' }, [
    field(t('workspace.containers.ipv4Enabled'), ipv4Enabled),
    field(t('workspace.containers.ipv6Enabled'), ipv6Enabled),
    field(t('workspace.containers.ipv6Suffix'), ipv6Suffix),
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
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError({ code: 'ERROR', message: error.message }) };
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
    if (!window.confirm(t('workspace.containers.deleteConfirm', { name: label, id: container.id }))) return;
  }
  store.workspace.containerPending = { ...store.workspace.containerPending, [containerId]: action };
  store.workspace.containerNotice = t('workspace.containers.actionPending', { action: t(`workspace.containers.${action}`), name: container.name || container.id });
  refresh();
  try {
    const result = await window.warController.containers[action]({ containerId });
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
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError({ code: 'ERROR', message: error.message }) };
    store.workspace.containerNotice = store.workspace.containerErrors[containerId];
  } finally {
    const { [containerId]: _clearedPending, ...remainingPending } = store.workspace.containerPending || {};
    store.workspace.containerPending = remainingPending;
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
    store.workspace.containerErrors = { ...store.workspace.containerErrors, [containerId]: safeError({ code: 'ERROR', message: error.message }) };
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
  if (action === 'delete') return 'deleting';
  if (action === 'duplicate') return 'creating';
  if (action === 'network') return 'restarting';
  return 'creating';
}

function safeError(result) {
  return `${result?.code || 'ERROR'}: ${result?.message || 'Request failed'}`.slice(0, 300);
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
    store.originSync.error = safeError({ code: 'ERROR', message: error.message });
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
    store.graphEditor.error = safeError({ code: error.code || 'ERROR', message: error.message });
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
    store.groupedInput.error = safeError({ code: error.code || 'ERROR', message: error.message });
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
