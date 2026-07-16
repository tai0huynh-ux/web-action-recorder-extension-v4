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
