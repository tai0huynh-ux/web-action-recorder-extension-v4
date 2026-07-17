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
    this.style = { setProperty() {} };
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
const i18n = await import('../renderer/i18n.js');
const state = await import('../renderer/state.js');
const views = await import('../renderer/views.js');

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
    'Tổng quan',
    'Ghép nối',
    'Thiết bị',
    'Nhóm',
    'Quy trình',
    'Tác vụ',
    'Chẩn đoán',
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

test('workspace selected machine count updates', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.devices = [deviceFixture('dev-a', 'Máy 1'), deviceFixture('dev-b', 'Máy 2')];
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, 'Máy 1Trực tuyếndev-aAgent 0.1 / Ext 0.1Chưa có dữ liệuGốc');
  assert.equal(state.store.workspace.selection.selectedIds.has('dev-a'), true);
  current = views.renderView(() => {});
  assert.ok(current.textContent.includes('Đã chọn 1 máy'));
});

test('workspace add container uses the Controller containers API and refreshes managed list', async () => {
  resetStore();
  state.store.view = 'workspace';
  let current = views.renderView(() => { current = views.renderView(() => {}); });
  await clickButton(current, '+ Thêm container');
  const inputs = all(current, (node) => node.localName === 'input');
  inputs[1].value = 'Agent One';
  inputs[3].value = 'war-agent-one';
  await clickButton(current, 'Tạo');
  assert.equal(apiState.containers[0].runtime.dockerName, 'war-agent-one');
  assert.ok(state.store.containers.some((container) => container.name === 'Agent One'));
  assert.equal(state.store.containers[0].status, 'running');
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
  assert.equal(apiState.containers.filter((container) => container.name === 'Agent One').length, 1);
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

test('managed container delete requires exact confirmation', async () => {
  resetStore();
  state.store.view = 'workspace';
  state.store.containers = [containerFixture({ id: 'container-1', name: 'Agent One' })];
  let confirmText = '';
  window.confirm = (message) => { confirmText = message; return false; };
  const rendered = views.renderView(() => {});
  await clickButton(rendered, 'Xóa');
  assert.equal(apiState.containerCalls.delete || 0, 0);
  assert.ok(confirmText.includes('Agent One'));
  assert.ok(confirmText.includes('container-1'));
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
  const selects = all(rendered, (node) => node.localName === 'select');
  const mode = selects[3];
  const groupedText = all(rendered, (node) => node.localName === 'textarea')[1];
  groupedText.value = 'hôm nay thật vui';
  await fire(groupedText, 'input');
  mode.value = 'cell';
  await fire(mode, 'change');
  assert.equal(state.store.groupedInput.mode, 'cell');
  assert.equal(state.store.groupedInput.text, 'hôm nay thật vui');
  assert.equal(state.store.groupedInputPreview, null);
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
  apiState.groups = [];
  apiState.containers = [];
  apiState.containerCalls = {};
  apiState.containerResults = {};
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
  apiState.groupCreateResult = null;
  apiState.settingsUpdates = [];
  Object.assign(state.store, {
    view: 'overview',
    settings: { locale: 'vi', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } },
    workspace: {
      selection: { selectedIds: new Set(), anchorId: null },
      activeInputMode: 'text',
      search: '',
      addContainerOpen: false,
      containerNotice: '',
      addContainerPending: false,
      containerPending: {},
      containerErrors: {},
    },
    bootstrap: { deviceCount: 0, sessionCount: 0, groupCount: 0, workflowCount: 0, applicationVersion: 'test' },
    runtime: { status: 'disabled', enabled: false, bindHost: '127.0.0.1', port: 0 },
    pairings: { pending: [], paired: [] },
    devices: [],
    sessions: [],
    containers: [],
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
  groupCreateResult: null,
  settingsUpdates: [],
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
        revoke: async () => ({ ok: true, data: {} }),
      },
      devices: { list: async () => ({ ok: true, data: { devices: [] } }) },
      settings: {
        get: async () => ({ ok: true, data: { locale: 'vi', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } } }),
        update: async (payload) => {
          apiState.settingsUpdates.push(payload);
          return { ok: true, data: payload };
        },
      },
      sessions: { list: async () => ({ ok: true, data: { sessions: [] } }) },
      containers: {
        list: async () => ({ ok: true, data: { containers: apiState.containers } }),
        add: async ({ name, image, runtime }) => {
          apiState.containerCalls.add = (apiState.containerCalls.add || 0) + 1;
          if (apiState.containerAddDelay) await Promise.resolve();
          const container = {
            id: `container-${apiState.containers.length + 1}`,
            name,
            image,
            status: 'running',
            deviceId: `managed-device-${apiState.containers.length + 1}`,
            runtime: { dockerName: runtime?.dockerName || `war-${apiState.containers.length + 1}`, privileged: false },
            resourceUsage: { cpuPercent: 1, memoryBytes: 1024 * 1024 },
          };
          apiState.containers = [...apiState.containers, container];
          return { ok: true, data: { container, operation: { ok: true } } };
        },
        start: async ({ containerId }) => containerOperation('start', containerId, 'running'),
        stop: async ({ containerId }) => containerOperation('stop', containerId, 'stopped'),
        restart: async ({ containerId }) => containerOperation('restart', containerId, 'running'),
        refresh: async ({ containerId }) => containerOperation('refresh', containerId, 'running'),
        duplicate: async ({ containerId }) => {
          apiState.containerCalls.duplicate = (apiState.containerCalls.duplicate || 0) + 1;
          if (apiState.containerResults.duplicate) return apiState.containerResults.duplicate;
          const source = apiState.containers.find((container) => container.id === containerId);
          apiState.containers = [...apiState.containers, containerFixture({ id: `container-${apiState.containers.length + 1}`, name: `${source?.name || containerId} copy` })];
          return { ok: true, data: {} };
        },
        delete: async ({ containerId }) => containerOperation('delete', containerId, 'deleted'),
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
        dispatch: async () => ({ ok: true, data: { job: { id: 'job-offline' }, transport: { delivered: false, warningCode: 'SESSION_OFFLINE' } } }),
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

async function prepareGroupedForm(root, { text, mode }) {
  const selects = all(root, (node) => node.localName === 'select');
  selects[1].value = 'wf-a:1';
  selects[2].options[0].selected = true;
  selects[3].value = mode;
  const groupedText = all(root, (node) => node.localName === 'textarea')[1];
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
  globalThis.document = {
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (value) => new FakeText(value),
  };
}
