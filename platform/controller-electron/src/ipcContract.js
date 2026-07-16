export const CHANNELS = Object.freeze({ bootstrap: 'war:system:bootstrap', runtime: 'war:system:runtime' });
export function assertKnownChannel(channel) {
  if (!Object.values(CHANNELS).includes(channel)) throw new Error('Unknown IPC channel');
  return channel;
}
