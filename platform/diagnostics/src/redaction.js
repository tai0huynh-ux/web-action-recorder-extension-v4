const REDACTED = '<redacted>';
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const SECRET_NAME_SOURCE = String.raw`authorization|bearer|credential|token|secret|password|passwd|cookie|api[-_.]?key|access[-_.]?key|private.?key|tls.?key|pairing.?code|bootstrap|session`;
const SECRET_KEY_RE = new RegExp(SECRET_NAME_SOURCE, 'i');
const SECRET_ARG_RE = new RegExp(`^(?:--?|/)(?:[^=\\s]*)(?:${SECRET_NAME_SOURCE})(?:[^=\\s]*)$`, 'i');

export function redactDiagnostic(value, options = {}) {
  return redactValue(value, { seen: new WeakSet(), depth: 0, options });
}

export function redactEnvironment(env = {}) {
  return redactDiagnostic(env);
}

export function redactHeaders(headers = {}) {
  return redactDiagnostic(headers);
}

export function redactUrl(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.username) parsed.username = REDACTED;
    if (parsed.password) parsed.password = REDACTED;
    for (const key of [...parsed.searchParams.keys()]) {
      if (isSecretKey(key)) parsed.searchParams.set(key, REDACTED);
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return redactString(raw);
  }
}

export function redactCommandLine(commandLine) {
  const args = Array.isArray(commandLine) ? commandLine.map(String) : splitCommandLine(String(commandLine || ''));
  const redacted = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [name, value, separator = '='] = splitAssignmentArg(arg);
    if (SECRET_ARG_RE.test(name)) {
      redacted.push(value === undefined ? arg : `${name}${separator}${REDACTED}`);
      if (value === undefined && index + 1 < args.length) {
        redacted.push(REDACTED);
        index += 1;
      }
    } else {
      redacted.push(redactString(arg));
    }
  }
  return Array.isArray(commandLine) ? redacted : redacted.join(' ');
}

export function dockerContainerDiagnostic(container = {}) {
  const labels = container.Config?.Labels || {};
  const ports = container.NetworkSettings?.Ports || {};
  return redactDiagnostic({
    id: container.Id ? String(container.Id).slice(0, 12) : undefined,
    name: container.Name,
    image: container.Config?.Image,
    user: container.Config?.User,
    labels: {
      'managed-by': labels['managed-by']
    },
    hostConfig: {
      privileged: container.HostConfig?.Privileged,
      networkMode: container.HostConfig?.NetworkMode,
      binds: Array.isArray(container.HostConfig?.Binds) ? container.HostConfig.Binds.map(redactMount) : []
    },
    ports: Object.fromEntries(Object.entries(ports).map(([port, bindings]) => [
      port,
      Array.isArray(bindings) ? bindings.map((binding) => ({
        hostIp: binding.HostIp,
        hostPort: binding.HostPort
      })) : bindings
    ]))
  });
}

function redactValue(value, context) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return String(value);
  if (context.seen.has(value)) return '[Circular]';
  if (context.depth >= MAX_DEPTH) return '[Truncated]';
  context.seen.add(value);

  if (value instanceof Error) {
    const output = {
      name: value.name,
      message: redactString(value.message)
    };
    if (typeof value.code === 'string') output.code = redactString(value.code);
    if (typeof value.status === 'number') output.status = value.status;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      if (isSecretKey(key)) output[key] = REDACTED;
      else output[key] = redactValue(child, { ...context, depth: context.depth + 1 });
    }
    return output;
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((item) => redactValue(item, { ...context, depth: context.depth + 1 }));
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key)) output[key] = REDACTED;
    else if (/url$/i.test(key)) output[key] = redactUrl(child);
    else if (/command.?line|cmdline|argv|args/i.test(key)) output[key] = redactCommandLine(child);
    else output[key] = redactValue(child, { ...context, depth: context.depth + 1 });
  }
  return output;
}

export function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ''));
}

function redactString(value) {
  const bounded = redactBearerSecrets(redactAuthorizationSecrets(String(value)));
  return redactInlineSecrets(bounded)
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+)/gi, (match) => redactUrl(match));
}

function redactAuthorizationSecrets(value) {
  const source = String(value);
  const pattern = /\b(?:Proxy-)?Authorization\s*[=:]\s*/gi;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    let valueEnd = pattern.lastIndex;
    while (valueEnd < source.length && source[valueEnd] !== '\r' && source[valueEnd] !== '\n') valueEnd += 1;
    result += `${source.slice(cursor, match.index)}${match[0]}${REDACTED}`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  return `${result}${source.slice(cursor)}`;
}

function redactBearerSecrets(value) {
  const source = String(value);
  const pattern = /\bBearer\s+/gi;
  let result = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const valueStart = pattern.lastIndex;
    const valueEnd = inlineSecretValueEnd(source, valueStart);
    result += `${source.slice(cursor, match.index)}${match[0]}${REDACTED}`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  return `${result}${source.slice(cursor)}`;
}

function redactInlineSecrets(value) {
  const source = String(value);
  const pattern = new RegExp(`(?:identity|${SECRET_NAME_SOURCE})[\\w.-]*\\s*[=:]\\s*`, 'gi');
  let result = '';
  let cursor = 0;
  let match;
  while ((match = pattern.exec(source))) {
    const valueStart = pattern.lastIndex;
    const valueEnd = inlineSecretValueEnd(source, valueStart);
    result += `${source.slice(cursor, match.index)}${match[0]}${REDACTED}`;
    cursor = valueEnd;
    pattern.lastIndex = valueEnd;
  }
  return `${result}${source.slice(cursor)}`;
}

function inlineSecretValueEnd(source, start) {
  if (start >= source.length) return start;
  const delimiter = source[start];
  if (delimiter === '"' || delimiter === "'") {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '\r' || source[index] === '\n') return index;
      if (source[index] === delimiter && !isEscapedDelimiter(source, index)) return index + 1;
    }
    return source.length;
  }
  if (delimiter === '<') {
    for (let index = start + 1; index < source.length; index += 1) {
      if (source[index] === '\r' || source[index] === '\n') return index;
      if (source[index] === '>' && !isEscapedDelimiter(source, index)) return index + 1;
    }
    return source.length;
  }
  let index = start;
  while (index < source.length && !/\s/.test(source[index])) index += 1;
  return index;
}

function isEscapedDelimiter(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function splitCommandLine(commandLine) {
  return commandLine.match(/"[^"]*"|'[^']*'|\S+/g)?.map((item) => item.replace(/^["']|["']$/g, '')) || [];
}

function splitAssignmentArg(arg) {
  const equalsIndex = arg.indexOf('=');
  const colonIndex = arg.startsWith('/') ? arg.indexOf(':', 1) : -1;
  const indices = [equalsIndex, colonIndex].filter((index) => index >= 0);
  if (!indices.length) return [arg, undefined, undefined];
  const index = Math.min(...indices);
  return [arg.slice(0, index), arg.slice(index + 1), arg[index]];
}

function redactMount(mount) {
  const [source, target, options] = String(mount).split(':');
  return [source ? '<path>' : source, target || '', options].filter((item) => item !== undefined).join(':');
}
