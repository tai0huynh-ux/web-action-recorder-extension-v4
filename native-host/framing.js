export const DEFAULT_MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export class NativeMessageFramer {
  constructor({ maxBytes = DEFAULT_MAX_NATIVE_MESSAGE_BYTES, onMessage = () => {}, onError = () => {} } = {}) {
    this.maxBytes = maxBytes;
    this.onMessage = onMessage;
    this.onError = onError;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length === 0) {
        this.buffer = this.buffer.subarray(4);
        this.onError(new Error('Native message length must be greater than zero.'));
        continue;
      }
      if (length > this.maxBytes) {
        this.buffer = Buffer.alloc(0);
        this.onError(new Error(`Native message exceeds ${this.maxBytes} bytes.`));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        this.onMessage(JSON.parse(payload.toString('utf8')));
      } catch (error) {
        this.onError(new Error(`Invalid native message JSON: ${error.message}`));
      }
    }
  }

  end() {
    if (this.buffer.length > 0) {
      this.onError(new Error('Native message stream ended with a partial frame.'));
      this.buffer = Buffer.alloc(0);
    }
  }
}

export function encodeNativeMessage(value, { maxBytes = DEFAULT_MAX_NATIVE_MESSAGE_BYTES } = {}) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  if (payload.length === 0) throw new Error('Native message payload is empty.');
  if (payload.length > maxBytes) throw new Error(`Native message exceeds ${maxBytes} bytes.`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export async function collectNativeMessages(readable, options = {}) {
  const messages = [];
  const errors = [];
  const framer = new NativeMessageFramer({
    ...options,
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error)
  });
  for await (const chunk of readable) framer.push(chunk);
  framer.end();
  return { messages, errors };
}
