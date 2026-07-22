import test from 'node:test';
import assert from 'node:assert/strict';

class FakeNode {}

class FakeText extends FakeNode {
  constructor(value) {
    super();
    this.value = String(value);
  }

  get textContent() {
    return this.value;
  }

  set textContent(value) {
    this.value = String(value);
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.localName = tag.toLowerCase();
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.checked = false;
    this.multiple = false;
    this.size = 0;
    this.value = '';
    this.type = '';
    this.name = '';
    this.id = '';
    this.rows = 0;
    this.placeholder = '';
    this._text = '';
    const styleProperties = new Map();
    this.style = {
      setProperty(name, value) { styleProperties.set(name, String(value)); },
      getPropertyValue(name) { return styleProperties.get(name) || ''; },
    };
  }

  get options() {
    return this.childNodes.filter((child) => child instanceof FakeElement && child.localName === 'option');
  }

  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value) {
    this._text = String(value);
    this.childNodes = [];
  }

  get htmlFor() {
    return this.getAttribute('for') || '';
  }

  set htmlFor(value) {
    this.setAttribute('for', value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || '';
  }

  replaceChildren(...children) {
    this._text = '';
    this.childNodes = children;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  async click() {
    for (const listener of this.listeners.get('click') || []) {
      await listener({ currentTarget: this });
    }
  }
}

installFakeDom();
installControllerApi();

const dom = await import('../renderer/dom.js');
const errors = await import('../renderer/errors.js');
const i18n = await import('../renderer/i18n.js');
const state = await import('../renderer/state.js');
const views = await import('../renderer/views.js');
const workspaceState = await import('../renderer/workspaceState.js');

test('button created with text retains visible text', () => {
  const node = dom.button('Create', () => {});
  assert.equal(node.textContent, 'Create');
});

test('heading created with text retains visible text', () => {
  const node = dom.section('Overview', []);
  assert.equal(first(node, 'h2').textContent, 'Overview');
});

test('table header retains visible text', () => {
  const node = dom.table([{ key: 'id', label: 'Job' }], [{ id: 'job-1' }]);
  assert.equal(first(node, 'th').textContent, 'Job');
});

test('empty state retains visible text', () => {
  const node = dom.table([{ key: 'id', label: 'Job' }], []);
  assert.equal(first(node, 'td').textContent, 'No records');
});

test('nested IPC errors keep their code and message without object coercion', () => {
  const result = { ok: false, error: { code: 'SSH_AUTH_FAILED', message: 'SSH authentication failed' } };
  assert.equal(errors.safeError(result), 'SSH_AUTH_FAILED: SSH authentication failed');
  assert.equal(errors.safeError(result).includes('[object Object]'), false);
  const error = errors.controllerError(result, 'SSH_HOST_ERROR');
  assert.equal(error.code, 'SSH_AUTH_FAILED');
  assert.equal(error.message, 'SSH authentication failed');
});

test('text-only element is not cleared by child replacement default', () => {
  const node = dom.el('p', { text: 'Select a job to inspect persisted and execution state.' });
  assert.equal(node.textContent, 'Select a job to inspect persisted and execution state.');
});

test('element with explicit children renders them correctly', () => {
  const node = dom.el('div', { text: 'ignored when children are explicit' }, [
    dom.el('span', { text: 'Child' }),
  ]);
  assert.equal(node.textContent, 'Child');
});

test('nested text nodes remain visible and nullish children are ignored', () => {
  const node = dom.el('div', {}, [
    dom.el('span', { text: 'Nested' }),
    undefined,
    null,
    0,
    false,
  ]);
  assert.equal(node.textContent, 'Nested0false');
});

test('all navigation controls receive non-empty Vietnamese names by default', () => {
  const buttons = state.views.map((view) => dom.button(state.navLabel(view), () => {}));
  assert.deepEqual(buttons.map(accessibleName), [
    'Workspace',
    'Điều khiển trực tiếp',
    'Tổng quan',
    'Ghép nối',
    'Thiết bị',
    'Nhóm',
    'Quy trình',
    'Tác vụ',
    'Chẩn đoán',
    'Thùng rác',
  ]);
});

test('locale defaults to Vietnamese, switches at runtime, persists, and falls back safely', async () => {
  apiState.settingsUpdates = [];
  await i18n.initLocale({ locale: 'vi' });
  assert.equal(i18n.t('navigation.devices'), 'Thiết bị');
  await i18n.setLocale('en');
  assert.equal(i18n.t('navigation.devices'), 'Devices');
  assert.deepEqual(apiState.settingsUpdates.at(-1), { locale: 'en' });
  assert.equal(i18n.t('missing.key'), 'missing.key');
  assert.equal(i18n.localeKeysMatch(), true);
  await i18n.setLocale('vi');
});

test('workspace renders three panels and accessible prototype controls', () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.devices = [deviceFixture('dev-a', 'Máy 1'), deviceFixture('dev-b', 'Máy 2')];
  const rendered = views.renderView(() => {});
  assert.equal(all(rendered, (node) => node.className.includes('workspace-pane')).length, 3);
  assert.ok(rendered.textContent.includes('Máy và container'));
  assert.ok(rendered.textContent.includes('Cấu hình nhập liệu'));
  assert.ok(rendered.textContent.includes('Luồng hành động'));
  assert.ok(accessibleName(all(rendered, (node) => node.localName === 'button' && node.textContent.includes('Thêm container'))[0]).includes('Thêm container'));
});

test('container and Linux host setup sections expose working collapse controls', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, `+ ${i18n.t('workspace.containers.addHost')}`);
  assert.ok(all(current, (node) => node.className === 'host-setup-card').length);
  await clickButton(current, i18n.t('workspace.containers.collapseHostSetup'));
  assert.equal(all(current, (node) => node.className === 'host-setup-card').length, 0);

  await clickButton(current, `+ ${i18n.t('workspace.containers.add')}`);
  assert.ok(all(current, (node) => node.getAttribute('role') === 'form' && node.getAttribute('aria-label') === i18n.t('workspace.containers.add')).length);
  await clickButton(current, i18n.t('workspace.containers.collapseAdd'));
  assert.equal(all(current, (node) => node.className === 'prototype-note').length, 0);
});

test('workspace exposes two accessible draggable panel separators and stable scroll keys', () => {
  resetStore();
  state.store.view = 'workspace';
  const rendered = views.renderView(() => {});
  const separators = all(rendered, (node) => node.getAttribute('role') === 'separator');
  assert.deepEqual(separators.map(accessibleName), [
    i18n.t('workspace.resize.machinesInput'),
    i18n.t('workspace.resize.inputGraph'),
  ]);
  assert.deepEqual(all(rendered, (node) => node.getAttribute('data-scroll-key')).map((node) => node.getAttribute('data-scroll-key')), [
    'workspace-machines',
    'workspace-input',
    'workspace-graph',
  ]);
});

test('workspace panel separators drag, clamp, and persist exactly once on release', async () => {
  resetStore();
  state.store.view = 'workspace';
  const rendered = views.renderView(() => {});
  const machinesHandle = all(rendered, (node) => node.className.includes('machines-input-resize'))[0];
  await fireWithEvent(machinesHandle, 'pointerdown', { button: 0, pointerId: 7, clientX: 100, preventDefault() {} });
  await dispatchGlobal('pointermove', { pointerId: 7, clientX: 350 });
  assert.equal(rendered.style.getPropertyValue('--workspace-left'), '380px');
  assert.equal(apiState.settingsUpdates.length, 0);
  await dispatchGlobal('pointerup', { pointerId: 7 });
  assert.deepEqual(apiState.settingsUpdates, [{ workspace: { leftWidth: 380, centerWidth: 420, graphCollapsed: false } }]);

  apiState.settingsUpdates = [];
  const rerendered = views.renderView(() => {});
  const inputHandle = all(rerendered, (node) => node.className.includes('input-graph-resize'))[0];
  await fireWithEvent(inputHandle, 'pointerdown', { button: 0, pointerId: 8, clientX: 500, preventDefault() {} });
  await dispatchGlobal('pointermove', { pointerId: 8, clientX: 200 });
  assert.equal(rerendered.style.getPropertyValue('--workspace-center'), '320px');
  await dispatchGlobal('pointerup', { pointerId: 8 });
  assert.deepEqual(apiState.settingsUpdates, [{ workspace: { leftWidth: 380, centerWidth: 320, graphCollapsed: false } }]);
});

test('workspace panel separator keyboard control persists and canceled drag cleans up', async () => {
  resetStore();
  state.store.view = 'workspace';
  const rendered = views.renderView(() => {});
  const machinesHandle = all(rendered, (node) => node.className.includes('machines-input-resize'))[0];
  await fireWithEvent(machinesHandle, 'keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(machinesHandle.getAttribute('aria-valuenow'), '300');
  assert.deepEqual(apiState.settingsUpdates.at(-1), { workspace: { leftWidth: 300, centerWidth: 420, graphCollapsed: false } });

  apiState.settingsUpdates = [];
  const rerendered = views.renderView(() => {});
  const inputHandle = all(rerendered, (node) => node.className.includes('input-graph-resize'))[0];
  await fireWithEvent(inputHandle, 'pointerdown', { button: 0, pointerId: 9, clientX: 400, preventDefault() {} });
  await dispatchGlobal('pointermove', { pointerId: 9, clientX: 500 });
  assert.equal(rerendered.style.getPropertyValue('--workspace-center'), '520px');
  await dispatchGlobal('pointercancel', { pointerId: 9 });
  assert.equal(rerendered.style.getPropertyValue('--workspace-center'), '420px');
  assert.equal(apiState.settingsUpdates.length, 0);
  assert.equal(inputHandle.className.includes('is-resizing'), false);
  assert.equal(globalThis.__fakeGlobalListeners.get('pointermove')?.length || 0, 0);
  assert.equal(globalThis.__fakeGlobalListeners.get('pointerup')?.length || 0, 0);
  assert.equal(globalThis.__fakeGlobalListeners.get('pointercancel')?.length || 0, 0);
});

test('workspace selected machine count updates', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.devices = [deviceFixture('dev-a', 'Máy 1'), deviceFixture('dev-b', 'Máy 2')];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await all(current, (node) => node.getAttribute('role') === 'option' && node.textContent.includes('Máy 1'))[0].click();
  assert.equal(state.store.workspace.selection.selectedIds.has('dev-a'), true);
  current = views.renderView(() => {});
  assert.ok(current.textContent.includes('Đã chọn 1 máy'));
});

test('workspace device filter changes the visible device list', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.devices = [deviceFixture('dev-online', 'Online'), { ...deviceFixture('dev-offline', 'Offline'), status: 'offline' }];
  state.store.containers = [containerFixture()];
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, i18n.t('workspace.containers.filter'));
  const filter = all(current, (node) => node.localName === 'select' && accessibleName(node) === i18n.t('workspace.containers.filter'))[0];
  filter.value = 'containers';
  await fire(filter, 'change');

  const cards = all(current, (node) => node.className === 'device-card' && node.getAttribute('role') === 'option');
  assert.equal(cards.length, 1);
  assert.ok(cards[0].textContent.includes('Agent One'));
});

test('workspace text, grid, and cell picker controls retain editable draft state', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.devices = [deviceFixture('dev-a', 'Máy 1')];
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await all(current, (node) => node.className.includes('device-card'))[0].click();

  const textarea = first(current, 'textarea');
  textarea.value = 'a|b\nc';
  await fire(textarea, 'input');
  assert.equal(state.store.workspace.inputDraft, 'a|b\nc');
  assert.ok(current.textContent.includes(i18n.t('workspace.input.validationMismatch', { rows: '2' })));

  await clickButton(current, i18n.t('workspace.input.grid'));
  const gridInput = all(current, (node) => node.localName === 'input' && node.getAttribute('aria-label').includes(i18n.t('workspace.input.cell1')))[0];
  gridInput.value = 'grid value';
  await fire(gridInput, 'input');
  await fire(gridInput, 'change');
  assert.equal(state.store.workspace.inputGrid['dev-a'][0], 'grid value');
  assert.ok(all(current, (node) => node.localName === 'input').some((node) => node.value === 'grid value'));

  await clickButton(current, i18n.t('workspace.input.picker'));
  await clickButton(current, i18n.t('workspace.input.cell1'));
  assert.deepEqual(state.store.workspace.pickedCells, [1]);
  assert.ok(current.textContent.includes(i18n.t('workspace.input.pickedCount', { count: 1 })));
});

test('workspace compact toolbar switches to the action graph pane', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, i18n.t('workspace.toolbar.graph'));

  assert.equal(state.store.workspace.activePane, 'graph');
  assert.ok(all(current, (node) => node.className.includes('graph-pane'))[0].className.includes('active-mobile-pane'));
  assert.equal(all(current, (node) => node.className.includes('containers-pane'))[0].className.includes('active-mobile-pane'), false);
});

test('workspace action graph zoom, fit, reset, and node selection update renderer state', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, i18n.t('workspace.graph.zoomIn'));
  assert.equal(state.store.workspace.graphViewport.scale, 1.1);
  await clickButton(current, i18n.t('workspace.graph.fit'));
  assert.ok(state.store.workspace.graphViewport.scale >= 0.5);
  await clickButton(current, i18n.t('workspace.graph.reset'));
  assert.deepEqual(state.store.workspace.graphViewport, { scale: 1, offsetX: 0, offsetY: 0 });

  const node = all(current, (item) => item.className.includes('graph-node'))[0];
  await node.click();
  assert.equal(state.store.workspace.graphSelectedNodeId, 'sample-switch');
  assert.ok(all(current, (item) => item.className.includes('graph-node'))[0].className.includes('selected'));
});

test('workspace action graph pans on empty canvas and wheel-zooms around the pointer', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  const canvas = all(current, (node) => node.className === 'graph-canvas')[0];
  canvas.clientWidth = 1000;
  canvas.clientHeight = 600;
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 1000, height: 600 });

  await fireWithEvent(canvas, 'pointerdown', { clientX: 200, clientY: 180, preventDefault() {} });
  await dispatchGlobal('pointermove', { clientX: 260, clientY: 220 });
  await dispatchGlobal('pointerup', { clientX: 260, clientY: 220 });
  assert.deepEqual(state.store.workspace.graphViewport, { scale: 1, offsetX: 60, offsetY: 40 });

  const zoomCanvas = all(current, (node) => node.className === 'graph-canvas')[0];
  zoomCanvas.clientWidth = 1000;
  zoomCanvas.clientHeight = 600;
  zoomCanvas.getBoundingClientRect = () => ({ left: 100, top: 50, width: 1000, height: 600 });
  let prevented = false;
  await fireWithEvent(zoomCanvas, 'wheel', { deltaY: -120, clientX: 600, clientY: 350, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(state.store.workspace.graphViewport.scale, 1.1);
  assert.equal(Math.round(state.store.workspace.graphViewport.offsetX), 16);
  assert.equal(Math.round(state.store.workspace.graphViewport.offsetY), 14);

  state.store.workspace.graphViewport = { scale: 1.6, offsetX: 0, offsetY: 0 };
  current = views.renderView(refresh);
  const clampedCanvas = all(current, (node) => node.className === 'graph-canvas')[0];
  await fireWithEvent(clampedCanvas, 'wheel', { deltaY: -120, clientX: 100, clientY: 100, preventDefault() {} });
  assert.equal(state.store.workspace.graphViewport.scale, 1.6);
});

test('workspace action graph supports edit, delete, undo, redo, add, and restore', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  const title = all(current, (node) => node.localName === 'input' && node.getAttribute('aria-label') === i18n.t('workspace.graph.stepName'))[0];
  title.value = 'open page';
  await fire(title, 'change');
  assert.equal(state.store.workspace.graphDraftNodes[0].title, 'open page');

  await all(current, (node) => node.localName === 'button' && node.className === 'node-delete')[0].click();
  assert.equal(state.store.workspace.graphDraftNodes.length, 2);
  await clickButton(current, i18n.t('workspace.graph.undo'));
  assert.equal(state.store.workspace.graphDraftNodes.length, 3);
  await clickButton(current, i18n.t('workspace.graph.redo'));
  assert.equal(state.store.workspace.graphDraftNodes.length, 2);
  await clickButton(current, i18n.t('workspace.graph.addStep'));
  assert.equal(state.store.workspace.graphDraftNodes.length, 3);
  await clickButton(current, i18n.t('workspace.graph.restore'));
  assert.deepEqual(state.store.workspace.graphDraftNodes.map((node) => node.id), workspaceState.WORKSPACE_SAMPLE_NODES.map((node) => node.id));
});

test('workspace action graph groups every node with an editable value in selection order', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, i18n.t('workspace.graph.editing'));
  assert.equal(state.store.workspace.graphEditMode, false);
  assert.equal(all(current, (node) => node.localName === 'input' && node.getAttribute('aria-label') === i18n.t('workspace.graph.stepName'))[0].disabled, true);
  const groups = all(current, (node) => node.className.includes('graph-groups'))[0];
  const addGroup = all(groups, (node) => node.localName === 'button' && node.textContent === '+')[0];
  await addGroup.click();
  assert.equal(state.store.workspace.graphInputGroups.length, 2);
  for (const nodeId of ['sample-switch', 'sample-click', 'sample-input']) {
    const node = all(current, (item) => item.getAttribute('data-node-id') === nodeId)[0];
    assert.equal(node.getAttribute('data-groupable'), 'true');
    await node.click();
  }
  assert.deepEqual(state.store.workspace.graphInputGroups[1].nodeIds, ['sample-switch', 'sample-click', 'sample-input']);
  assert.ok(all(current, (node) => node.className.includes('graph-node') && node.textContent.includes(`3 : ${i18n.t('workspace.graph.groupDefault')} 2`)).length >= 1);
  await clickButton(current, i18n.t('workspace.graph.editMode'));
  await clickButton(current, i18n.t('workspace.graph.undo'));
  assert.equal(state.store.workspace.graphInputGroups.length, 1);
});

test('workspace action graph connects output and input ports in edit mode', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  const output = all(current, (node) => node.getAttribute('data-port') === 'output')[0];
  await fire(output, 'pointerdown');
  assert.equal(state.store.workspace.graphConnectingFrom, 'sample-switch');
  const input = all(current, (node) => node.getAttribute('data-port') === 'input' && node.parentNode?.parentNode?.getAttribute?.('data-node-id') === 'sample-input')[0]
    || all(current, (node) => node.getAttribute('data-port') === 'input')[2];
  await fire(input, 'pointerup');
  assert.equal(state.store.workspace.graphConnectingFrom, '');
  assert.ok(state.store.workspace.graphDraftEdges.some((edge) => edge.from === 'sample-switch' && edge.to === 'sample-input'));
});

test('workspace action graph drags a node only in edit mode and persists its position', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.activePane = 'graph';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  const node = all(current, (item) => item.getAttribute('data-node-id') === 'sample-switch')[0];
  const header = all(node, (item) => item.className === 'graph-node-header')[0];
  await fireWithEvent(header, 'pointerdown', { clientX: 100, clientY: 100 });
  await dispatchGlobal('pointermove', { clientX: 180, clientY: 150 });
  await dispatchGlobal('pointerup', { clientX: 180, clientY: 150 });

  const moved = state.store.workspace.graphDraftNodes.find((item) => item.id === 'sample-switch');
  assert.equal(moved.x, 190);
  assert.equal(moved.y, 104);

  await clickButton(current, i18n.t('workspace.graph.editing'));
  const lockedNode = all(current, (item) => item.getAttribute('data-node-id') === 'sample-switch')[0];
  const lockedHeader = all(lockedNode, (item) => item.className === 'graph-node-header')[0];
  await fireWithEvent(lockedHeader, 'pointerdown', { clientX: 100, clientY: 100 });
  await dispatchGlobal('pointermove', { clientX: 240, clientY: 220 });
  await dispatchGlobal('pointerup', { clientX: 240, clientY: 220 });
  const stillLocked = state.store.workspace.graphDraftNodes.find((item) => item.id === 'sample-switch');
  assert.equal(stillLocked.x, 190);
  assert.equal(stillLocked.y, 104);
});

test('workspace add container uses the Controller containers API and refreshes managed list', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, '+ Thêm container');
  const inputs = all(current, (node) => node.localName === 'input');
  inputs[1].value = 'Agent One';
  await clickButton(current, 'Tạo');
  assert.equal(apiState.lastContainerAddPayload.host, 'configured-docker-host');
  assert.equal(apiState.containers[0].runtime.dockerName, 'war-1');
  assert.ok(state.store.containers.some((container) => container.name === 'Agent One 1'));
  assert.equal(state.store.containers[0].status, 'running');
});

test('workspace adds, checks, and repairs an SSH Linux host', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [] } };
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, `+ ${i18n.t('workspace.containers.addHost')}`);
  const form = all(current, (node) => node.className === 'host-setup-card')[0];
  const inputs = all(form, (node) => node.localName === 'input');
  inputs[0].value = 'Reviewed Linux';
  inputs[1].value = 'root@192.168.1.201';
  inputs[2].value = 'C:/Users/test/.ssh/id_ed25519';
  inputs[3].value = '192.168.1.20';
  inputs[4].value = '/opt/war/controller-ca.crt';
  inputs[5].value = 'war-browser-agent:phase1';
  for (const input of inputs) await fireWithEvent(input, 'input');
  await clickButton(current, i18n.t('workspace.containers.repairAndConnectHost'));

  assert.equal(apiState.hostCalls.add, 1);
  assert.equal(apiState.hostCalls.repair, 1);
  assert.equal(apiState.hostRequests[0].target, 'root@192.168.1.201');
  assert.equal(apiState.hostRequests[0].controllerCaPath, '/opt/war/controller-ca.crt');
  assert.equal(state.store.workspace.containerHosts[0].connected, true);
});

test('selecting a Linux host restores saved fields and updates it in place', async () => {
  resetStore();
  state.store.view = 'workspace';
  const host = { id: 'ssh-host-1', label: 'Linux da duyet', name: 'Linux da duyet', target: 'root@192.168.1.201', image: 'war-browser-agent:phase1', connected: false, diagnostics: {} };
  state.store.settings.containerHosts = [{
    id: host.id,
    name: host.name,
    target: host.target,
    identityFile: 'C:/Users/test/.ssh/id_ed25519',
    controllerHost: '192.168.1.206',
    controllerCaPath: '/opt/war/war-controller-pilot-ca.crt',
    image: host.image,
  }];
  state.store.workspace.containerHosts = [host];
  apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [host] } };
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await all(current, (node) => node.className === 'host-card-select')[0].click();
  const form = all(current, (node) => node.className === 'host-setup-card')[0];
  const inputs = all(form, (node) => node.localName === 'input');
  assert.equal(inputs[0].value, 'Linux da duyet');
  assert.equal(inputs[1].value, 'root@192.168.1.201');
  assert.equal(inputs[2].value, 'C:/Users/test/.ssh/id_ed25519');
  assert.equal(inputs[3].value, '192.168.1.206');
  assert.equal(inputs[4].value, '/opt/war/war-controller-pilot-ca.crt');
  assert.equal(inputs[5].value, 'war-browser-agent:phase1');

  inputs[0].value = 'Linux phòng làm việc';
  await fireWithEvent(inputs[0], 'input');
  await clickButton(current, i18n.t('workspace.containers.updateAndCheckHost'));
  assert.equal(apiState.hostCalls.update, 1);
  assert.equal(apiState.hostRequests.at(-1).hostId, 'ssh-host-1');
  assert.equal(apiState.hostRequests.at(-1).identityFile, 'C:/Users/test/.ssh/id_ed25519');
});

test('Linux host repair surfaces nested IPC errors and can be retried successfully', async () => {
  resetStore();
  state.store.view = 'workspace';
  const host = { id: 'ssh-host-1', label: 'Linux da duyet', name: 'Linux da duyet', target: 'root@192.168.1.201', image: 'war-browser-agent:phase1', connected: false, diagnostics: {} };
  state.store.settings.containerHosts = [{
    id: host.id,
    name: host.name,
    target: host.target,
    identityFile: 'C:/Users/test/.ssh/id_ed25519',
    controllerHost: '192.168.1.206',
    controllerCaPath: '/opt/war/war-controller-pilot-ca.crt',
    image: host.image,
  }];
  state.store.workspace.containerHosts = [host];
  apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [host] } };
  apiState.hostRepairResult = { ok: false, error: { code: 'SSH_AUTH_FAILED', message: 'SSH authentication failed; verify the Linux account and private key' } };
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await all(current, (node) => node.className === 'host-card-select')[0].click();
  await clickButton(current, i18n.t('workspace.containers.updateRepairAndConnectHost'));

  assert.equal(apiState.hostCalls.update, 1);
  assert.equal(apiState.hostCalls.repair, 1);
  assert.ok(state.store.workspace.hostError.includes('SSH_AUTH_FAILED: SSH authentication failed'));
  assert.equal(state.store.workspace.hostError.includes('[object Object]'), false);
  assert.equal(state.store.workspace.hostPending, '');
  assert.equal(findButton(current, i18n.t('workspace.containers.updateRepairAndConnectHost')).disabled, false);

  apiState.hostRepairResult = null;
  await clickButton(current, i18n.t('workspace.containers.updateRepairAndConnectHost'));
  assert.equal(apiState.hostCalls.update, 2);
  assert.equal(apiState.hostCalls.repair, 2);
  assert.equal(state.store.workspace.hostError, '');
  assert.equal(state.store.workspace.containerHosts[0].connected, true);
});

test('Linux host repair ignores duplicate clicks while a request is pending', async () => {
  resetStore();
  state.store.view = 'workspace';
  const host = { id: 'ssh-host-1', label: 'Linux', name: 'Linux', target: 'root@192.168.1.201', image: 'war-browser-agent:phase1', connected: false, diagnostics: {} };
  state.store.settings.containerHosts = [{ id: host.id, name: host.name, target: host.target, identityFile: 'C:/key', controllerHost: '192.168.1.206', controllerCaPath: '/opt/war/ca.crt', image: host.image }];
  state.store.workspace.containerHosts = [host];
  apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [host] } };
  let release;
  apiState.hostUpdateGate = new Promise((resolve) => { release = resolve; });
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await all(current, (node) => node.className === 'host-card-select')[0].click();
  const repairButton = findButton(current, i18n.t('workspace.containers.updateRepairAndConnectHost'));
  const firstRequest = repairButton.click();
  const secondRequest = repairButton.click();
  assert.equal(apiState.hostCalls.update, 1);
  release();
  await Promise.all([firstRequest, secondRequest]);
  assert.equal(apiState.hostCalls.update, 1);
  assert.equal(apiState.hostCalls.repair, 1);
});

test('workspace add container requires a successfully probed Docker host', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [] } };
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, `+ ${i18n.t('workspace.containers.add')}`);

  assert.equal(findButton(current, i18n.t('workspace.containers.create')).disabled, true);
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.hostUnavailable')));
});

test('workspace add container prevents duplicate create requests', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containerAddDelay = true;
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, '+ Thêm container');
  const inputs = all(current, (node) => node.localName === 'input');
  inputs[1].value = 'Agent One';
  const create = findButton(current, 'Tạo');
  const firstClick = create.click();
  await create.click();
  await firstClick;
  assert.equal(apiState.containerCalls.add, 1);
  assert.equal(apiState.containers.filter((container) => container.name === 'Agent One 1').length, 1);
});

test('workspace add container advances the sequence for the fixed name', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, `+ ${i18n.t('workspace.containers.add')}`);
  await clickButton(current, i18n.t('workspace.containers.create'));

  let form = all(current, (node) => node.getAttribute('role') === 'form')[0];
  let sequence = all(form, (node) => node.localName === 'input' && node.type === 'number')[0];
  assert.equal(apiState.containers[0].name, 'Agent 1');
  assert.equal(state.store.workspace.containerNameSequence, 2);
  assert.equal(sequence.value, '2');

  await clickButton(current, i18n.t('workspace.containers.create'));
  form = all(current, (node) => node.getAttribute('role') === 'form')[0];
  sequence = all(form, (node) => node.localName === 'input' && node.type === 'number')[0];
  assert.deepEqual(apiState.containers.map((container) => container.name), ['Agent 1', 'Agent 2']);
  assert.equal(sequence.value, '3');
});

test('workspace random IPv6 enables IPv6 and generates a valid EUI-64 suffix', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, `+ ${i18n.t('workspace.containers.add')}`);
  const form = all(current, (node) => node.getAttribute('role') === 'form')[0];
  const checkboxes = all(form, (node) => node.localName === 'input' && node.type === 'checkbox');
  const suffix = all(form, (node) => node.getAttribute('aria-label') === i18n.t('workspace.containers.ipv6Suffix'))[0];

  await clickButton(form, i18n.t('workspace.containers.randomIpv6'));

  assert.equal(checkboxes[1].checked, true);
  assert.equal(suffix.disabled, false);
  assert.match(suffix.value, /^[0-9a-f]{1,4}:[0-9a-f]{1,2}ff:fe[0-9a-f]{1,2}:[0-9a-f]{1,4}$/);
});

test('managed container check-all refreshes every container and preserves host nickname', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.containerHosts = [{ id: 'configured-docker-host', label: 'Linux Docker', runtime: 'ssh-docker', connected: true }];
  apiState.containers = [
    containerFixture({ id: 'container-1', name: 'Agent One', host: 'configured-docker-host' }),
    containerFixture({ id: 'container-2', name: 'Agent Two', host: 'configured-docker-host' }),
  ];
  state.store.containers = apiState.containers;
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, i18n.t('workspace.containers.checkAll'));
  assert.equal(apiState.containerCalls.refresh, 2);
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.checkAllDone')));
  assert.ok(current.textContent.includes('Agent One (Linux Docker)'));
});

test('managed container pending lifecycle disables conflicting actions', () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.containers = [containerFixture({ id: 'container-1', name: 'Agent One', status: 'stopped' })];
  state.store.workspace.containerPending = { 'container-1': 'start' };
  let rendered = views.renderView(() => {});
  assert.equal(findButton(rendered, 'Start').disabled, true);

  state.store.workspace.containerPending = { 'container-1': 'stop' };
  rendered = views.renderView(() => {});
  assert.equal(findButton(rendered, 'Stop').disabled, true);

  state.store.workspace.containerPending = { 'container-1': 'restart' };
  rendered = views.renderView(() => {});
  assert.equal(findButton(rendered, 'Restart').disabled, true);
});

test('managed container network settings toggle IPv4 and apply a stable IPv6 suffix', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One', runtime: { dockerName: 'war-agent-one', ipv4Enabled: true, ipv6Enabled: false } })];
  state.store.containers = apiState.containers;
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Cài đặt mạng');
  const panel = all(current, (node) => node.className === 'network-settings')[0];
  const inputs = all(panel, (node) => node.localName === 'input');
  inputs[0].checked = false;
  inputs[1].checked = true;
  inputs[2].disabled = false;
  inputs[2].value = 'a8bb:ccff:fedd:eeff';
  await clickButton(panel, 'Áp dụng mạng');
  assert.equal(apiState.containers[0].runtime.ipv4Enabled, false);
  assert.equal(apiState.containers[0].runtime.ipv6Enabled, true);
  assert.equal(apiState.containers[0].runtime.ipv6Suffix, 'a8bb:ccff:fedd:eeff');
});

test('managed container delete requires exact confirmation', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  let confirmText = '';
  window.confirm = (message) => { confirmText = message; return false; };
  const rendered = views.renderView(() => {});
  await clickButton(rendered, i18n.t('workspace.containers.moveToTrash'));
  assert.equal(apiState.containerCalls.delete || 0, 0);
  assert.ok(confirmText.includes('Agent One'));
  assert.ok(confirmText.includes('container-1'));
});

test('managed container delete calls the Controller and refreshes terminal status', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  state.store.containers = apiState.containers;
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.moveToTrash'));
  assert.equal(apiState.containerCalls.delete, 1);
  assert.equal(apiState.containers[0].status, 'deleted');
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.actionDone')));
});

test('container trash remains available when empty and supports restore and permanent deletion', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  state.store.containers = apiState.containers;
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  state.store.view = 'trash';
  current = views.renderView(refresh);
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.trashEmpty')));
  state.store.view = 'workspace';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.moveToTrash'));
  assert.equal(apiState.containers[0].status, 'deleted');
  state.store.view = 'trash';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.restore'));
  assert.equal(apiState.containerCalls.restore, 1);
  assert.equal(apiState.containers[0].status, 'stopped');

  state.store.view = 'workspace';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.moveToTrash'));
  state.store.view = 'trash';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.purge'));
  assert.equal(apiState.containerCalls.purge, 1);
  assert.equal(apiState.containers.length, 0);
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.trashEmpty')));
});

test('Linux host X moves the host to trash where it can be restored or purged', async () => {
  resetStore();
  state.store.view = 'workspace';
  const host = { id: 'ssh-host-1', label: 'Reviewed Linux', name: 'Reviewed Linux', target: 'root@192.168.1.201', connected: true, diagnostics: { docker: true } };
  apiState.containerHostsResult = { ok: true, data: { status: 'connected', hosts: [host] } };
  state.store.workspace.containerHosts = [host];
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  const hostCard = all(current, (node) => node.className === 'host-card')[0];
  await all(hostCard, (node) => node.className === 'device-card-delete')[0].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(apiState.hostCalls.trash, 1);
  assert.equal(state.store.workspace.containerHosts.length, 0);
  state.store.view = 'trash';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.restore'));
  assert.equal(apiState.hostCalls.restore, 1);

  state.store.view = 'workspace';
  current = views.renderView(refresh);
  const restoredCard = all(current, (node) => node.className === 'host-card')[0];
  await all(restoredCard, (node) => node.className === 'device-card-delete')[0].click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  state.store.view = 'trash';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('workspace.containers.purge'));
  assert.equal(apiState.hostCalls.purge, 1);
  assert.equal(apiState.trashHosts.length, 0);
});

test('managed container card exposes a direct delete control without changing selection', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  state.store.containers = apiState.containers;
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  const card = all(current, (node) => node.className === 'device-card')[0];
  const deleteButton = all(card, (node) => node.localName === 'button' && node.className === 'device-card-delete')[0];
  assert.ok(deleteButton);
  await deleteButton.click();

  assert.equal(apiState.containerCalls.delete, 1);
  assert.equal(state.store.workspace.selection.selectedIds.size, 0);
  assert.ok(current.textContent.includes(i18n.t('workspace.containers.actionDone')));
});

test('deleting the first managed container removes it and previously deleted containers from the active list', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [
    containerFixture({ id: 'container-old', name: 'Old Agent', deviceId: 'managed-old', status: 'deleted' }),
    containerFixture({ id: 'container-1', name: 'Agent One', deviceId: 'managed-one' }),
    containerFixture({ id: 'container-2', name: 'Agent Two', deviceId: 'managed-two' }),
  ];
  state.store.containers = apiState.containers;
  state.store.devices = [
    { id: 'managed-old', name: 'Old Agent', status: 'revoked' },
    { id: 'managed-one', name: 'Agent One', status: 'online' },
    { id: 'managed-two', name: 'Agent Two', status: 'online' },
  ];
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  assert.equal(current.textContent.includes('Old Agent'), false);

  const firstCard = all(current, (node) => node.className === 'device-card' && node.textContent.includes('Agent One'))[0];
  const deleteButton = all(firstCard, (node) => node.className === 'device-card-delete')[0];
  await deleteButton.click();
  assert.equal(apiState.containerCalls.delete, 1);
  assert.equal(current.textContent.includes('Agent One'), false);
  assert.equal(current.textContent.includes('Agent Two'), true);
});

test('managed container failed action preserves safe error and success clears it', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One', status: 'stopped' })];
  state.store.containers = apiState.containers;
  apiState.containerResults.start = { ok: false, code: 'CONTAINER_ADAPTER_UNAVAILABLE', message: 'Adapter unavailable' };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Start');
  assert.equal(state.store.workspace.containerErrors['container-1'], 'CONTAINER_ADAPTER_UNAVAILABLE: Adapter unavailable');
  assert.ok(current.textContent.includes('CONTAINER_ADAPTER_UNAVAILABLE'));

  apiState.containerResults.start = null;
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One', status: 'stopped' })];
  state.store.containers = apiState.containers;
  current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Start');
  assert.equal(state.store.workspace.containerErrors['container-1'], undefined);
});

test('managed container delete reports backend cleanup failure instead of claiming success', async () => {
  resetStore();
  state.store.view = 'workspace';
  apiState.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  state.store.containers = apiState.containers;
  apiState.containerResults.delete = {
    ok: true,
    data: {
      container: containerFixture({ id: 'container-1', name: 'Agent One', status: 'failed' }),
      operation: { ok: false, code: 'CONTAINER_ADAPTER_UNAVAILABLE', error: 'Adapter unavailable' },
    },
  };
  window.confirm = () => true;
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);

  await clickButton(current, i18n.t('workspace.containers.moveToTrash'));

  assert.equal(apiState.containerCalls.delete, 1);
  assert.equal(state.store.workspace.containerErrors['container-1'], 'CONTAINER_ADAPTER_UNAVAILABLE: Adapter unavailable');
  assert.equal(current.textContent.includes(i18n.t('workspace.containers.actionDone')), false);
});

test('managed container resource unavailable and authenticated online states render safely', () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.containers = [containerFixture({
    id: 'container-1',
    name: 'Agent One',
    deviceId: 'managed-device-1',
    status: 'running',
    resourceUsage: null,
    runtime: { dockerName: 'war-agent-one', credentialPath: 'C:\\secret\\credential.json' },
  })];
  let rendered = views.renderView(() => {});
  assert.ok(rendered.textContent.includes('Chưa có số liệu tài nguyên'));
  assert.ok(rendered.textContent.includes('Agent chưa xác thực online'));
  assert.equal(rendered.textContent.includes('credential.json'), false);

  state.store.sessions = [{ deviceId: 'managed-device-1', status: 'online' }];
  rendered = views.renderView(() => {});
  assert.ok(rendered.textContent.includes('Agent đã xác thực online'));
});

test('origin synchronization filters invalid origin devices', () => {
  resetStore();
  state.store.view = 'workflows';
  state.store.sessions = [
    { deviceId: 'dev-online', status: 'online' },
    { deviceId: 'dev-offline', status: 'offline' },
    { deviceId: 'dev-revoked', status: 'online' },
  ];
  state.store.devices = [
    { id: 'dev-online', name: 'Agent Online', status: 'online' },
    { id: 'dev-offline', name: 'Agent Offline', status: 'offline' },
    { id: 'dev-revoked', name: 'Agent Revoked', status: 'revoked' },
  ];
  const rendered = views.renderView(() => {});
  const options = all(first(rendered, 'select'), (node) => node.localName === 'option').map((option) => option.textContent);
  assert.deepEqual(options, ['Chọn máy gốc', 'Agent Online']);
});

test('origin synchronization preview invokes API once and hides sensitive fields', async () => {
  resetStore();
  state.store.view = 'workflows';
  setValidOrigin();
  apiState.originPreviewDelay = true;
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'select').value = 'dev-online';
  const preview = findButton(current, 'Xem trước kéo từ máy gốc');
  const firstClick = preview.click();
  await preview.click();
  await firstClick;
  assert.equal(apiState.originCalls.preview, 1);
  assert.ok(state.store.originSyncPreview);
  assert.ok(current.textContent.includes('Đã tải bản xem trước'));
  assert.equal(current.textContent.includes('top-secret-value'), false);
});

test('origin synchronization pull is disabled and guarded before preview', async () => {
  resetStore();
  state.store.view = 'workflows';
  setValidOrigin();
  const rendered = views.renderView(() => {});
  first(rendered, 'select').value = 'dev-online';
  const pull = findButton(rendered, 'Kéo từ máy gốc');
  assert.equal(pull.disabled, true);
  await pull.click();
  assert.equal(apiState.originCalls.pull || 0, 0);
  assert.equal(state.store.originSync.error, 'Cần xem trước hợp lệ trước khi kéo');
});

test('origin synchronization pull prevents duplicates, reports skipped items, and updates workflows', async () => {
  resetStore();
  state.store.view = 'workflows';
  setValidOrigin();
  state.store.originSyncPreview = originPreviewFixture();
  apiState.originPullDelay = true;
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'select').value = 'dev-online';
  all(current, (node) => node.localName === 'select')[1].value = 'skip';
  const pull = findButton(current, 'Kéo từ máy gốc');
  const firstClick = pull.click();
  await pull.click();
  await firstClick;
  assert.equal(apiState.originCalls.pull, 1);
  assert.ok(current.textContent.includes('Đã bỏ qua'));
  assert.equal(state.store.workflows.some((workflow) => workflow.workflowId === 'wf-origin'), true);
});

test('origin synchronization failed preview leaves safe error and success clears stale error', async () => {
  resetStore();
  state.store.view = 'workflows';
  setValidOrigin();
  apiState.originPreviewResult = { ok: false, code: 'ORIGIN_UNAVAILABLE', message: 'Origin offline' };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'select').value = 'dev-online';
  await clickButton(current, 'Xem trước kéo từ máy gốc');
  assert.equal(state.store.originSync.error, 'ORIGIN_UNAVAILABLE: Origin offline');

  apiState.originPreviewResult = null;
  current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'select').value = 'dev-online';
  await clickButton(current, 'Xem trước kéo từ máy gốc');
  assert.equal(state.store.originSync.error, '');
});

test('grouped input mode switching clears transient preview while retaining typed text', async () => {
  resetStore();
  state.store.view = 'jobs';
  setGroupedFixtures();
  state.store.groupedInputPreview = groupedPlanFixture();
  const rendered = views.renderView(() => {});
  const mode = all(rendered, (node) => node.getAttribute('aria-label') === i18n.t('groupedInput.mode'))[0];
  const groupedText = all(rendered, (node) => node.localName === 'textarea').at(-1);
  groupedText.value = 'hôm nay thật vui';
  await fire(groupedText, 'input');
  mode.value = 'cell';
  await fire(mode, 'change');
  assert.equal(state.store.groupedInput.mode, 'cell');
  assert.equal(state.store.groupedInput.text, 'hôm nay thật vui');
  assert.equal(state.store.groupedInputPreview, null);
});

test('task package previews and dispatches a deterministic workflow-machine matrix', async () => {
  resetStore();
  state.store.view = 'jobs';
  setTaskPackageFixtures();
  apiState.jobDispatchResult = (request, index) => ({
    ok: true,
    data: { job: { id: `job-task-${index + 1}` }, transport: { delivered: true } },
  });
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  const panel = all(current, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.title'))[0];
  const name = all(panel, (node) => node.localName === 'input' && node.type === 'text')[0];
  name.value = 'Morning checks';
  await fire(name, 'input');
  const workflowSelect = all(panel, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.workflows'))[0];
  workflowSelect.options.forEach((option) => { option.selected = true; });
  await fire(workflowSelect, 'change');
  const deviceSelect = all(panel, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.devices'))[0];
  deviceSelect.options.forEach((option) => { option.selected = true; });
  await fire(deviceSelect, 'change');
  const taskInputs = all(panel, (node) => node.localName === 'textarea')[0];
  taskInputs.value = '{"query":"war"}';
  await fire(taskInputs, 'input');
  const taskDeadline = all(panel, (node) => node.localName === 'input' && node.type === 'number')[0];
  taskDeadline.value = '600';
  await fire(taskDeadline, 'input');

  await clickButton(current, i18n.t('taskPackage.preview'));
  assert.equal(state.store.taskPackagePreview.assignments.length, 4);
  await clickButton(current, i18n.t('taskPackage.dispatch'));
  assert.deepEqual(apiState.jobDispatchRequests, [
    { deviceId: 'dev-a', workflowId: 'wf-a', revision: 1, inputs: { query: 'war' }, deadlineSeconds: 600 },
    { deviceId: 'dev-b', workflowId: 'wf-a', revision: 1, inputs: { query: 'war' }, deadlineSeconds: 600 },
    { deviceId: 'dev-a', workflowId: 'wf-b', revision: 2, inputs: { query: 'war' }, deadlineSeconds: 600 },
    { deviceId: 'dev-b', workflowId: 'wf-b', revision: 2, inputs: { query: 'war' }, deadlineSeconds: 600 },
  ]);
  assert.equal(state.store.taskPackageResult.succeeded, 4);
  assert.equal(state.store.taskPackageResult.failed, 0);
});

test('task package validates paired counts and prevents duplicate dispatch while pending', async () => {
  resetStore();
  state.store.view = 'jobs';
  setTaskPackageFixtures();
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  let panel = all(current, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.title'))[0];
  const name = all(panel, (node) => node.localName === 'input' && node.type === 'text')[0];
  name.value = 'Paired checks';
  await fire(name, 'input');
  const mode = all(panel, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.mode'))[0];
  mode.value = 'paired';
  await fire(mode, 'change');
  panel = all(current, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.title'))[0];
  const workflowSelect = all(panel, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.workflows'))[0];
  workflowSelect.options.forEach((option) => { option.selected = true; });
  await fire(workflowSelect, 'change');
  const deviceSelect = all(panel, (node) => node.getAttribute('aria-label') === i18n.t('taskPackage.devices'))[0];
  deviceSelect.options[0].selected = true;
  await fire(deviceSelect, 'change');
  await clickButton(current, i18n.t('taskPackage.preview'));
  assert.equal(state.store.taskPackage.error, i18n.t('taskPackage.pairedCountMismatch'));
  assert.equal(apiState.jobDispatchRequests.length, 0);

  state.store.taskPackage.selectedWorkflowKeys = ['wf-a:1'];
  state.store.taskPackage.selectedDeviceIds = ['dev-a'];
  state.store.taskPackage.inputs = '[]';
  state.store.taskPackage.error = '';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('taskPackage.preview'));
  assert.equal(state.store.taskPackage.error, i18n.t('taskPackage.invalidInputs'));

  state.store.taskPackage.inputs = '';
  state.store.taskPackage.error = '';
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('taskPackage.preview'));
  let releaseDispatch;
  apiState.jobDispatchGate = new Promise((resolve) => { releaseDispatch = resolve; });
  const run = findButton(current, i18n.t('taskPackage.dispatch'));
  const firstClick = run.click();
  await Promise.resolve();
  await run.click();
  assert.equal(apiState.jobDispatchRequests.length, 1);
  releaseDispatch();
  await firstClick;
});

test('task package keeps successful dispatches when another assignment fails safely', async () => {
  resetStore();
  state.store.view = 'jobs';
  setTaskPackageFixtures();
  Object.assign(state.store.taskPackage, {
    name: 'Partial checks',
    selectedWorkflowKeys: ['wf-a:1'],
    selectedDeviceIds: ['dev-a', 'dev-b'],
    deviceSelectionInitialized: true,
  });
  apiState.jobDispatchResult = (_request, index) => index === 1
    ? { ok: false, code: 'SESSION_OFFLINE', message: 'Target offline' }
    : { ok: true, data: { job: { id: 'job-partial' }, transport: { delivered: true } } };
  let current;
  const refresh = () => { current = views.renderView(refresh); };
  current = views.renderView(refresh);
  await clickButton(current, i18n.t('taskPackage.preview'));
  await clickButton(current, i18n.t('taskPackage.dispatch'));
  assert.equal(state.store.taskPackageResult.succeeded, 1);
  assert.equal(state.store.taskPackageResult.failed, 1);
  assert.ok(current.textContent.includes('SESSION_OFFLINE'));
});

test('grouped input preview preserves Vietnamese text and uses normalized backend plan', async () => {
  resetStore();
  state.store.view = 'jobs';
  setGroupedFixtures();
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await prepareGroupedForm(current, { text: 'hôm nay thật vui', mode: 'text' });
  await clickButton(current, 'Xem trước nhập liệu nhóm');
  assert.equal(apiState.groupedCalls.preview, 1);
  assert.equal(apiState.groupedRequests[0].text, 'hôm nay thật vui');
  assert.ok(current.textContent.includes('Đã có xem trước nhập liệu nhóm'));
  assert.ok(current.textContent.includes('hôm nay thật vui'));
});

test('grouped input dispatch is blocked before preview and duplicate dispatch is prevented', async () => {
  resetStore();
  state.store.view = 'jobs';
  setGroupedFixtures();
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await prepareGroupedForm(current, { text: 'hôm nay thật vui', mode: 'table' });
  const dispatch = findButton(current, 'Dispatch nhập liệu nhóm');
  assert.equal(dispatch.disabled, true);
  await dispatch.click();
  assert.equal(apiState.groupedCalls.dispatch || 0, 0);
  assert.equal(state.store.groupedInput.error, 'Cần xem trước hợp lệ trước khi dispatch');

  state.store.groupedInput.error = '';
  state.store.groupedInputPreview = groupedPlanFixture();
  apiState.groupedDispatchDelay = true;
  current = views.renderView(() => { current = views.renderView(() => {}); });
  await prepareGroupedForm(current, { text: 'hôm nay thật vui', mode: 'table' });
  const enabledDispatch = findButton(current, 'Dispatch nhập liệu nhóm');
  const firstClick = enabledDispatch.click();
  await enabledDispatch.click();
  await firstClick;
  assert.equal(apiState.groupedCalls.dispatch, 1);
});

test('grouped input backend validation errors render and clear after correction', async () => {
  resetStore();
  state.store.view = 'jobs';
  setGroupedFixtures();
  apiState.groupedPreviewResult = { ok: false, code: 'DUPLICATE_TABLE_HEADER', message: 'Duplicate table header' };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await prepareGroupedForm(current, { text: 'name|name\nA|B', mode: 'table' });
  await clickButton(current, 'Xem trước nhập liệu nhóm');
  assert.equal(state.store.groupedInput.error, 'DUPLICATE_TABLE_HEADER: Duplicate table header');
  assert.ok(current.textContent.includes('DUPLICATE_TABLE_HEADER'));

  apiState.groupedPreviewResult = null;
  current = views.renderView(() => { current = views.renderView(() => {}); });
  await prepareGroupedForm(current, { text: 'name|query\nA|B', mode: 'table' });
  await clickButton(current, 'Xem trước nhập liệu nhóm');
  assert.equal(state.store.groupedInput.error, '');
  assert.ok(current.textContent.includes('Đã có xem trước nhập liệu nhóm'));
});

test('action graph loads real workflow graph and excludes sample proof before load', async () => {
  resetStore();
  state.store.view = 'workflows';
  setGraphFixtures();
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  assert.ok(current.textContent.includes('Tải graph'));
  assert.equal(current.textContent.includes('sample-switch'), false);
  await clickButton(current, 'Tải graph');
  assert.equal(apiState.graphCalls.get, 1);
  assert.ok(current.textContent.includes('Step A'));
  assert.ok(current.textContent.includes('a > b'));
});

test('action graph node update previews through validated backend operations', async () => {
  resetStore();
  state.store.view = 'workflows';
  setGraphFixtures();
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Tải graph');
  const inputs = all(current, (node) => node.localName === 'input');
  const nodeName = inputs.find((input) => input.value === 'Step A');
  nodeName.value = 'Step A updated';
  await clickButton(current, 'Cập nhật node');
  assert.equal(state.store.graphEditor.unsaved, true);
  await clickButton(current, 'Xem trước graph');
  assert.equal(apiState.graphCalls.preview, 1);
  assert.equal(apiState.graphRequests.at(-1).operations[0].type, 'updateNode');
  assert.equal(apiState.graphRequests.at(-1).operations[0].patch.name, 'Step A updated');
});

test('action graph invalid preview disables save and discard requires confirmation', async () => {
  resetStore();
  state.store.view = 'workflows';
  setGraphFixtures();
  state.store.graphEditor = {
    ...state.store.graphEditor,
    graph: graphFixture({ validation: { ok: false, errors: ['Cycle detected'] } }),
    operations: [{ type: 'addEdge', from: 'b', to: 'a' }],
    unsaved: true,
  };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  assert.equal(findButton(current, 'Lưu revision mới').disabled, true);
  window.confirm = () => false;
  await clickButton(current, 'Bỏ thay đổi');
  assert.equal(state.store.graphEditor.unsaved, true);
  window.confirm = () => true;
  current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Bỏ thay đổi');
  assert.equal(state.store.graphEditor.unsaved, false);
});

test('action graph double save creates one revision and previous revision remains', async () => {
  resetStore();
  state.store.view = 'workflows';
  setGraphFixtures();
  apiState.graphSaveDelay = true;
  state.store.graphEditor = {
    ...state.store.graphEditor,
    graph: graphFixture(),
    operations: [{ type: 'addNode', node: { type: 'log', name: 'Step C', message: 'done' } }],
    unsaved: true,
  };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  const save = findButton(current, 'Lưu revision mới');
  const firstClick = save.click();
  await save.click();
  await firstClick;
  assert.equal(apiState.graphCalls.save, 1);
  assert.deepEqual(state.store.workflows.map((workflow) => workflow.revision), [1, 2]);
  assert.equal(state.store.selectedWorkflow.revision, 2);
});

test('action graph unsafe operation is rejected before persistence', async () => {
  resetStore();
  state.store.view = 'workflows';
  setGraphFixtures();
  state.store.graphEditor = {
    ...state.store.graphEditor,
    graph: graphFixture(),
    operations: [{ type: 'javascript', node: { type: 'javascript' } }],
    unsaved: true,
  };
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Lưu revision mới');
  assert.equal(apiState.graphCalls.save || 0, 0);
  assert.equal(state.store.graphEditor.error, 'INVALID_GRAPH_OPERATION');
});

test('input mode tabs switch renderer state', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Bảng');
  assert.equal(state.store.workspace.activeInputMode, 'grid');
});

test('interactive renderer controls expose visible labels or explicit accessible names', () => {
  resetStore();
  const rendered = state.views.map((view) => {
    state.store.view = view;
    return views.renderView(() => {});
  });
  const controls = rendered.flatMap((view) => all(view, (node) => ['button', 'select'].includes(node.localName)));
  assert.ok(controls.length >= 12);
  for (const control of controls) {
    assert.notEqual(accessibleName(control), '', `${control.localName} is missing an accessible name`);
  }
});

test('textareas are associated with visible labels across renderer views', () => {
  resetStore();
  for (const view of state.views) {
    state.store.view = view;
    if (view === 'workflows') setGraphFixtures();
    if (view === 'jobs') setGroupedFixtures();
    const rendered = views.renderView(() => {});
    const labels = all(rendered, (node) => node.localName === 'label');
    for (const textarea of all(rendered, (node) => node.localName === 'textarea')) {
      assert.ok(labels.some((label) => label.htmlFor === textarea.id && label.textContent.trim()), `${view} textarea is missing a label`);
    }
  }
});

test('new Phase 8 controls localize in Vietnamese and English without resetting state', async () => {
  resetStore();
  state.store.view = 'jobs';
  state.store.groupedInput.text = 'hôm nay thật vui';
  setGroupedFixtures();
  await i18n.setLocale('vi');
  let rendered = views.renderView(() => {});
  assert.ok(rendered.textContent.includes('Nhập liệu theo nhóm'));

  await i18n.setLocale('en');
  rendered = views.renderView(() => {});
  assert.ok(rendered.textContent.includes('Grouped input'));
  assert.equal(state.store.groupedInput.text, 'hôm nay thật vui');
  assert.equal(i18n.localeKeysMatch(), true);
  await i18n.setLocale('vi');
});

test('workspace persistence updates only safe locale and layout preferences', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.groupedInput.text = 'secret runtime value';
  state.store.graphEditor.operations = [{ type: 'addNode', node: { name: 'Transient' } }];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Thu gọn luồng hành động');
  const update = apiState.settingsUpdates.at(-1);
  assert.deepEqual(Object.keys(update), ['workspace']);
  assert.equal(JSON.stringify(update).includes('secret runtime value'), false);
  assert.equal(JSON.stringify(update).includes('Transient'), false);
});

test('section headings and table headers are non-empty across renderer views', () => {
  resetStore();
  for (const view of state.views) {
    state.store.view = view;
    const rendered = views.renderView(() => {});
    for (const heading of all(rendered, (node) => ['h2', 'h3'].includes(node.localName))) {
      assert.notEqual(heading.textContent.trim(), '', `${view} heading is empty`);
    }
    for (const header of all(rendered, (node) => node.localName === 'th')) {
      assert.notEqual(header.textContent.trim(), '', `${view} table header is empty`);
    }
  }
});

test('destructive buttons have visible labels', () => {
  resetStore();
  state.store.view = 'groups';
  state.store.groups = [{ id: 'group-1', name: 'Group 1', deviceIds: [] }];
  const rendered = views.renderView(() => {});
  const destructive = all(rendered, (node) => node.localName === 'button' && ['Delete', 'Remove device'].includes(node.textContent));
  assert.deepEqual(destructive.map((node) => node.textContent), ['Delete', 'Remove device']);
});

test('empty group name shows validation error', async () => {
  resetStore();
  state.store.view = 'groups';
  const rendered = views.renderView(() => {});
  await clickButton(rendered, 'Create');
  assert.equal(first(rendered, 'p').textContent, 'Group name is required');
});

test('failed create preserves relevant error', async () => {
  resetStore();
  state.store.view = 'groups';
  apiState.groupCreateResult = { ok: false, code: 'GROUP_FAILED', message: 'Group create failed' };
  const rendered = views.renderView(() => {});
  first(rendered, 'input').value = 'QA Group Fixed';
  await clickButton(rendered, 'Create');
  assert.equal(first(rendered, 'p').textContent, 'GROUP_FAILED: Group create failed');
  assert.equal(state.store.groups.length, 0);
});

test('successful create clears previous validation error and updates group list', async () => {
  resetStore();
  state.store.view = 'groups';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Create');
  assert.equal(first(current, 'p').textContent, 'Group name is required');
  first(current, 'input').value = 'QA Group Fixed';
  await clickButton(current, 'Create');
  assert.equal(first(current, 'p').textContent, '');
  assert.equal(state.store.groups[0].name, 'QA Group Fixed');
  assert.ok(all(current, (node) => node.localName === 'input').some((input) => input.value === 'QA Group Fixed'));
});

test('double submit does not create duplicate unintended groups', async () => {
  resetStore();
  state.store.view = 'groups';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'input').value = 'QA Group Fixed';
  await clickButton(current, 'Create');
  await clickButton(current, 'Create');
  assert.equal(state.store.groups.filter((group) => group.name === 'QA Group Fixed').length, 1);
});

test('navigation away and back does not resurrect stale validation error', async () => {
  resetStore();
  state.store.view = 'groups';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Create');
  first(current, 'input').value = 'QA Group Fixed';
  await clickButton(current, 'Create');
  state.store.view = 'overview';
  views.renderView(() => {});
  state.store.view = 'groups';
  current = views.renderView(() => {});
  assert.equal(first(current, 'p').textContent, '');
  assert.ok(all(current, (node) => node.localName === 'input').some((input) => input.value === 'QA Group Fixed'));
});

test('pairing request and confirm notices survive renderer refresh', async () => {
  resetStore();
  state.store.view = 'pairing';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'textarea').value = JSON.stringify({ deviceId: 'dev-a', displayName: 'Agent A' });
  await clickButton(current, 'Request pairing');
  assert.ok(current.textContent.includes('Pairing requested. Code: 123456'));

  state.store.pairings.pending = [{ requestId: 'pair-a', displayName: 'Agent A', expiresAt: '2026-07-17T00:00:00.000Z' }];
  current = views.renderView(() => { current = views.renderView(() => {}); });
  first(current, 'input').value = '123456';
  await clickButton(current, 'Confirm');
  assert.ok(current.textContent.includes('Pairing confirmed'));
  assert.ok(current.textContent.includes('test-credential'));
});

test('pairing controls reconnect an Agent and delete its pairing', async () => {
  resetStore();
  state.store.view = 'pairing';
  state.store.pairings = { pending: [], paired: [{ deviceId: 'dev-a', pairedAt: '2026-07-16T00:00:00.000Z', revokedAt: null }] };
  state.store.sessions = [{ deviceId: 'dev-a', status: 'offline' }];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Reconnect');
  assert.deepEqual(apiState.pairingReconnects, ['dev-a']);

  resetStore();
  state.store.view = 'pairing';
  state.store.pairings = { pending: [], paired: [{ deviceId: 'dev-a', pairedAt: '2026-07-16T00:00:00.000Z', revokedAt: null }] };
  const previousConfirm = window.confirm;
  window.confirm = () => true;
  try {
    current = views.renderView(() => { current = views.renderView(() => {}); });
    await clickButton(current, 'Delete');
  } finally {
    window.confirm = previousConfirm;
  }
  assert.deepEqual(apiState.pairingDeletes, ['dev-a']);
});

test('diagnostics runs and applies a targeted repair through the renderer', async () => {
  resetStore();
  state.store.view = 'diagnostics';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Run diagnostics');
  assert.equal(apiState.diagnosticsRuns, 1);
  assert.ok(current.textContent.includes('WSS_READY'));
  await clickButton(current, 'Reload WSS/TLS');
  assert.deepEqual(apiState.diagnosticsRepairs, [{ targetId: 'wss' }]);
});

test('workspace exposes reconnect controls for Linux hosts and managed containers', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.workspace.containerHosts = [{ id: 'ssh-host-1', label: 'Reviewed Linux', name: 'Reviewed Linux', target: 'root@192.168.1.201', connected: true, diagnostics: { ready: true } }];
  state.store.containers = [containerFixture({ id: 'container-1', host: 'ssh-host-1', status: 'running' })];
  state.store.sessions = [{ deviceId: 'managed-device-1', status: 'offline' }];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  const reconnectButtons = all(current, (node) => node.localName === 'button' && node.textContent === i18n.t('workspace.containers.reconnect'));
  assert.ok(reconnectButtons.length >= 2);
  await reconnectButtons[0].click();
  await reconnectButtons.at(-1).click();
  assert.equal(apiState.hostCalls.reconnect, 1);
  assert.equal(apiState.containerCalls.reconnect, 1);
});

test('remote control view sends one synchronized command to every selected online container', async () => {
  resetStore();
  state.store.view = 'remote';
  state.store.containers = [
    containerFixture({ id: 'container-1', deviceId: 'managed-device-1', name: 'Chromium 1', status: 'running' }),
    containerFixture({ id: 'container-2', deviceId: 'managed-device-2', name: 'Chromium 2', status: 'running' }),
  ];
  state.store.devices = [deviceFixture('managed-device-1', 'Chromium 1'), deviceFixture('managed-device-2', 'Chromium 2')];
  state.store.sessions = [
    { deviceId: 'managed-device-1', status: 'online' },
    { deviceId: 'managed-device-2', status: 'online' },
  ];
  state.store.remote = { selectedDeviceIds: ['managed-device-1', 'managed-device-2'], selectionInitialized: true, activeDeviceId: 'managed-device-1', synchronized: true, fps: 3, live: false, frames: {}, pending: {}, notice: '', error: '' };

  const current = views.renderView(() => {});
  await clickButton(current, i18n.t('remote.stopInput'));

  assert.deepEqual(apiState.remoteCalls, [{ deviceIds: ['managed-device-1', 'managed-device-2'], command: 'input.stopAll', payload: {}, synchronized: true }]);
  assert.ok(current.textContent.includes('Ctrl+V'));
});

test('remote pointer remains safe when the first frame arrives during a drag', async () => {
  resetStore();
  state.store.view = 'remote';
  state.store.containers = [containerFixture({ id: 'container-1', deviceId: 'managed-device-1', name: 'Chromium 1', status: 'running' })];
  state.store.devices = [deviceFixture('managed-device-1', 'Chromium 1')];
  state.store.sessions = [{ deviceId: 'managed-device-1', status: 'online' }];
  state.store.remote = { selectedDeviceIds: ['managed-device-1'], selectionInitialized: true, activeDeviceId: 'managed-device-1', synchronized: false, fps: 3, live: false, frames: {}, pending: {}, notice: '', error: '' };

  const current = views.renderView(() => {});
  const image = first(current, 'img');
  image.focus = () => {};
  image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  await fireWithEvent(image, 'pointerdown', { clientX: 100, clientY: 100 });
  state.store.remote.frames['managed-device-1'] = { mimeType: 'image/jpeg', data: 'YQ==', width: 800, height: 600 };
  await fireWithEvent(image, 'pointermove', { clientX: 120, clientY: 120 });
  await fireWithEvent(image, 'pointerup', { clientX: 120, clientY: 120 });

  assert.deepEqual(apiState.remoteCalls.map((call) => call.command), ['input.mouseMove', 'input.mouseUp']);
});

test('remote live view shows automatic Agent update and clears it when the first frame arrives', async () => {
  resetStore();
  state.store.view = 'remote';
  state.store.containers = [containerFixture({ id: 'container-1', deviceId: 'managed-device-1', name: 'Chromium 1', status: 'running' })];
  state.store.devices = [deviceFixture('managed-device-1', 'Chromium 1')];
  state.store.sessions = [{ deviceId: 'managed-device-1', status: 'online' }];
  state.store.remote = { selectedDeviceIds: ['managed-device-1'], selectionInitialized: true, activeDeviceId: 'managed-device-1', synchronized: false, fps: 6, live: true, frames: {}, pending: {}, notice: '', error: '' };
  const originalCapture = window.warController.remote.capture;
  let captureCalls = 0;
  window.warController.remote.capture = async ({ deviceId }) => {
    captureCalls += 1;
    if (captureCalls === 1) return { ok: true, data: { deviceId, status: 'updating', code: 'REMOTE_AGENT_UPDATING', frame: null } };
    return { ok: true, data: { deviceId, frame: { mimeType: 'image/jpeg', data: 'YQ==', width: 800, height: 600 } } };
  };

  try {
    const current = views.renderView(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    const placeholder = all(current, (node) => node.className === 'remote-screen-placeholder')[0];
    assert.equal(placeholder.textContent, i18n.t('remote.updating'));
    assert.ok(current.textContent.includes(i18n.t('remote.updating')));

    await new Promise((resolve) => setTimeout(resolve, 220));
    const image = first(current, 'img');
    assert.equal(image.getAttribute('src'), 'data:image/jpeg;base64,YQ==');
    assert.equal(placeholder.hidden, true);
    assert.equal(state.store.remote.error, '');
    assert.equal(state.store.remote.notice, '');
  } finally {
    window.warController.remote.capture = originalCapture;
    state.store.remote.live = false;
    state.store.view = 'overview';
    views.renderView(() => {});
  }
});

test('jobs dispatch transport warning remains visible after refresh', async () => {
  resetStore();
  state.store.view = 'jobs';
  state.store.devices = [deviceFixture('dev-a', 'Agent A')];
  state.store.workflows = [{ workflowId: 'wf-a', revision: 1 }];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  const selects = all(current, (node) => node.localName === 'select');
  selects[0].value = 'dev-a';
  selects[1].value = 'wf-a:1';

  await clickButton(current, 'Dispatch');

  assert.ok(current.textContent.includes('Transport warning: SESSION_OFFLINE'));
  assert.equal(state.store.jobTransports['job-offline'].warningCode, 'SESSION_OFFLINE');
});

function resetStore() {
  views.clearPairingSecret();
  globalThis.__fakeGlobalListeners?.clear();
  apiState.groups = [];
  apiState.containers = [];
  apiState.containerCalls = {};
  apiState.containerResults = {};
  apiState.containerHostsResult = null;
  apiState.trashHosts = [];
  apiState.hostCalls = {};
  apiState.hostRequests = [];
  apiState.hostUpdateResult = null;
  apiState.hostRepairResult = null;
  apiState.hostUpdateGate = null;
  apiState.lastContainerAddPayload = null;
  apiState.containerAddDelay = false;
  apiState.originCalls = {};
  apiState.originPreviewDelay = false;
  apiState.originPullDelay = false;
  apiState.originPreviewResult = null;
  apiState.originPullResult = null;
  apiState.groupedCalls = {};
  apiState.groupedRequests = [];
  apiState.groupedPreviewResult = null;
  apiState.groupedDispatchResult = null;
  apiState.groupedDispatchDelay = false;
  apiState.graphCalls = {};
  apiState.graphRequests = [];
  apiState.graphSaveDelay = false;
  apiState.workflows = [];
  apiState.devices = [];
  apiState.jobDispatchRequests = [];
  apiState.jobDispatchResult = null;
  apiState.jobDispatchGate = null;
  apiState.groupCreateResult = null;
  apiState.settingsUpdates = [];
  apiState.pairingReconnects = [];
  apiState.pairingDeletes = [];
  apiState.diagnosticsRuns = 0;
  apiState.diagnosticsRepairs = [];
  apiState.diagnosticsResult = null;
  apiState.diagnosticsRepairResult = null;
  apiState.remoteCalls = [];
  Object.assign(state.store, {
    view: 'overview',
    settings: { locale: 'vi', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } },
    workspace: {
      selection: { selectedIds: new Set(), anchorId: null },
      activeInputMode: 'text',
      activePane: 'containers',
      search: '',
      deviceFilter: 'all',
      filterOpen: false,
      inputDraft: '',
      inputGrid: {},
      pickedCells: [],
      addContainerOpen: false,
      containerNamePrefix: '',
      containerNameSequence: null,
      containerHostId: '',
      containerHosts: [],
      trashHosts: [],
      trashOpen: false,
      trashPending: {},
      trashError: '',
      containerHostStatus: 'idle',
      containerNotice: '',
      hostSetupOpen: false,
      hostEditorId: '',
      hostDraft: { name: '', target: '', identityFile: '', controllerHost: '', controllerCaPath: '/etc/war/controller-ca.pem', image: 'war-browser-agent:phase1' },
      hostPending: '',
      hostError: '',
      addContainerPending: false,
      containerPending: {},
      containerErrors: {},
      containerAllPending: false,
      hostNicknameDraft: '',
      containerNetworkOpenId: '',
      graphViewport: { scale: 1, offsetX: 0, offsetY: 0 },
      graphViewportInitialized: false,
      graphSelectedNodeId: '',
      graphEditMode: true,
      graphDraftEdges: [
        { from: 'sample-switch', to: 'sample-click' },
        { from: 'sample-click', to: 'sample-input' },
      ],
      graphConnectingFrom: '',
      graphInputGroups: [{ id: 'group-1', name: '', nodeIds: [] }],
      graphActiveGroupId: 'group-1',
      graphDraftNodes: workspaceState.WORKSPACE_SAMPLE_NODES.map((node) => ({ ...node })),
      graphHistory: [],
      graphFuture: [],
    },
    bootstrap: { deviceCount: 0, sessionCount: 0, groupCount: 0, workflowCount: 0, applicationVersion: 'test' },
    runtime: { status: 'disabled', enabled: false, bindHost: '127.0.0.1', port: 0 },
    pairings: { pending: [], paired: [] },
    devices: [],
    sessions: [],
    containers: [],
    remote: { selectedDeviceIds: [], selectionInitialized: false, activeDeviceId: '', synchronized: false, fps: 3, live: false, frames: {}, pending: {}, notice: '', error: '' },
    groups: [],
    workflows: [],
    jobs: [],
    selectedWorkflow: null,
    originSync: {
      deviceId: '',
      conflictPolicy: 'preserveBoth',
      pending: '',
      notice: '',
      error: '',
    },
    originSyncPreview: null,
    originSyncResult: null,
    selectedJob: null,
    jobEvents: [],
    jobTransports: {},
    diagnostics: null,
    diagnosticsPending: false,
    diagnosticsNotice: '',
    diagnosticsError: '',
    groupedInput: {
      mode: 'text',
      text: '',
      selectedDeviceIds: [],
      broadcastSingleRow: true,
      pending: '',
      notice: '',
      error: '',
    },
    groupedInputPreview: null,
    groupedInputResult: null,
    taskPackage: {
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
    },
    taskPackagePreview: null,
    taskPackageResult: null,
    graphEditor: {
      workflowId: '',
      revision: 0,
      graph: null,
      operations: [],
      selectedNodeId: '',
      pending: '',
      notice: '',
      error: '',
      unsaved: false,
    },
    lastJobNotice: '',
    lastRefresh: null,
  });
}

async function clickButton(root, label) {
  const button = findButton(root, label);
  assert.ok(button, `Missing button ${label}`);
  await button.click();
}

function findButton(root, label) {
  return all(root, (node) => node.localName === 'button' && node.textContent === label)[0];
}

async function fire(node, type) {
  for (const listener of node.listeners.get(type) || []) {
    await listener({ currentTarget: node, target: node });
  }
}

async function fireWithEvent(node, type, event = {}) {
  for (const listener of node.listeners.get(type) || []) {
    await listener({ currentTarget: node, target: node, ...event });
  }
}

async function dispatchGlobal(type, event = {}) {
  for (const listener of globalThis.__fakeGlobalListeners?.get(type) || []) {
    await listener(event);
  }
}

function accessibleName(node) {
  return (node.getAttribute('aria-label') || node.textContent || optionText(node)).trim();
}

function optionText(node) {
  if (node.localName !== 'select') return '';
  return first(node, 'option')?.textContent || '';
}

function first(root, localName) {
  return all(root, (node) => node.localName === localName)[0];
}

function all(root, predicate) {
  const result = [];
  visit(root);
  return result;

  function visit(node) {
    if (!(node instanceof FakeElement)) return;
    if (predicate(node)) result.push(node);
    for (const child of node.childNodes) visit(child);
  }
}

const apiState = {
  groups: [],
  containers: [],
  containerCalls: {},
  containerResults: {},
  containerHostsResult: null,
  trashHosts: [],
  hostCalls: {},
  hostRequests: [],
  hostUpdateResult: null,
  hostRepairResult: null,
  hostUpdateGate: null,
  lastContainerAddPayload: null,
  containerAddDelay: false,
  originCalls: {},
  originPreviewDelay: false,
  originPullDelay: false,
  originPreviewResult: null,
  originPullResult: null,
  groupedCalls: {},
  groupedRequests: [],
  groupedPreviewResult: null,
  groupedDispatchResult: null,
  groupedDispatchDelay: false,
  graphCalls: {},
  graphRequests: [],
  graphSaveDelay: false,
  workflows: [],
  devices: [],
  jobDispatchRequests: [],
  jobDispatchResult: null,
  jobDispatchGate: null,
  groupCreateResult: null,
  settingsUpdates: [],
  pairingReconnects: [],
  pairingDeletes: [],
  diagnosticsRuns: 0,
  diagnosticsRepairs: [],
  diagnosticsResult: null,
  diagnosticsRepairResult: null,
  remoteCalls: [],
};

function installControllerApi() {
  globalThis.window = {
    confirm: () => false,
    warController: {
      system: {
        getBootstrapState: async () => ({ ok: true, data: { deviceCount: 0, sessionCount: 0, groupCount: apiState.groups.length, workflowCount: 0, applicationVersion: 'test' } }),
        getRuntimeStatus: async () => ({ ok: true, data: { status: 'disabled', enabled: false, bindHost: '127.0.0.1', port: 0 } }),
      },
      pairings: {
        list: async () => ({ ok: true, data: { pending: [], paired: [] } }),
        request: async () => ({ ok: true, data: { code: '123456' } }),
        confirm: async () => ({ ok: true, data: { credential: 'test-credential' } }),
        reject: async () => ({ ok: true, data: {} }),
        revoke: async ({ deviceId }) => {
          apiState.pairingDeletes = [...(apiState.pairingDeletes || []), deviceId];
          return { ok: true, data: {} };
        },
        reconnect: async ({ deviceId }) => {
          apiState.pairingReconnects = [...(apiState.pairingReconnects || []), deviceId];
          return { ok: true, data: { deviceId, status: 'reconnecting' } };
        },
      },
      devices: { list: async () => ({ ok: true, data: { devices: apiState.devices } }) },
      settings: {
        get: async () => ({ ok: true, data: { locale: 'vi', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } } }),
        update: async (payload) => {
          apiState.settingsUpdates.push(payload);
          return { ok: true, data: payload };
        },
      },
      sessions: { list: async () => ({ ok: true, data: { sessions: [] } }) },
      remote: {
        capture: async ({ deviceId }) => ({ ok: true, data: { deviceId, frame: { mimeType: 'image/jpeg', data: 'YQ==', width: 800, height: 600 } } }),
        control: async (payload) => {
          apiState.remoteCalls.push(structuredClone(payload));
          return { ok: true, data: { command: payload.command, synchronized: payload.synchronized === true, targets: (payload.deviceIds || []).map((deviceId) => ({ deviceId, ok: true })) } };
        },
      },
      containers: {
        list: async () => ({ ok: true, data: { containers: apiState.containers } }),
        trash: async () => ({ ok: true, data: { containers: apiState.containers.filter((container) => container.status === 'deleted'), hosts: apiState.trashHosts } }),
        hosts: async () => apiState.containerHostsResult || ({
          ok: true,
          data: { status: 'connected', hosts: [{ id: 'configured-docker-host', label: 'Linux Docker', runtime: 'ssh-docker', connected: true }] },
        }),
        addHost: async (payload) => {
          apiState.hostCalls.add = (apiState.hostCalls.add || 0) + 1;
          apiState.hostRequests.push(structuredClone(payload));
          apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [{ id: 'ssh-host-1', label: payload.name, name: payload.name, target: payload.target, runtime: 'ssh-docker', connected: false }] } };
          return { ok: true, data: { id: 'ssh-host-1', label: payload.name, name: payload.name, target: payload.target, connected: false } };
        },
        updateHost: async ({ hostId, ...payload }) => {
          apiState.hostCalls.update = (apiState.hostCalls.update || 0) + 1;
          apiState.hostRequests.push(structuredClone({ hostId, ...payload }));
          if (apiState.hostUpdateGate) await apiState.hostUpdateGate;
          if (apiState.hostUpdateResult) return apiState.hostUpdateResult;
          const hosts = apiState.containerHostsResult?.data?.hosts || [];
          const current = hosts.find((item) => item.id === hostId) || { id: hostId };
          const updated = { ...current, ...payload, id: hostId, label: payload.name, connected: false };
          apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: hosts.map((item) => item.id === hostId ? updated : item) } };
          return { ok: true, data: updated };
        },
        checkHost: async ({ hostId }) => ({ ok: true, data: { id: hostId, label: 'Reviewed Linux', target: 'root@192.168.1.201', connected: false } }),
        reconnectHost: async ({ hostId }) => {
          apiState.hostCalls.reconnect = (apiState.hostCalls.reconnect || 0) + 1;
          return { ok: true, data: { id: hostId, label: 'Reviewed Linux', connected: true } };
        },
        repairHost: async ({ hostId }) => {
          apiState.hostCalls.repair = (apiState.hostCalls.repair || 0) + 1;
          if (apiState.hostRepairResult) return apiState.hostRepairResult;
          apiState.containerHostsResult = { ok: true, data: { status: 'connected', hosts: [{ id: hostId, label: 'Reviewed Linux', name: 'Reviewed Linux', target: 'root@192.168.1.201', runtime: 'ssh-docker', connected: true, diagnostics: { ready: true } }] } };
          return { ok: true, data: { id: hostId, label: 'Reviewed Linux', connected: true } };
        },
        trashHost: async ({ hostId }) => {
          apiState.hostCalls.trash = (apiState.hostCalls.trash || 0) + 1;
          const hosts = apiState.containerHostsResult?.data?.hosts || [];
          const host = hosts.find((item) => item.id === hostId) || { id: hostId, label: hostId };
          apiState.trashHosts = [...apiState.trashHosts, { ...host, deletedAt: '2026-07-16T00:00:00.000Z' }];
          apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: hosts.filter((item) => item.id !== hostId) } };
          return { ok: true, data: host };
        },
        restoreHost: async ({ hostId }) => {
          apiState.hostCalls.restore = (apiState.hostCalls.restore || 0) + 1;
          const host = apiState.trashHosts.find((item) => item.id === hostId);
          apiState.trashHosts = apiState.trashHosts.filter((item) => item.id !== hostId);
          const active = apiState.containerHostsResult?.data?.hosts || [];
          apiState.containerHostsResult = { ok: true, data: { status: 'unavailable', hosts: [...active, { ...host, connected: false }] } };
          return { ok: true, data: host };
        },
        purgeHost: async ({ hostId }) => {
          apiState.hostCalls.purge = (apiState.hostCalls.purge || 0) + 1;
          apiState.trashHosts = apiState.trashHosts.filter((item) => item.id !== hostId);
          return { ok: true, data: { id: hostId } };
        },
        add: async (payload) => {
          const { name, image, host, runtime } = payload;
          apiState.lastContainerAddPayload = structuredClone(payload);
          apiState.containerCalls.add = (apiState.containerCalls.add || 0) + 1;
          if (apiState.containerAddDelay) await Promise.resolve();
          const container = {
            id: `container-${apiState.containers.length + 1}`,
            name,
            image,
            host,
            status: 'running',
            deviceId: `managed-device-${apiState.containers.length + 1}`,
            runtime: { ...runtime, dockerName: runtime?.dockerName || `war-${apiState.containers.length + 1}`, privileged: false },
            resourceUsage: { cpuPercent: 1, memoryBytes: 1024 * 1024 },
          };
          apiState.containers = [...apiState.containers, container];
          return { ok: true, data: { container, operation: { ok: true } } };
        },
        start: async ({ containerId }) => containerOperation('start', containerId, 'running'),
        stop: async ({ containerId }) => containerOperation('stop', containerId, 'stopped'),
        restart: async ({ containerId }) => containerOperation('restart', containerId, 'running'),
        reconnect: async ({ containerId }) => containerOperation('reconnect', containerId, 'running'),
        refresh: async ({ containerId }) => containerOperation('refresh', containerId, 'running'),
        updateNetwork: async ({ containerId, ...network }) => {
          apiState.containerCalls.updateNetwork = (apiState.containerCalls.updateNetwork || 0) + 1;
          apiState.containers = apiState.containers.map((container) => container.id === containerId
            ? { ...container, runtime: { ...container.runtime, ...network, ipv6Address: network.ipv6Enabled ? `2001:db8:1:2:${network.ipv6Suffix}` : null } }
            : container);
          return { ok: true, data: { container: apiState.containers.find((container) => container.id === containerId), operation: { ok: true } } };
        },
        duplicate: async ({ containerId }) => {
          apiState.containerCalls.duplicate = (apiState.containerCalls.duplicate || 0) + 1;
          if (apiState.containerResults.duplicate) return apiState.containerResults.duplicate;
          const source = apiState.containers.find((container) => container.id === containerId);
          apiState.containers = [...apiState.containers, containerFixture({ id: `container-${apiState.containers.length + 1}`, name: `${source?.name || containerId} copy` })];
          return { ok: true, data: {} };
        },
        delete: async ({ containerId }) => containerOperation('delete', containerId, 'deleted'),
        restore: async ({ containerId }) => containerOperation('restore', containerId, 'stopped'),
        purge: async ({ containerId }) => {
          apiState.containerCalls.purge = (apiState.containerCalls.purge || 0) + 1;
          apiState.containers = apiState.containers.filter((container) => container.id !== containerId);
          return { ok: true, data: { operation: { ok: true }, purged: { id: containerId } } };
        },
      },
      groups: {
        list: async () => ({ ok: true, data: { groups: apiState.groups } }),
        create: async ({ name }) => {
          if (apiState.groupCreateResult) return apiState.groupCreateResult;
          if (!apiState.groups.some((group) => group.name === name)) {
            apiState.groups = [...apiState.groups, { id: `group-${apiState.groups.length + 1}`, name, deviceIds: [] }];
          }
          return { ok: true, data: apiState.groups.at(-1) };
        },
        update: async () => ({ ok: true, data: {} }),
        remove: async () => ({ ok: true, data: {} }),
        addDevice: async () => ({ ok: true, data: {} }),
        removeDevice: async () => ({ ok: true, data: {} }),
      },
      workflows: {
        list: async () => ({ ok: true, data: { workflows: apiState.workflows } }),
        importFile: async () => ({ ok: true, data: {} }),
        get: async () => ({ ok: true, data: {} }),
        graphGet: async (request) => {
          apiState.graphCalls.get = (apiState.graphCalls.get || 0) + 1;
          apiState.graphRequests.push(request);
          return { ok: true, data: graphFixture() };
        },
        graphPreview: async (request) => {
          apiState.graphCalls.preview = (apiState.graphCalls.preview || 0) + 1;
          apiState.graphRequests.push(request);
          return { ok: true, data: graphFixture({ executionPlan: ['a', 'b'] }) };
        },
        graphSave: async (request) => {
          apiState.graphCalls.save = (apiState.graphCalls.save || 0) + 1;
          apiState.graphRequests.push(request);
          if (apiState.graphSaveDelay) await Promise.resolve();
          apiState.workflows = [
            { workflowId: 'wf-a', revision: 1, name: 'Workflow A' },
            { workflowId: 'wf-a', revision: 2, name: 'Workflow A' },
          ];
          return {
            ok: true,
            data: {
              saved: { revision: { workflowId: 'wf-a', revision: 2, name: 'Workflow A' } },
              graph: graphFixture({ workflow: { workflowId: 'wf-a', revision: 2, name: 'Workflow A' } }),
            },
          };
        },
        originPreview: async () => {
          apiState.originCalls.preview = (apiState.originCalls.preview || 0) + 1;
          if (apiState.originPreviewDelay) await Promise.resolve();
          return apiState.originPreviewResult || { ok: true, data: originPreviewFixture() };
        },
        originPull: async () => {
          apiState.originCalls.pull = (apiState.originCalls.pull || 0) + 1;
          if (apiState.originPullDelay) await Promise.resolve();
          if (apiState.originPullResult) return apiState.originPullResult;
          apiState.workflows = [{ workflowId: 'wf-origin', revision: 1, name: 'Origin' }];
          return { ok: true, data: { imported: [], skipped: [{ workflowId: 'wf-origin', revision: 1 }] } };
        },
      },
      jobs: {
        list: async () => ({ ok: true, data: { jobs: [] } }),
        dispatch: async (request) => {
          const index = apiState.jobDispatchRequests.length;
          apiState.jobDispatchRequests.push(structuredClone(request));
          if (apiState.jobDispatchGate) await apiState.jobDispatchGate;
          return typeof apiState.jobDispatchResult === 'function'
            ? apiState.jobDispatchResult(request, index)
            : apiState.jobDispatchResult || { ok: true, data: { job: { id: 'job-offline' }, transport: { delivered: false, warningCode: 'SESSION_OFFLINE' } } };
        },
        groupedPreview: async (request) => {
          apiState.groupedCalls.preview = (apiState.groupedCalls.preview || 0) + 1;
          apiState.groupedRequests.push(request);
          return apiState.groupedPreviewResult || { ok: true, data: groupedPlanFixture(request) };
        },
        groupedDispatch: async (request) => {
          apiState.groupedCalls.dispatch = (apiState.groupedCalls.dispatch || 0) + 1;
          apiState.groupedRequests.push(request);
          if (apiState.groupedDispatchDelay) await Promise.resolve();
          return apiState.groupedDispatchResult || {
            ok: true,
            data: {
              ...groupedPlanFixture(request),
              dispatched: [{ deviceId: 'dev-a', job: { id: 'job-a' }, transport: { delivered: true } }],
            },
          };
        },
        get: async () => ({ ok: true, data: {} }),
        events: async () => ({ ok: true, data: { events: [] } }),
        cancel: async () => ({ ok: true, data: {} }),
      },
      diagnostics: {
        run: async () => {
          apiState.diagnosticsRuns = (apiState.diagnosticsRuns || 0) + 1;
          return apiState.diagnosticsResult || { ok: true, data: { summary: { total: 1, ok: 1, warning: 0, error: 0, fixable: 1 }, checks: [{ id: 'wss', area: 'wss', severity: 'ok', code: 'WSS_READY', message: 'WSS ready', fixable: true, action: 'refresh-wss' }] } };
        },
        repair: async (payload) => {
          apiState.diagnosticsRepairs = [...(apiState.diagnosticsRepairs || []), payload];
          return apiState.diagnosticsRepairResult || { ok: true, data: { repairs: [{ targetId: payload.targetId || 'wss' }], failures: [], diagnostics: { summary: { total: 1, ok: 1, warning: 0, error: 0, fixable: 1 }, checks: [] } } };
        },
      },
      dialogs: {
        importDeviceDescriptor: async () => ({ ok: true, data: { canceled: true } }),
        importWorkflow: async () => ({ ok: true, data: { canceled: true } }),
      },
    },
  };
}

function deviceFixture(deviceId, displayName) {
  return {
    deviceId,
    displayName,
    status: 'online',
    agentVersion: '0.1',
    extensionVersion: '0.1',
    groupIds: [],
  };
}

function containerFixture(overrides = {}) {
  return {
    id: 'container-1',
    name: 'Agent One',
    image: 'war-browser-agent:test',
    deviceId: 'managed-device-1',
    status: 'running',
    runtime: { dockerName: 'war-agent-one', privileged: false },
    resourceUsage: { cpuPercent: 1, memoryBytes: 1024 * 1024 },
    ...overrides,
  };
}

async function containerOperation(action, containerId, status) {
  apiState.containerCalls[action] = (apiState.containerCalls[action] || 0) + 1;
  if (apiState.containerResults[action]) return apiState.containerResults[action];
  apiState.containers = apiState.containers.map((container) => (
    container.id === containerId ? { ...container, status, lastError: null } : container
  ));
  return { ok: true, data: {} };
}

function setValidOrigin() {
  state.store.sessions = [{ deviceId: 'dev-online', status: 'online' }];
  state.store.devices = [{ id: 'dev-online', name: 'Agent Online', status: 'online' }];
  state.store.pairings = { pending: [], paired: [{ deviceId: 'dev-online', revokedAt: null }] };
}

function originPreviewFixture() {
  return {
    counts: { workflows: 2 },
    workflows: [
      { workflowId: 'wf-origin', revision: 1, name: 'Origin', action: 'skip', conflict: false, secretValue: 'top-secret-value' },
      { workflowId: 'wf-conflict', revision: 2, name: 'Conflict', action: 'preserveBoth', conflict: true },
    ],
  };
}

function setGroupedFixtures() {
  state.store.devices = [{ id: 'dev-a', name: 'Agent A', status: 'online' }];
  state.store.workflows = [{ workflowId: 'wf-a', revision: 1, name: 'Workflow A' }];
}

function setTaskPackageFixtures() {
  apiState.devices = [
    { id: 'dev-a', name: 'Agent A', status: 'online' },
    { id: 'dev-b', name: 'Agent B', status: 'online' },
  ];
  apiState.workflows = [
    { workflowId: 'wf-a', revision: 1, name: 'Workflow A' },
    { workflowId: 'wf-b', revision: 2, name: 'Workflow B' },
  ];
  state.store.devices = apiState.devices;
  state.store.workflows = apiState.workflows;
}

async function prepareGroupedForm(root, { text, mode }) {
  const workflow = all(root, (node) => node.localName === 'select' && !node.multiple && node.options.some((option) => option.value === 'wf-a:1'))[0];
  const devices = all(root, (node) => node.getAttribute('aria-label') === i18n.t('groupedInput.devices'))[0];
  const groupedMode = all(root, (node) => node.getAttribute('aria-label') === i18n.t('groupedInput.mode'))[0];
  workflow.value = 'wf-a:1';
  devices.options[0].selected = true;
  groupedMode.value = mode;
  const groupedText = all(root, (node) => node.localName === 'textarea').at(-1);
  groupedText.value = text;
  Object.assign(state.store.groupedInput, {
    mode,
    text,
    selectedDeviceIds: ['dev-a'],
    broadcastSingleRow: true,
  });
}

function groupedPlanFixture(request = {}) {
  const text = request.text || state.store.groupedInput.text || 'hôm nay thật vui';
  return {
    mode: request.mode || state.store.groupedInput.mode || 'text',
    counts: { devices: 1, rows: 1, assignments: 1 },
    assignments: [{ deviceId: 'dev-a', sourceRowIndex: 0, preview: { value: text } }],
  };
}

function setGraphFixtures() {
  apiState.workflows = [{ workflowId: 'wf-a', revision: 1, name: 'Workflow A' }];
  state.store.workflows = apiState.workflows;
  state.store.selectedWorkflow = {
    workflowId: 'wf-a',
    revision: 1,
    name: 'Workflow A',
    requiredInputs: [],
    profilePayload: { steps: [{ id: 'a', type: 'log', name: 'Step A', message: 'hello', next: 'b' }, { id: 'b', type: 'log', name: 'Step B', message: 'done' }] },
  };
}

function graphFixture(overrides = {}) {
  return {
    workflow: { workflowId: 'wf-a', revision: 1, name: 'Workflow A' },
    nodes: [
      { id: 'a', type: 'log', name: 'Step A', message: 'hello', next: 'b' },
      { id: 'b', type: 'log', name: 'Step B', message: 'done' },
    ],
    edges: [{ from: 'a', to: 'b' }],
    validation: { ok: true, errors: [], roots: ['a'] },
    executionPlan: ['a', 'b'],
    ...overrides,
  };
}

function installFakeDom() {
  globalThis.Node = FakeNode;
  globalThis.__fakeGlobalListeners = new Map();
  globalThis.addEventListener = (type, listener) => {
    const listeners = globalThis.__fakeGlobalListeners.get(type) || [];
    listeners.push(listener);
    globalThis.__fakeGlobalListeners.set(type, listeners);
  };
  globalThis.removeEventListener = (type, listener) => {
    const listeners = globalThis.__fakeGlobalListeners.get(type) || [];
    globalThis.__fakeGlobalListeners.set(type, listeners.filter((item) => item !== listener));
  };
  globalThis.document = {
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (value) => new FakeText(value),
  };
}
