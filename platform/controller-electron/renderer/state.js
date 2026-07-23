import { t } from './i18n.js';
import { clampWorkspaceLayout, createWorkspaceSelection, WORKSPACE_SAMPLE_NODES } from './workspaceState.js';

const api = window.warController;

export const views = Object.freeze(['workspace', 'remote', 'overview', 'pairing', 'devices', 'groups', 'workflows', 'jobs', 'diagnostics', 'trash']);

export const store = {
  view: 'workspace',
  settings: { locale: 'vi', theme: 'light', workspace: { leftWidth: 280, centerWidth: 420, graphCollapsed: false } },
  workspace: {
    selection: createWorkspaceSelection(),
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
    containerScanPending: false,
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
    graphDraftNodes: WORKSPACE_SAMPLE_NODES.map((node) => ({ ...node })),
    graphHistory: [],
    graphFuture: [],
  },
  bootstrap: null,
  runtime: null,
  pairings: { pending: [], paired: [] },
  devices: [],
  sessions: [],
  containers: [],
  remote: {
    selectedDeviceIds: [],
    selectionInitialized: false,
    activeDeviceId: '',
    synchronized: false,
    fps: 3,
    live: true,
    layout: 'auto',
    frames: {},
    pending: {},
    notice: '',
    error: '',
  },
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
};

export function unwrap(result) {
  if (result?.ok === true) return result.data?.data ?? result.data;
  return result;
}

export async function refreshAll() {
  const [bootstrap, runtime, settings, pairings, devices, sessions, containers, trash, groups, workflows, jobs] = await Promise.all([
    api.system.getBootstrapState(),
    api.system.getRuntimeStatus(),
    api.settings.get(),
    api.pairings.list({ limit: 200 }),
    api.devices.list({ limit: 200 }),
    api.sessions.list({ limit: 200 }),
    api.containers.list({ limit: 200 }),
    api.containers.trash(),
    api.groups.list({ limit: 200 }),
    api.workflows.list({ limit: 200 }),
    api.jobs.list({ limit: 200 }),
  ]);
  store.bootstrap = unwrap(bootstrap);
  store.runtime = unwrap(runtime);
  store.settings = unwrap(settings) || store.settings;
  store.settings.workspace = clampWorkspaceLayout(store.settings.workspace);
  store.workspace.containerHosts = mergeConfiguredContainerHosts(store.workspace.containerHosts, store.settings.containerHosts);
  store.pairings = unwrap(pairings) || { pending: [], paired: [] };
  store.devices = unwrap(devices)?.devices || [];
  store.sessions = unwrap(sessions)?.sessions || [];
  store.containers = unwrap(containers)?.containers || [];
  store.workspace.trashHosts = unwrap(trash)?.hosts || [];
  store.groups = unwrap(groups)?.groups || [];
  store.workflows = unwrap(workflows)?.workflows || [];
  store.jobs = unwrap(jobs)?.jobs || [];
  store.lastRefresh = new Date().toISOString();
}

export function mergeConfiguredContainerHosts(runtimeHosts = [], configuredHosts = []) {
  const runtime = Array.isArray(runtimeHosts) ? runtimeHosts : [];
  const configured = Array.isArray(configuredHosts) ? configuredHosts : [];
  const runtimeById = new Map(runtime.filter((host) => host?.id).map((host) => [host.id, host]));
  const merged = configured.filter((host) => host?.id).map((host) => ({
    ...host,
    label: host.name,
    runtime: 'ssh-docker',
    connected: false,
    ...(runtimeById.get(host.id) || {}),
  }));
  const configuredIds = new Set(merged.map((host) => host.id));
  return [...merged, ...runtime.filter((host) => host?.id && !configuredIds.has(host.id))];
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
