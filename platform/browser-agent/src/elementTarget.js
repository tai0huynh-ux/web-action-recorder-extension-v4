import { AgentError } from './errors.js';
import { requireObject, requireString } from './inputSafety.js';

const SELECTOR_TYPES = new Set(['css', 'text', 'role', 'label', 'placeholder', 'testId', 'xpath']);
const MAX_SELECTOR_LENGTH = 1024;

export function validateTarget(target) {
  requireObject(target, 'target');
  const selectorType = requireString(target.selectorType ?? (target.selector ? 'css' : undefined), 'selectorType', { max: 32 });
  if (!SELECTOR_TYPES.has(selectorType)) throw new AgentError('invalid_target', 'target selectorType is not supported');
  if (target.selector && /(^|\W)(function|=>|document\.|window\.|eval\(|javascript:)/i.test(target.selector)) {
    throw new AgentError('invalid_target', 'JavaScript expressions are not accepted as targets');
  }
  const strict = target.strict !== undefined ? Boolean(target.strict) : true;
  if (selectorType === 'role') {
    const role = requireString(target.role, 'target.role', { max: 64 });
    const name = target.name === undefined ? undefined : requireString(target.name, 'target.name', { max: 256 });
    return { selectorType, role, name, exact: Boolean(target.exact), strict };
  }
  const value = requireString(target.value ?? target.selector, 'target.value', { max: MAX_SELECTOR_LENGTH });
  if (selectorType === 'xpath' && !value.startsWith('/') && !value.startsWith('(')) {
    throw new AgentError('invalid_target', 'xpath target must be an XPath expression');
  }
  return { selectorType, value, strict };
}

export function locatorFor(page, rawTarget) {
  const target = validateTarget(rawTarget);
  let locator;
  switch (target.selectorType) {
    case 'css':
      locator = page.locator(target.value);
      break;
    case 'text':
      locator = page.getByText(target.value, { exact: target.strict });
      break;
    case 'role':
      locator = page.getByRole(target.role, target.name === undefined ? { exact: target.exact } : { name: target.name, exact: target.exact });
      break;
    case 'label':
      locator = page.getByLabel(target.value, { exact: target.strict });
      break;
    case 'placeholder':
      locator = page.getByPlaceholder(target.value, { exact: target.strict });
      break;
    case 'testId':
      locator = page.getByTestId(target.value);
      break;
    case 'xpath':
      locator = page.locator(`xpath=${target.value}`);
      break;
    default:
      throw new AgentError('invalid_target', 'target selectorType is not supported');
  }
  return target.strict && locator.first ? locator.first() : locator;
}

export async function summarizeElement(locator) {
  const count = await safe(() => locator.count?.(), 0);
  if (!count) return { exists: false };
  const first = locator.first ? locator.first() : locator;
  const [visible, enabled, checked, editable, boundingBox, tagName, text] = await Promise.all([
    safe(() => first.isVisible(), false),
    safe(() => first.isEnabled(), false),
    safe(() => first.isChecked(), false),
    safe(() => first.isEditable(), false),
    safe(() => first.boundingBox(), null),
    safe(() => first.evaluate((el) => el.tagName.toLowerCase()), undefined),
    safe(() => first.textContent(), '')
  ]);
  return {
    exists: true,
    visible,
    enabled,
    checked,
    editable,
    boundingBox,
    tagName,
    text: String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  };
}

async function safe(fn, fallback) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
