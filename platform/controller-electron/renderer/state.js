const api = window.warController;

export const views = Object.freeze(['overview', 'pairing', 'devices', 'groups', 'workflows', 'jobs', 'diagnostics']);

export const store = {
  view: 'overview',
  bootstrap: null,
  runtime: null,
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
};

export function unwrap(result) {
  if (result?.ok === true) return result.data?.data ?? result.data;
  return result;
}

export async function refreshAll() {
  const [bootstrap, runtime, pairings, devices, sessions, groups, workflows, jobs] = await Promise.all([
    api.system.getBootstrapState(),
    api.system.getRuntimeStatus(),
    api.pairings.list({ limit: 200 }),
    api.devices.list({ limit: 200 }),
    api.sessions.list({ limit: 200 }),
    api.groups.list({ limit: 200 }),
    api.workflows.list({ limit: 200 }),
    api.jobs.list({ limit: 200 }),
  ]);
  store.bootstrap = unwrap(bootstrap);
  store.runtime = unwrap(runtime);
  store.pairings = unwrap(pairings) || { pending: [], paired: [] };
  store.devices = unwrap(devices)?.devices || [];
  store.sessions = unwrap(sessions)?.sessions || [];
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
  return id.slice(0, 1).toUpperCase() + id.slice(1);
}
