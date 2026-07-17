export function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  const hasExplicitChildren = arguments.length >= 3;
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'for') node.htmlFor = String(value);
    else if (key === 'value') node.value = String(value);
    else if (key === 'type') node.type = String(value);
    else if (key === 'name') node.name = String(value);
    else if (key === 'id') node.id = String(value);
    else if (key === 'role') node.setAttribute('role', String(value));
    else if (key === 'ariaLabel') node.setAttribute('aria-label', String(value));
    else if (key === 'ariaCurrent') node.setAttribute('aria-current', String(value));
    else if (key === 'ariaSelected') node.setAttribute('aria-selected', String(value));
    else if (key === 'ariaExpanded') node.setAttribute('aria-expanded', String(value));
    else if (key === 'ariaOrientation') node.setAttribute('aria-orientation', String(value));
    else if (key === 'ariaValueMin') node.setAttribute('aria-valuemin', String(value));
    else if (key === 'ariaValueMax') node.setAttribute('aria-valuemax', String(value));
    else if (key === 'ariaValueNow') node.setAttribute('aria-valuenow', String(value));
    else if (key === 'title') node.title = String(value);
    else if (key === 'tabIndex') node.tabIndex = Number(value);
    else if (key === 'colSpan') node.colSpan = Number(value);
    else if (key === 'disabled') node.disabled = Boolean(value);
    else if (key === 'min') node.min = String(value);
    else if (key === 'max') node.max = String(value);
    else if (key === 'step') node.step = String(value);
    else if (key === 'placeholder') node.placeholder = String(value);
    else if (key === 'rows') node.rows = Number(value);
  }
  // Explicit children own the rendered contents; otherwise text-only nodes keep their label.
  if (hasExplicitChildren) {
    node.replaceChildren(...asNodes(children));
  }
  return node;
}

export function text(value) {
  return document.createTextNode(value === undefined || value === null ? '' : String(value));
}

export function setStatus(node, result, fallback = 'Done') {
  node.textContent = result?.ok === false ? `${result.code || 'ERROR'}: ${result.message || 'Request failed'}` : fallback;
}

export function section(title, children = []) {
  return el('section', { className: 'view-panel', ariaLabel: title }, [
    el('h2', { text: title }),
    ...children,
  ]);
}

export function field(label, control) {
  const id = control.id || `field-${Math.random().toString(36).slice(2)}`;
  control.id = id;
  return el('label', { className: 'field', for: id }, [
    el('span', { text: label }),
    control,
  ]);
}

export function button(label, action, options = {}) {
  const item = el('button', { type: 'button', className: options.className || 'button', text: label, disabled: options.disabled });
  item.addEventListener('click', action);
  return item;
}

export function table(columns, rows) {
  const head = el('thead', {}, [el('tr', {}, columns.map((column) => el('th', { text: column.label })))]);
  const body = el('tbody', {}, rows.length
    ? rows.map((row) => el('tr', {}, columns.map((column) => el('td', {}, [text(formatCell(row[column.key]))]))))
    : [el('tr', {}, [el('td', { text: 'No records', className: 'empty' })])]);
  return el('table', { className: 'data-table' }, [head, body]);
}

export function codeBlock(value) {
  const pre = el('pre', { className: 'code-block' });
  pre.textContent = stableJson(value);
  return pre;
}

export function stableJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseJsonInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed);
}

function asNodes(children) {
  return children.flat()
    .filter((child) => child !== undefined && child !== null)
    .map((child) => child instanceof Node ? child : text(child));
}

function formatCell(value) {
  if (Array.isArray(value)) return value.join(', ');
  if (value && typeof value === 'object') return Object.entries(value).filter(([, v]) => Boolean(v)).map(([k]) => k).join(', ');
  return value ?? '';
}
