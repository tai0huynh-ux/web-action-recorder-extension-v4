import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('controller job_started is emitted at the tab execution boundary before terminal result can race', () => {
  const source = fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');
  const dispatchStart = source.indexOf('async function handleNativeExecutionDispatch');
  const cancelStart = source.indexOf('async function handleNativeExecutionCancel');
  const dispatchSource = source.slice(dispatchStart, cancelStart);
  const startProfileIndex = dispatchSource.indexOf('const started = await runProfilePayloadOnActiveTab');
  const failedResultIndex = dispatchSource.indexOf("if (!started?.ok) return sendNativeExecutionResult");
  const onStartedIndex = dispatchSource.indexOf('onStarted: () => sendNativeExecutionEvent');
  const runProfileStart = source.indexOf('async function runProfilePayloadOnActiveTab');
  const runProfileEnd = source.indexOf('async function stopProfile');
  const runProfileSource = source.slice(runProfileStart, runProfileEnd);
  const awaitOnStartedIndex = runProfileSource.indexOf('await options.onStarted?.()');
  const sendToTabIndex = runProfileSource.indexOf('const delivered = await sendRunProfileToTab');

  assert(startProfileIndex >= 0);
  assert(failedResultIndex > startProfileIndex);
  assert(onStartedIndex > startProfileIndex);
  assert(awaitOnStartedIndex >= 0);
  assert(sendToTabIndex > awaitOnStartedIndex);
});

test('controller terminal results are persisted before send and marked reported only after durable Agent acceptance', () => {
  const source = fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');
  const durableStart = source.indexOf('async function sendDurableNativeTerminal');
  const durableEnd = source.indexOf('async function flushControllerTerminalOutbox');
  const durableSource = source.slice(durableStart, durableEnd);
  const persistIndex = durableSource.indexOf('await putControllerTerminalOutbox(entry)');
  const requestIndex = durableSource.indexOf('await bridgeClient.request(type, payload, options)');
  const acceptedIndex = durableSource.indexOf("response?.payload?.durableAccepted !== true");
  const removeIndex = durableSource.indexOf('await removeControllerTerminalOutbox');
  const reportedIndex = durableSource.indexOf('markControllerJobReported(options.jobId)');

  assert(persistIndex >= 0);
  assert(requestIndex > persistIndex);
  assert(acceptedIndex > requestIndex);
  assert(removeIndex > acceptedIndex);
  assert(reportedIndex > removeIndex);
});

test('controller terminal storage mutations are serialized and size bounded', () => {
  const source = fs.readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8');
  assert(source.includes('controllerTerminalOutboxMutation.then(async () =>'));
  assert(source.includes("throw new Error('Terminal result is too large to persist.')"));
  assert(source.includes("throw new Error('Terminal outbox storage limit exceeded.')"));
});
