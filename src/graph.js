import { STEP_TYPES } from './shared.js';

export function collectOutgoingIds(step) {
  const outgoing = [];
  if (step?.next) outgoing.push(step.next);
  if (Array.isArray(step?.ifSteps)) outgoing.push(...step.ifSteps);
  if (Array.isArray(step?.elseSteps)) outgoing.push(...step.elseSteps);
  if (Array.isArray(step?.conditions)) {
    for (const condition of step.conditions) if (condition?.next) outgoing.push(condition.next);
  }
  return outgoing.filter(Boolean);
}

export function findRootStepIds(steps = []) {
  const ids = new Set(steps.map((step) => step.id).filter(Boolean));
  const incoming = new Set();
  for (const step of steps) {
    for (const id of collectOutgoingIds(step)) if (ids.has(id)) incoming.add(id);
  }
  return steps.filter((step) => step.id && !incoming.has(step.id)).map((step) => step.id);
}

export function validateGraph(profile) {
  const steps = Array.isArray(profile?.steps) ? profile.steps : [];
  const errors = [];
  const ids = new Set();
  for (const [index, step] of steps.entries()) {
    if (!step?.id) errors.push(`Step ${index + 1} is missing id`);
    if (step?.id && ids.has(step.id)) errors.push(`Duplicate step id: ${step.id}`);
    if (step?.id) ids.add(step.id);
    if (!STEP_TYPES.has(step?.type || 'click')) errors.push(`Unsupported step type: ${step?.type}`);
  }
  for (const step of steps) {
    for (const to of collectOutgoingIds(step)) {
      if (!ids.has(to)) errors.push(`Dangling link: ${step.id} -> ${to}`);
    }
  }
  const roots = findRootStepIds(steps);
  if (steps.length && !roots.length) errors.push('Graph has no root step');
  const cycle = findCycle(steps);
  if (cycle) errors.push(`Cycle detected: ${cycle.join(' -> ')}`);
  return { ok: errors.length === 0, errors, roots };
}

function findCycle(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];

  function visit(id) {
    if (visiting.has(id)) return stack.slice(stack.indexOf(id)).concat(id);
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    for (const next of collectOutgoingIds(byId.get(id))) {
      if (byId.has(next)) {
        const cycle = visit(next);
        if (cycle) return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const step of steps) {
    const cycle = visit(step.id);
    if (cycle) return cycle;
  }
  return null;
}

export function applyLinksToSteps(steps = [], links = []) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const next = steps.map((step) => {
    const copy = { ...step, next: null, ifSteps: [], elseSteps: [] };
    if (Array.isArray(copy.conditions)) copy.conditions = copy.conditions.map((condition) => ({ ...condition, next: null }));
    return copy;
  });
  const nextById = new Map(next.map((step) => [step.id, step]));

  for (const link of links) {
    if (!byId.has(link.from) || !byId.has(link.to)) continue;
    const from = nextById.get(link.from);
    if (link.fromPort === 'out') from.next = link.to;
    else if (link.fromPort === 'if-out') from.ifSteps.push(link.to);
    else if (link.fromPort === 'else-out') from.elseSteps.push(link.to);
    else if (String(link.fromPort).startsWith('cond-')) {
      const index = Number(String(link.fromPort).split('-')[1]);
      if (Array.isArray(from.conditions) && from.conditions[index]) from.conditions[index].next = link.to;
    }
  }
  return next;
}
