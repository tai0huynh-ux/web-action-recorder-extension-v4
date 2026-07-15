export class InputParserError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InputParserError';
    this.code = code;
    this.details = details;
  }
}

export function parseInputText(text) {
  const source = String(text ?? '');
  const rows = [];
  let fields = [''];
  let fieldIndex = 0;
  let inQuotes = false;
  let quotedField = false;
  let rowStartOffset = 0;
  let rowStartLine = 1;
  let line = 1;
  let column = 1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        fields[fieldIndex] += '"';
        index += 1;
        column += 2;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        column += 1;
        continue;
      }
      fields[fieldIndex] += char;
      if (char === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      continue;
    }

    if (char === '"') {
      if (fields[fieldIndex].length > 0) {
        fields[fieldIndex] += char;
      } else {
        inQuotes = true;
        quotedField = true;
      }
      column += 1;
      continue;
    }

    if (char === '|') {
      fields.push('');
      fieldIndex += 1;
      quotedField = false;
      column += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      rows.push(makeRow(fields, rows.length, rowStartOffset, rowStartLine));
      if (char === '\r' && next === '\n') index += 1;
      fields = [''];
      fieldIndex = 0;
      quotedField = false;
      rowStartOffset = index + 1;
      line += 1;
      column = 1;
      rowStartLine = line;
      continue;
    }

    fields[fieldIndex] += char;
    quotedField = quotedField && fields[fieldIndex].length === 0;
    column += 1;
  }

  if (inQuotes) {
    throw new InputParserError('UNCLOSED_QUOTE', 'Quoted field is missing a closing quote.', { line, column });
  }

  rows.push(makeRow(fields, rows.length, rowStartOffset, rowStartLine));
  return { rows };
}

export function mapRowsToDevices({ rows, devices, expectedFieldCount, broadcastSingleRow = true }) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const normalizedDevices = Array.isArray(devices) ? devices : [];

  if (normalizedDevices.length === 0) {
    throw new InputParserError('NO_DEVICES', 'At least one selected device is required.');
  }
  if (normalizedRows.length === 0) {
    throw new InputParserError('MISSING_ROW', 'No input rows were provided.', { expectedRows: normalizedDevices.length, actualRows: 0 });
  }

  const shouldBroadcast = broadcastSingleRow && normalizedRows.length === 1 && normalizedDevices.length > 1;
  if (!shouldBroadcast && normalizedRows.length < normalizedDevices.length) {
    throw new InputParserError('MISSING_ROW', 'Not enough input rows for the selected devices.', {
      expectedRows: normalizedDevices.length,
      actualRows: normalizedRows.length
    });
  }
  if (!shouldBroadcast && normalizedRows.length > normalizedDevices.length) {
    throw new InputParserError('EXTRA_ROW', 'Too many input rows for the selected devices.', {
      expectedRows: normalizedDevices.length,
      actualRows: normalizedRows.length
    });
  }

  const sourceRows = shouldBroadcast ? normalizedDevices.map(() => normalizedRows[0]) : normalizedRows;
  return sourceRows.map((row, deviceIndex) => {
    const fields = row.fields ?? row;
    if (!Array.isArray(fields)) {
      throw new InputParserError('MISSING_FIELD', 'Input row does not contain fields.', { sourceRowIndex: row.sourceRowIndex });
    }
    if (Number.isInteger(expectedFieldCount) && fields.length < expectedFieldCount) {
      throw new InputParserError('MISSING_FIELD', 'Input row has fewer fields than expected.', {
        expectedFieldCount,
        actualFieldCount: fields.length,
        sourceRowIndex: row.sourceRowIndex ?? deviceIndex
      });
    }
    if (Number.isInteger(expectedFieldCount) && fields.length > expectedFieldCount) {
      throw new InputParserError('EXTRA_FIELD', 'Input row has more fields than expected.', {
        expectedFieldCount,
        actualFieldCount: fields.length,
        sourceRowIndex: row.sourceRowIndex ?? deviceIndex
      });
    }
    return {
      deviceId: normalizedDevices[deviceIndex].id ?? normalizedDevices[deviceIndex].deviceId ?? String(normalizedDevices[deviceIndex]),
      deviceIndex,
      fields: [...fields],
      sourceRowIndex: row.sourceRowIndex ?? (shouldBroadcast ? 0 : deviceIndex)
    };
  });
}

export function createDispatchPayload(mapping) {
  return mapping.map((item) => ({
    deviceId: item.deviceId,
    inputs: [...item.fields],
    sourceRowIndex: item.sourceRowIndex
  }));
}

export function mapFieldsToNamedInputs(fields, definitions) {
  const normalizedFields = Array.isArray(fields) ? fields : [];
  const normalizedDefinitions = Array.isArray(definitions) ? definitions : [];
  validateInputDefinitions(normalizedDefinitions);

  const maxIndex = normalizedDefinitions.reduce((max, definition) => Math.max(max, definition.index), -1);
  if (normalizedFields.length > maxIndex + 1) {
    throw new InputParserError('EXTRA_FIELD', 'Input row has more fields than definitions.', {
      expectedFieldCount: maxIndex + 1,
      actualFieldCount: normalizedFields.length
    });
  }

  const namedInputs = {};
  for (const definition of normalizedDefinitions) {
    const hasField = definition.index < normalizedFields.length;
    const value = hasField ? normalizedFields[definition.index] : undefined;
    if ((!hasField || value === undefined) && definition.required) {
      throw new InputParserError('MISSING_FIELD', 'Required input field is missing.', {
        name: definition.name,
        index: definition.index,
        sensitive: Boolean(definition.sensitive)
      });
    }
    if (hasField) namedInputs[definition.name] = value;
    else if (!definition.sensitive && Object.prototype.hasOwnProperty.call(definition, 'defaultValue')) {
      namedInputs[definition.name] = definition.defaultValue;
    }
  }
  return namedInputs;
}

export function validateInputDefinitions(definitions) {
  const names = new Set();
  const indexes = new Set();
  for (const [position, definition] of definitions.entries()) {
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
      throw new InputParserError('INVALID_INPUT_DEFINITION', 'Input definition must be an object.', { position });
    }
    if (typeof definition.name !== 'string' || !definition.name.trim()) {
      throw new InputParserError('INVALID_INPUT_DEFINITION', 'Input definition requires a name.', { position });
    }
    if (definition.name.length > 128) {
      throw new InputParserError('INVALID_INPUT_DEFINITION', 'Input definition name is too long.', { position });
    }
    if (names.has(definition.name)) {
      throw new InputParserError('DUPLICATE_INPUT_NAME', 'Input definition name is duplicated.', { name: definition.name });
    }
    if (!Number.isInteger(definition.index) || definition.index < 0) {
      throw new InputParserError('INVALID_INPUT_INDEX', 'Input definition index must be a non-negative integer.', {
        name: definition.name
      });
    }
    if (indexes.has(definition.index)) {
      throw new InputParserError('DUPLICATE_INPUT_INDEX', 'Input definition index is duplicated.', { index: definition.index });
    }
    if (definition.sensitive && Object.prototype.hasOwnProperty.call(definition, 'defaultValue')) {
      throw new InputParserError('SENSITIVE_DEFAULT_VALUE', 'Sensitive input cannot define a plaintext defaultValue.', {
        name: definition.name,
        index: definition.index
      });
    }
    names.add(definition.name);
    indexes.add(definition.index);
  }
}

function makeRow(fields, sourceRowIndex, startOffset, startLine) {
  return {
    fields: [...fields],
    sourceRowIndex,
    startOffset,
    startLine
  };
}
