export function buildDatasetAssignments({ devices, inputs = {}, dataset = [], assignmentMode = 'same', allowDuplicate = true, seed = 'war', random = undefined }) {
  const records = normalizeRecords(dataset, inputs);
  if (assignmentMode === 'random_pool' && !allowDuplicate && records.length < devices.length) {
    throw new Error('Not enough dataset records for non-duplicate assignment');
  }
  const shuffled = random ? randomShuffle(records, random) : seededShuffle(records, seed);
  return devices.map((device, index) => ({
    deviceId: device.id,
    inputs: pickRecord({ records, shuffled, device, index, assignmentMode, allowDuplicate })
  }));
}

function normalizeRecords(dataset, inputs) {
  if (Array.isArray(dataset) && dataset.length) return dataset.map((record) => ({ ...record }));
  if (inputs && typeof inputs === 'object') return [{ ...inputs }];
  return [{}];
}

function pickRecord({ records, shuffled, device, index, assignmentMode, allowDuplicate }) {
  if (assignmentMode === 'per_device') return clone(records.find((record) => record.deviceId === device.id || record.deviceName === device.name) || {});
  if (assignmentMode === 'mapping') return clone(records.find((record) => record.deviceKey === device.id || record.deviceKey === device.name) || {});
  if (assignmentMode === 'random_pool') return clone(allowDuplicate ? shuffled[index % shuffled.length] : shuffled[index]);
  return clone(records[0] || {});
}

function randomShuffle(records, random) {
  const next = records.map(clone);
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function seededShuffle(records, seed) {
  const next = records.map(clone);
  let state = hashSeed(seed);
  for (let i = next.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function hashSeed(seed) {
  return [...String(seed)].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 2166136261);
}

function clone(value) {
  return structuredClone(value || {});
}
