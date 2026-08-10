export const INTERACTIVE_MODE_DENIED = 'interactive_mode_denied';

const HEALTH_COMMANDS = new Set(['health', 'bridge.health', 'status.health']);

function commandNames(command) {
  if (typeof command === 'string') return [command.trim().toLowerCase()];
  if (!command || typeof command !== 'object') return [];
  return ['type', 'name', 'command', 'action']
    .map((key) => command[key])
    .filter((value) => value !== undefined && value !== null && String(value).trim())
    .map((value) => String(value).trim().toLowerCase());
}

export function isHealthCommand(command) {
  const names = commandNames(command);
  return names.length > 0 && names.every((name) => HEALTH_COMMANDS.has(name));
}

export function evaluateInteractiveCommand(command) {
  if (isHealthCommand(command)) return { allowed: true, kind: 'health' };
  return { allowed: false, code: INTERACTIVE_MODE_DENIED, kind: 'effectful' };
}

export function isInteractiveCommandAllowed(command) {
  return evaluateInteractiveCommand(command).allowed;
}

export function assertInteractiveCommandAllowed(command) {
  const decision = evaluateInteractiveCommand(command);
  if (!decision.allowed) {
    const error = new Error(INTERACTIVE_MODE_DENIED);
    error.code = INTERACTIVE_MODE_DENIED;
    throw error;
  }
  return decision;
}
