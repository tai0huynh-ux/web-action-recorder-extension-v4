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
    this.value = '';
    this.type = '';
    this.name = '';
    this.id = '';
    this.rows = 0;
    this.placeholder = '';
    this._text = '';
    this.style = { setProperty() {} };
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

function resetStore() {
  apiState.groups = [];
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
    },
    bootstrap: { deviceCount: 0, sessionCount: 0, groupCount: 0, workflowCount: 0, applicationVersion: 'test' },
    runtime: { status: 'disabled', enabled: false, bindHost: '127.0.0.1', port: 0 },
    pairings: { pending: [], paired: [] },
    devices: [],
    sessions: [],
    groups: [],
    workflows: [],
    jobs: [],
    selectedWorkflow: null,
    selectedJob: null,
    jobEvents: [],
    lastRefresh: null,
  });
}

async function clickButton(root, label) {
  const button = all(root, (node) => node.localName === 'button' && node.textContent === label)[0];
  assert.ok(button, `Missing button ${label}`);
  await button.click();
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
        list: async () => ({ ok: true, data: { workflows: [] } }),
        importFile: async () => ({ ok: true, data: {} }),
        get: async () => ({ ok: true, data: {} }),
      },
      jobs: {
        list: async () => ({ ok: true, data: { jobs: [] } }),
        dispatch: async () => ({ ok: true, data: { transport: { delivered: false, warningCode: 'not delivered' } } }),
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

function installFakeDom() {
  globalThis.Node = FakeNode;
  globalThis.document = {
    documentElement: new FakeElement('html'),
    createElement: (tag) => new FakeElement(tag),
    createTextNode: (value) => new FakeText(value),
  };
}
