import test from 'node:test';
import assert from 'node:assert/strict';
import { captureScrollState, restoreScrollState } from '../renderer/scrollState.js';

test('document and keyed Workspace panel scroll positions survive replacement', () => {
  const documentRoot = scrollElement(180, 12);
  const previousPanels = [
    keyedElement('workspace-machines', 320, 4),
    keyedElement('workspace-input', 540, 8),
    keyedElement('workspace-graph', 90, 16),
  ];
  const snapshot = captureScrollState(fakeDocument(documentRoot), container(previousPanels));

  const replacementPanels = [
    keyedElement('workspace-machines'),
    keyedElement('workspace-input'),
    keyedElement('workspace-graph'),
  ];
  restoreScrollState(snapshot, fakeDocument(documentRoot), container(replacementPanels));

  assert.deepEqual(position(documentRoot), { top: 180, left: 12 });
  assert.deepEqual(replacementPanels.map(position), [
    { top: 320, left: 4 },
    { top: 540, left: 8 },
    { top: 90, left: 16 },
  ]);
});

test('scroll restoration ignores missing, new, and unkeyed nodes safely', () => {
  const snapshot = captureScrollState(fakeDocument(scrollElement(70, 2)), container([
    keyedElement('workspace-machines', 240, 6),
    scrollElement(999, 999),
  ]));
  const newPanel = keyedElement('workspace-new', 30, 3);
  const machines = keyedElement('workspace-machines');

  assert.doesNotThrow(() => restoreScrollState(snapshot, fakeDocument(null), container([newPanel, machines])));
  assert.deepEqual(position(newPanel), { top: 30, left: 3 });
  assert.deepEqual(position(machines), { top: 240, left: 6 });
  assert.doesNotThrow(() => restoreScrollState(null, fakeDocument(null), container([])));
});

function fakeDocument(scrollingElement) {
  return { scrollingElement, documentElement: null, body: null };
}

function container(elements) {
  return { querySelectorAll: () => elements.filter((element) => element.getAttribute('data-scroll-key')) };
}

function keyedElement(key, top = 0, left = 0) {
  const element = scrollElement(top, left);
  element.getAttribute = (name) => name === 'data-scroll-key' ? key : '';
  return element;
}

function scrollElement(top = 0, left = 0) {
  return {
    scrollTop: top,
    scrollLeft: left,
    getAttribute: () => '',
    scrollTo(position) {
      this.scrollTop = position.top;
      this.scrollLeft = position.left;
    },
  };
}

function position(element) {
  return { top: element.scrollTop, left: element.scrollLeft };
}
