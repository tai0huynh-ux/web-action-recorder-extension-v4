export function validateSchemaValue(schema, value, path = '$') {
  const errors = [];
  validate(schema, value, path, errors);
  return { ok: errors.length === 0, errors };
}

function validate(schema, value, path, errors) {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type && !matchesType(schema.type, value)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(`${path} must be at least ${schema.minLength} characters`);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(`${path} must be >= ${schema.minimum}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(`${path} must match ${schema.pattern}`);
  }
  if (schema.type === 'object' && schema.required) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key} is required`);
    }
  }
  if (schema.type === 'object' && schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (schema.type === 'object' && schema.properties) {
    for (const [key, childSchema] of Object.entries(schema.properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) validate(childSchema, value[key], `${path}.${key}`, errors);
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => validate(schema.items, item, `${path}[${index}]`, errors));
  }
}

function matchesType(type, value) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}
