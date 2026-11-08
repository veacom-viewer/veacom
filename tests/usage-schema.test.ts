import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import schema from '../electron/usage-schema.json';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** The collector's allowlist for traces, by context (telemetry/collector/config.yaml). */
function traceAllowlist(): Record<string, string[]> {
  const traces = read('telemetry/collector/config.yaml').split('metric_statements:')[0];
  const lists: Record<string, string[]> = {};
  for (const match of traces.matchAll(/- context: (\w+)\n\s+statements:\n(?:\s+#[^\n]*\n)*\s+- 'keep_keys\(attributes, (\[[^\]]*\])\)'/g)) lists[match[1]] = JSON.parse(match[2]);
  return lists;
}

describe('usage timings schema', () => {
  it('is allowed through the collector, attribute by attribute', () => {
    const allowed = traceAllowlist();
    assert.ok(allowed.span?.length > 0);
    for (const key of Object.keys(schema.spanAttributes)) assert.ok(allowed.span.includes(key), key);
    for (const key of schema.resourceAttributes) assert.ok(allowed.resource.includes(key), key);
  });
  it('lets only lab runs name a study or scenario', () => {
    const rules = schema.spanAttributes as Record<string, { labOnly?: boolean }>;
    assert.deepEqual(Object.keys(rules).filter(key => rules[key].labOnly).sort(), ['veacom.scenario', 'veacom.study.name']);
  });
  it('allows no free text: every string attribute is an enumeration or a narrow pattern', () => {
    for (const [key, rule] of Object.entries(schema.spanAttributes as Record<string, { type: string; enum?: string[]; listOf?: string[]; pattern?: string }>)) {
      if (rule.type !== 'string') continue;
      assert.ok(rule.enum || rule.listOf || rule.pattern, key);
      if (rule.pattern) assert.equal(new RegExp(rule.pattern).test('DOE^JANE'), false, key);
      if (rule.pattern) assert.equal(new RegExp(rule.pattern).test('C:\\DICOM\\IM0001'), false, key);
    }
  });
});

describe('usage action ids in the interface', () => {
  const sources = ['src/App.tsx', ...fs.readdirSync(path.join(root, 'src/components')).filter(name => name.endsWith('.tsx')).map(name => `src/components/${name}`)];
  const ACTION = /^[a-z0-9][a-z0-9.-]{0,63}$/;
  it('are stable kebab-case names, never built from data', () => {
    const ids = new Set<string>();
    for (const file of sources) {
      const text = read(file);
      for (const match of text.matchAll(/(?:data-action|\baction)="([^"]+)"/g)) ids.add(match[1]);
      for (const match of text.matchAll(/usage\.(?:action|begin|milestone)\('([^']+)'/g)) ids.add(match[1]);
      for (const match of text.matchAll(/\s(?:data-testid|testId)="([^"]+)"/g)) ids.add(match[1].replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase());
      // An id built from a value must come from a closed set: only these templates are used.
      for (const match of text.matchAll(/(?:data-action|\baction)=\{`([^`]+)`\}/g)) {
        assert.ok(['mouse-${button}-selected', 'mouse-${button}-${action}', 'layout-${row}x${column}', 'measure-${item}', 'plane-${plane}',
          'overlay-${kebab(option.key)}', 'preset-${kebab(preset.key)}', 'mouse-${button}-binding'].includes(match[1]), `${file}: ${match[1]}`);
      }
    }
    assert.ok(ids.size > 100);
    for (const id of ids) { assert.match(id, ACTION, id); assert.ok(schema.spanAttributes['veacom.action'].enum.includes(id), id); }
  });
});
