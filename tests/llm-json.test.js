import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractFirstJsonObject, parseEnrichmentPayload } from '../src/llm_json.js';

describe('llm_json helpers', () => {
  it('extracts JSON wrapped in markdown fences', () => {
    const parsed = extractFirstJsonObject('```json\n{"facts":["a"],"narrative":"n"}\n```');
    assert.deepStrictEqual(parsed, { facts: ['a'], narrative: 'n' });
  });

  it('extracts the first balanced JSON object from mixed text', () => {
    const parsed = extractFirstJsonObject('thinking...\n{"facts":["a"],"narrative":"n","links":[]}\nextra');
    assert.deepStrictEqual(parsed, { facts: ['a'], narrative: 'n', links: [] });
  });

  it('rejects enrichment payloads without a narrative', () => {
    assert.throws(
      () => parseEnrichmentPayload('{"facts":["a"],"links":[]}'),
      /missing narrative/
    );
  });
});
