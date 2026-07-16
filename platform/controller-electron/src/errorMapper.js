export function mapError(error) {
  const code = typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR';
  const message = code === 'INTERNAL_ERROR' ? 'Internal application error' : String(error.message || 'Request rejected');
  return Object.freeze({ ok: false, error: Object.freeze({ code, message }) });
}
