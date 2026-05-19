const TRUTHY_VALUES = ['true', '1', 'yes', 'on'];

function isFlagEnabled(env = process.env) {
  const flag = env.CORTEX_CONTRADICTION_FLAG;
  if (!flag) return false;
  return TRUTHY_VALUES.includes(String(flag).toLowerCase());
}

export function hasNegation(text) {
  if (typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  return lower.includes(' not') ||
         lower.includes("n't") ||
         lower.startsWith('no ') ||
         lower.includes('never') ||
         lower.includes('neither');
}

export function extractNegationForm(text) {
  if (typeof text !== 'string') return { negated: false, positive: '' };
  const lower = text.toLowerCase();
  if (lower.includes(' not ') || lower.endsWith(' not')) {
    let positive = text
      .replace(/^does not /i, '')
      .replace(/^do not /i, '')
      .replace(/^is not /i, '')
      .replace(/^are not /i, '')
      .replace(/^was not /i, '')
      .replace(/^were not /i, '')
      .replace(/^has not /i, '')
      .replace(/^have not /i, '')
      .replace(/ not /i, ' ')
      .replace(/ not$/i, '');
    return { negated: true, positive };
  }
  if (lower.includes("n't")) {
    let positive = text
      .replace(/n't/gi, ' not')
      .replace(/^does not /i, '')
      .replace(/^do not /i, '')
      .replace(/^is not /i, '')
      .replace(/^are not /i, '')
      .replace(/^was not /i, '')
      .replace(/^were not /i, '')
      .replace(/^has not /i, '')
      .replace(/^have not /i, '')
      .replace(/ not /i, ' ')
      .replace(/ not$/i, '');
    return { negated: true, positive };
  }
  if (lower.startsWith('no ')) {
    return { negated: true, positive: text.substring(3) };
  }
  if (lower.includes('never')) {
    return { negated: true, positive: text.replace(/never/i, 'always') };
  }
  return { negated: false, positive: text };
}

export function normalizeTopic(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const removeArticles = s => s.replace(/\b(a|an|the)\b/gi, '').trim();
  const removeHasHave = s => s.replace(/^(has|have|had|is|are|was|were|does|do|did)\s+/i, '');
  const aNorm = removeArticles(removeHasHave(a.toLowerCase()));
  const bNorm = removeArticles(removeHasHave(b.toLowerCase()));
  return aNorm === bNorm;
}

export function isContradiction(existing, newFact) {
  if (typeof existing !== 'string' || typeof newFact !== 'string') return false;
  const existingNeg = hasNegation(existing);
  const newNeg = hasNegation(newFact);
  if (existingNeg === newNeg) return false;

  const existingForm = extractNegationForm(existing);
  const newForm = extractNegationForm(newFact);

  return normalizeTopic(existingForm.positive, newForm.positive);
}

export function checkContradictions(existingFacts, newFacts, env = process.env) {
  if (!isFlagEnabled(env)) {
    return [];
  }

  if (!Array.isArray(existingFacts) || !Array.isArray(newFacts)) {
    return [];
  }

  const contradictions = [];

  for (const existing of existingFacts) {
    for (const newFact of newFacts) {
      if (isContradiction(existing, newFact)) {
        contradictions.push({
          existing,
          new: newFact,
          type: 'detected_conflict'
        });
      }
    }
  }

  return contradictions;
}

export function contradictionsEnabled(env = process.env) {
  return isFlagEnabled(env);
}