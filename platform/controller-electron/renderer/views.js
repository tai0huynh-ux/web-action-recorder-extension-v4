import { button, codeBlock, el, field, parseJsonInput, section, setStatus, stableJson, svgEl, table } from './dom.js';
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
  const selected = selectedDevices(allWorkspaceDevices(), store.workspace.selection);
  const root = el('section', { className: layout.graphCollapsed ? 'workspace-view graph-collapsed' : 'workspace-view', ariaLabel: t('navigation.workspace') }, [
    workspaceMobileToolbar(refresh),
    containersPane(refresh, workspacePaneActive('containers')),
    inputPane(selected, refresh, workspacePaneActive('input')),
    graphPane(refresh, workspacePaneActive('graph')),
  ]);
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
  return el('aside', { className: workspacePaneClass('containers-pane', active), ariaLabel: t('workspace.containers.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.containers.title') }),
        el('p', { className: 'muted', text: status }),
      ]),
      el('div', { className: 'toolbar tight' }, [
        button(t('workspace.containers.checkAll'), () => refreshAllContainers(refresh), { className: 'button compact', disabled: store.workspace.containerAllPending || !store.containers.length }),
        button(`+ ${t('workspace.containers.add')}`, async () => {
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
    store.containers.length ? managedContainerActions(refresh) : null,
  ]);
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
    const data = unwrap(result) || {};
    store.workspace.containerHosts = Array.isArray(data.hosts) ? data.hosts.filter((host) => host?.connected && host.id) : [];
    store.workspace.containerHostStatus = data.status || (store.workspace.containerHosts.length ? 'connected' : 'unavailable');
    if (!store.workspace.containerHosts.some((host) => host.id === store.workspace.containerHostId)) {
      store.workspace.containerHostId = store.workspace.containerHosts[0]?.id || '';
    }
    store.workspace.containerNotice = store.workspace.containerHosts.length
      ? t('workspace.containers.hostConnected')
      : t('workspace.containers.hostUnavailable');
  } catch (error) {
    store.workspace.containerHosts = [];
    store.workspace.containerHostId = '';
    store.workspace.containerHostStatus = 'unavailable';
    store.workspace.containerNotice = t('workspace.containers.hostUnavailable');
  } finally {
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
    el('option', { value: '', text: hosts.length ? t('workspace.containers.selectHost') : t('workspace.containers.noHost') }),
    ...hosts.map((item) => el('option', { value: item.id, text: containerHostLabel(item) })),
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
    el('strong', { text: t('workspace.containers.add') }),
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
        ariaLabel: t('workspace.containers.deleteConfirm', { name, id: managedContainer.id }),
        title: t('workspace.containers.delete'),
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
  return el('section', { className: workspacePaneClass('input-pane', active), ariaLabel: t('workspace.input.title') }, [
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
  const managedByDevice = new Map(store.containers.map((container) => [container.deviceId, container]));
  const devices = store.devices.map((device) => {
    const container = managedByDevice.get(device.id || device.deviceId);
    return container ? { ...device, managedContainer: true, containerId: container.id, containerName: container.name, containerHost: container.host } : device;
  });
  const known = new Set(devices.map((device) => device.id || device.deviceId));
  return [...devices, ...store.containers.filter((container) => !known.has(container.deviceId)).map((container) => ({
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
  if (host.label) return `${host.label} - ${t('workspace.containers.hostConnectedShort')}`;
  const runtime = host.runtime === 'local-docker'
    ? t('workspace.containers.localDockerHost')
    : t('workspace.containers.sshDockerHost');
  return `${runtime} - ${t('workspace.containers.hostConnectedShort')}`;
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
  if (action === 'delete') return 'deleting';
  if (action === 'duplicate') return 'creating';
  if (action === 'network') return 'restarting';
  return 'creating';
}

function safeError(result) {
  return `${result?.code || 'ERROR'}: ${result?.message || 'Request failed'}`.slice(0, 300);
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

function graphPane(refresh, active = false) {
  const layout = clampWorkspaceLayout(store.settings?.workspace);
  const toggle = button(layout.graphCollapsed ? t('workspace.graph.expand') : t('workspace.graph.collapse'), async () => {
    store.settings.workspace = { ...layout, graphCollapsed: !layout.graphCollapsed };
    await window.warController.settings.update({ workspace: store.settings.workspace });
    refresh();
  }, { className: 'button compact' });
  const nodes = workspaceGraphNodes();
  const canvas = graphCanvas(nodes, refresh);
  return el('section', { className: workspacePaneClass('graph-pane', active), ariaLabel: t('workspace.graph.title') }, [
    el('div', { className: 'pane-header' }, [
      el('div', {}, [
        el('h2', { text: t('workspace.graph.title') }),
        el('p', { className: 'muted', text: t('workspace.graph.draftNotice') }),
      ]),
      toggle,
    ]),
    graphResizeHandle(refresh),
    graphGroupToolbar(refresh),
    graphToolbar(canvas, nodes, refresh),
    layout.graphCollapsed ? el('p', { className: 'empty-state', text: t('workspace.graph.title') }) : canvas,
  ]);
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
    if (!editing && node.type === 'input') toggleGraphGroupNode(node.id, refresh);
    else selectGraphNode(node.id, refresh);
  });
  installGraphNodeDrag(item, node, refresh, editing);
  item.addEventListener('keydown', (event) => {
    if (event.target !== item) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectGraphNode(node.id, refresh);
  });
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
  if (!node || node.type !== 'input') {
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

function zoomGraphViewport(canvas, delta, refresh) {
  const current = normalizeGraphViewport(store.workspace.graphViewport);
  const scale = Math.max(0.5, Math.min(1.6, Number((current.scale + delta).toFixed(2))));
  const width = Number(canvas?.clientWidth) || 900;
  const height = Number(canvas?.clientHeight) || 620;
  const ratio = scale / current.scale;
  store.workspace.graphViewport = {
    scale,
    offsetX: width / 2 - ((width / 2) - current.offsetX) * ratio,
    offsetY: height / 2 - ((height / 2) - current.offsetY) * ratio,
  };
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
