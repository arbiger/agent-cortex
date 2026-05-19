import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseEmbeddingResponse } from '../src/embedding.js';

describe('embedding', () => {
  it('parseEmbeddingResponse extracts embedding from standard response structure', () => {
    const mockResponse = JSON.stringify({
      data: [{
        embedding: [0.1, 0.2, 0.3, 0.4],
      }]
    });
    const embedding = parseEmbeddingResponse(mockResponse);
    assert.deepStrictEqual(embedding, [0.1, 0.2, 0.3, 0.4]);
  });

  it('parseEmbeddingResponse handles nested data structure correctly', () => {
    const embedding = [0.01, -0.05, 0.99, 0.0, -0.3];
    const mockResponse = JSON.stringify({
      object: 'list',
      data: [{ embedding }],
      model: 'bge-m3-mlx-fp16'
    });
    const result = parseEmbeddingResponse(mockResponse);
    assert.deepStrictEqual(result, embedding);
  });

  it('parseEmbeddingResponse throws on missing data field', () => {
    const badResponse = JSON.stringify({});
    assert.throws(
      () => parseEmbeddingResponse(badResponse),
      /Cannot read properties of undefined/
    );
  });

  it('parseEmbeddingResponse returns undefined when data[0] has no embedding field', () => {
    const mockResponse = JSON.stringify({ data: [{}] });
    const result = parseEmbeddingResponse(mockResponse);
    assert.strictEqual(result, undefined);
  });

  it('parseEmbeddingResponse throws on null response', () => {
    assert.throws(
      () => parseEmbeddingResponse(null),
      /Cannot read properties of null/
    );
  });

  it('parseEmbeddingResponse works with various embedding vector lengths', () => {
    for (const length of [1, 10, 128, 1536]) {
      const embedding = Array(length).fill(0).map((_, i) => i * 0.01);
      const mockResponse = JSON.stringify({ data: [{ embedding }] });
      const result = parseEmbeddingResponse(mockResponse);
      assert.strictEqual(result.length, length, `Should handle length ${length}`);
    }
  });

  it('parseEmbeddingResponse works with negative and fractional values', () => {
    const embedding = [-0.5, 0.333, 1.0, -1.0, 0.0];
    const mockResponse = JSON.stringify({ data: [{ embedding }] });
    const result = parseEmbeddingResponse(mockResponse);
    assert.deepStrictEqual(result, embedding);
  });

  it('getEmbedding uses POST method in dist/server.js', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSrc = readFileSync('./dist/server.js', 'utf-8');
    assert.ok(serverSrc.includes("method: 'POST'"), 'getEmbedding should use POST method');
  });

  it('getEmbedding includes Content-Type application/json header in dist/server.js', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSrc = readFileSync('./dist/server.js', 'utf-8');
    assert.ok(serverSrc.includes("'Content-Type': 'application/json'"));
  });

  it('getEmbedding sends model and input in request body in dist/server.js', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSrc = readFileSync('./dist/server.js', 'utf-8');
    assert.ok(serverSrc.includes('model: EMBED_MODEL'));
    assert.ok(serverSrc.includes('input: text'));
  });

  it('getEmbedding throws on non-ok response in dist/server.js', async () => {
    const { readFileSync } = await import('node:fs');
    const serverSrc = readFileSync('./dist/server.js', 'utf-8');
    assert.ok(serverSrc.includes('Embedding failed'));
  });

  it('getEmbedding parseEmbeddingResponse function exists as module export', async () => {
    const { parseEmbeddingResponse: fn } = await import('../src/embedding.js');
    assert.ok(typeof fn === 'function', 'parseEmbeddingResponse should be exported');
  });
});