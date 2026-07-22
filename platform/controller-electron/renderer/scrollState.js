const SCROLL_KEY_ATTRIBUTE = 'data-scroll-key';

export function captureScrollState(documentRef = document, container = documentRef) {
  return {
    document: readPosition(documentScrollRoot(documentRef)),
    keyed: keyedScrollElements(container).map((element) => ({
      key: element.getAttribute(SCROLL_KEY_ATTRIBUTE),
      ...readPosition(element),
    })),
  };
}

export function restoreScrollState(snapshot, documentRef = document, container = documentRef) {
  if (!snapshot) return;
  restorePosition(documentScrollRoot(documentRef), snapshot.document);

  const positions = new Map((snapshot.keyed || []).map((item) => [item.key, item]));
  for (const element of keyedScrollElements(container)) {
    restorePosition(element, positions.get(element.getAttribute(SCROLL_KEY_ATTRIBUTE)));
  }
}

function documentScrollRoot(documentRef) {
  return documentRef?.scrollingElement || documentRef?.documentElement || documentRef?.body || null;
}

function keyedScrollElements(container) {
  if (!container?.querySelectorAll) return [];
  return [...container.querySelectorAll(`[${SCROLL_KEY_ATTRIBUTE}]`)]
    .filter((element) => element.getAttribute(SCROLL_KEY_ATTRIBUTE));
}

function readPosition(element) {
  return {
    top: Number(element?.scrollTop) || 0,
    left: Number(element?.scrollLeft) || 0,
  };
}

function restorePosition(element, position) {
  if (!element || !position) return;
  const top = Number(position.top) || 0;
  const left = Number(position.left) || 0;
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, left, behavior: 'auto' });
    return;
  }
  element.scrollTop = top;
  element.scrollLeft = left;
}
