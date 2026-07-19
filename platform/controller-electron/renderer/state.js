import { t } from './i18n.js';
import { clampWorkspaceLayout, createWorkspaceSelection } from './workspaceState.js';

const api = window.warController;

export const views = Object.freeze(['workspace', 'overview', 'pairing', 'devices', 'groups', 'workflows', 'jobs', 'diagnostics']);

export const store = {
  view: 'workspace',
  settings: { locale: 'vi', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } },
  workspace: {
    selection: createWorkspaceSelection(),
    activeInputMode: 'text',
    search: '',
    addContainerOpen: false,
    containerNamePrefix: '',
    containerNameSequence: null,
    containerNotice: '',
    addContainerPending: false,
    containerPending: {},
    containerErrors: {},
    containerNetworkOpenId: '',
  },
  bootstrap: null,
  runtime: null,
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
};

export function unwrap(result) {
  if (result?.ok === true) return result.data?.data ?? result.data;
  return result;
}

export async function refreshAll() {
  const [bootstrap, runtime, settings, pairings, devices, sessions, containers, groups, workflows, jobs] = await Promise.all([
    api.system.getBootstrapState(),
    api.system.getRuntimeStatus(),
    api.settings.get(),
    api.pairings.list({ limit: 200 }),
    api.devices.list({ limit: 200 }),
    api.sessions.list({ limit: 200 }),
    api.containers.list({ limit: 200 }),
    api.groups.list({ limit: 200 }),
    api.workflows.list({ limit: 200 }),
    api.jobs.list({ limit: 200 }),
  ]);
  store.bootstrap = unwrap(bootstrap);
  store.runtime = unwrap(runtime);
  store.settings = unwrap(settings) || store.settings;
  store.settings.workspace = clampWorkspaceLayout(store.settings.workspace);
  store.pairings = unwrap(pairings) || { pending: [], paired: [] };
  store.devices = unwrap(devices)?.devices || [];
  store.sessions = unwrap(sessions)?.sessions || [];
  store.containers = unwrap(containers)?.containers || [];
  store.groups = unwrap(groups)?.groups || [];
  store.workflows = unwrap(workflows)?.workflows || [];
  store.jobs = unwrap(jobs)?.jobs || [];
  store.lastRefresh = new Date().toISOString();
}

export async function refreshWorkflow(workflowId, revision) {
  const result = unwrap(await api.workflows.get({ workflowId, revision }));
  store.selectedWorkflow = result;
  return result;
}

export async function refreshJob(jobId) {
  const [job, events] = await Promise.all([
    api.jobs.get({ jobId }),
    api.jobs.events({ jobId, limit: 200 }),
  ]);
  store.selectedJob = unwrap(job);
  store.jobEvents = unwrap(events)?.events || [];
}

export function navLabel(id) {
  return t(`navigation.${id}`);
}
