import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { checkContradictions, isContradiction, contradictionsEnabled } from '../src/contradiction.js';

describe('contradiction.js', () => {

  describe('determinism', () => {
    it('same inputs produce same outputs repeatedly', () => {
      const env = { CORTEX_CONTRADICTION_FLAG: 'true' };
      const existingFacts = ['status is active', 'name is Alice'];
      const newFacts = ['status is not active'];

      for (let i = 0; i < 10; i++) {
        const result = checkContradictions(existingFacts, newFacts, env);
        assert.strictEqual(result.length, 1, `Run ${i}: expected 1 contradiction, got ${result.length}`);
        assert.strictEqual(result[0].existing, 'status is active');
        assert.strictEqual(result[0].new, 'status is not active');
      }
    });

    it('isContradiction is deterministic', () => {
      const pairs = [
        ['status is active', 'status is not active'],
        ['has permission', 'does not have permission'],
        ['no access granted', 'access granted'],
      ];

      for (const [existing, newFact] of pairs) {
        for (let i = 0; i < 5; i++) {
          const result = isContradiction(existing, newFact);
          assert.strictEqual(result, true, `${existing} vs ${newFact} should be true on run ${i}`);
        }
      }
    });

    it('non-contradictions return false consistently', () => {
      const pairs = [
        ['status is active', 'status is pending'],
        ['name is Alice', 'name is Bob'],
        ['location is NYC', 'role is admin'],
      ];

      for (const [existing, newFact] of pairs) {
        for (let i = 0; i < 5; i++) {
          const result = isContradiction(existing, newFact);
          assert.strictEqual(result, false, `${existing} vs ${newFact} should be false on run ${i}`);
        }
      }
    });
  });

  describe('flag behavior', () => {
    it('disabled flag returns empty array', () => {
      const env = { CORTEX_CONTRADICTION_FLAG: '' };
      const result = checkContradictions(['status is active'], ['status is not active'], env);
      assert.deepStrictEqual(result, []);
    });

    it('disabled flag with undefined returns empty array', () => {
      const result = checkContradictions(['status is active'], ['status is not active'], {});
      assert.deepStrictEqual(result, []);
    });

    it('enabled flag truthy values return results', () => {
      const truthyValues = ['true', '1', 'yes', 'on'];
      for (const val of truthyValues) {
        const env = { CORTEX_CONTRADICTION_FLAG: val };
        const result = checkContradictions(['status is active'], ['status is not active'], env);
        assert.strictEqual(result.length, 1, `flag=${val} should detect contradiction`);
      }
    });
  });

  describe('contradiction detection', () => {
    it('detects active vs not active', () => {
      const result = isContradiction('status is active', 'status is not active');
      assert.strictEqual(result, true);
    });

    it('detects negative vs positive pair', () => {
      const result = isContradiction('no access granted', 'access granted');
      assert.strictEqual(result, true);
    });

    it('does not detect same-sign statements', () => {
      const result = isContradiction('status is active', 'status is pending');
      assert.strictEqual(result, false);
    });

    it('handles contraction forms like doesn\'t', () => {
      const result = isContradiction('has permission', 'does not have permission');
      assert.strictEqual(result, true);
    });

    it('handles "never" as negation', () => {
      const result = isContradiction('always available', 'never available');
      assert.strictEqual(result, true);
    });
  });

  describe('checkContradictions integration', () => {
    it('returns structured output with existing and new fields', () => {
      const env = { CORTEX_CONTRADICTION_FLAG: 'true' };
      const existingFacts = ['status is active'];
      const newFacts = ['status is not active'];
      const result = checkContradictions(existingFacts, newFacts, env);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].existing, 'status is active');
      assert.strictEqual(result[0].new, 'status is not active');
      assert.strictEqual(result[0].type, 'detected_conflict');
    });

    it('returns empty for non-array inputs', () => {
      const env = { CORTEX_CONTRADICTION_FLAG: 'true' };
      assert.deepStrictEqual(checkContradictions(null, ['a'], env), []);
      assert.deepStrictEqual(checkContradictions(['a'], null, env), []);
      assert.deepStrictEqual(checkContradictions({}, ['a'], env), []);
    });
  });

  describe('non-string fact handling', () => {
    it('isContradiction ignores null facts', () => {
      assert.strictEqual(isContradiction(null, 'status is not active'), false);
      assert.strictEqual(isContradiction('status is active', null), false);
    });

    it('isContradiction ignores undefined facts', () => {
      assert.strictEqual(isContradiction(undefined, 'status is not active'), false);
      assert.strictEqual(isContradiction('status is active', undefined), false);
    });

    it('isContradiction ignores object facts', () => {
      assert.strictEqual(isContradiction({}, 'status is not active'), false);
      assert.strictEqual(isContradiction('status is active', { foo: 'bar' }), false);
    });

    it('isContradiction ignores number facts', () => {
      assert.strictEqual(isContradiction(42, 'status is not active'), false);
      assert.strictEqual(isContradiction('status is active', 123), false);
    });

    it('checkContradictions ignores non-string facts in arrays', () => {
      const env = { CORTEX_CONTRADICTION_FLAG: 'true' };
      const existingFacts = ['status is active', null, undefined, {}, 42];
      const newFacts = ['status is not active', null, { foo: 'bar' }];
      const result = checkContradictions(existingFacts, newFacts, env);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].existing, 'status is active');
      assert.strictEqual(result[0].new, 'status is not active');
    });
  });

  describe('contradicationsEnabled helper', () => {
    it('returns false when flag not set', () => {
      assert.strictEqual(contradictionsEnabled({}), false);
    });

    it('returns true when flag is on', () => {
      assert.strictEqual(contradictionsEnabled({ CORTEX_CONTRADICTION_FLAG: 'on' }), true);
    });
  });
});