export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function getNgrams(tokens, n) {
  const ngrams = [];
  for (let i = 0; i <= tokens.length - n; i++) {
    ngrams.push(tokens.slice(i, i + n).join(' '));
  }
  return ngrams;
}

// ─── 1. MÉTRICAS CON GROUND TRUTHS ─────────────────────────────────────────────

export function calculateItemMatch(generatedText, expectedKeywords = []) {
  if (!expectedKeywords.length) return { matchRate: 1, matched: [], missing: [] };
  const lower = (generatedText || '').toLowerCase();
  const matched = expectedKeywords.filter(kw => lower.includes(kw.toLowerCase()));
  const missing = expectedKeywords.filter(kw => !lower.includes(kw.toLowerCase()));
  return {
    matchRate: parseFloat((matched.length / expectedKeywords.length).toFixed(3)),
    matched,
    missing,
  };
}

export function calculateJsonMatch(jsonObj, requiredKeys = [], scoreRange = null) {
  if (!jsonObj || typeof jsonObj !== 'object') {
    return { validJson: false, matchedKeys: 0, missingKeys: requiredKeys, scoreInRange: false };
  }
  const actualKeys = Object.keys(jsonObj);
  const matchedKeys = requiredKeys.filter(k => actualKeys.includes(k));
  const missingKeys = requiredKeys.filter(k => !actualKeys.includes(k));
  
  let scoreInRange = true;
  if (scoreRange && typeof jsonObj.score === 'number') {
    scoreInRange = jsonObj.score >= scoreRange.min && jsonObj.score <= scoreRange.max;
  }

  return {
    validJson: true,
    matchedKeysRate: requiredKeys.length ? parseFloat((matchedKeys.length / requiredKeys.length).toFixed(3)) : 1,
    missingKeys,
    scoreInRange,
    hasGrammarErrorsArray: Array.isArray(jsonObj.grammar_errors),
    hasCorrectionsArray: Array.isArray(jsonObj.corrections),
  };
}

export function calculateRougeN(generated, reference, n = 1) {
  const genTokens = tokenize(generated);
  const refTokens = tokenize(reference);

  if (genTokens.length < n || refTokens.length < n) {
    return { recall: 0, precision: 0, f1: 0 };
  }

  const genNgrams = getNgrams(genTokens, n);
  const refNgrams = getNgrams(refTokens, n);

  const refCounts = {};
  for (const gram of refNgrams) {
    refCounts[gram] = (refCounts[gram] || 0) + 1;
  }

  let matches = 0;
  const tempRefCounts = { ...refCounts };
  for (const gram of genNgrams) {
    if (tempRefCounts[gram] && tempRefCounts[gram] > 0) {
      matches++;
      tempRefCounts[gram]--;
    }
  }

  const recall = matches / refNgrams.length;
  const precision = matches / genNgrams.length;
  const f1 = (precision + recall > 0)
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  return {
    recall: parseFloat(recall.toFixed(3)),
    precision: parseFloat(precision.toFixed(3)),
    f1: parseFloat(f1.toFixed(3)),
  };
}

export function calculateRougeL(generated, reference) {
  const genTokens = tokenize(generated);
  const refTokens = tokenize(reference);
  const m = genTokens.length;
  const n = refTokens.length;

  if (m === 0 || n === 0) return { recall: 0, precision: 0, f1: 0 };

  // DP matrix for LCS
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (genTokens[i - 1] === refTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const lcs = dp[m][n];
  const recall = lcs / n;
  const precision = lcs / m;
  const f1 = (precision + recall > 0)
    ? (2 * precision * recall) / (precision + recall)
    : 0;

  return {
    lcs,
    recall: parseFloat(recall.toFixed(3)),
    precision: parseFloat(precision.toFixed(3)),
    f1: parseFloat(f1.toFixed(3)),
  };
}

export function calculateBleu(generated, reference, maxN = 4) {
  const genTokens = tokenize(generated);
  const refTokens = tokenize(reference);

  if (genTokens.length === 0) return 0;

  const c = genTokens.length;
  const r = refTokens.length;
  const bp = c > r ? 1 : Math.exp(1 - r / c);

  let logSum = 0;
  let validN = 0;

  for (let n = 1; n <= maxN; n++) {
    if (genTokens.length < n) break;
    const genNgrams = getNgrams(genTokens, n);
    const refNgrams = getNgrams(refTokens, n);

    const refCounts = {};
    for (const g of refNgrams) refCounts[g] = (refCounts[g] || 0) + 1;

    let matchCount = 0;
    const tempRef = { ...refCounts };
    for (const g of genNgrams) {
      if (tempRef[g] && tempRef[g] > 0) {
        matchCount++;
        tempRef[g]--;
      }
    }

    const prec = matchCount / genNgrams.length;
    if (prec > 0) {
      logSum += Math.log(prec);
      validN++;
    } else {
      // Smoothing
      logSum += Math.log(1 / (genNgrams.length + 1));
      validN++;
    }
  }

  if (validN === 0) return 0;
  const geoMean = Math.exp(logSum / validN);
  return parseFloat((bp * geoMean).toFixed(3));
}

// ─── 2. MÉTRICAS SIN GROUND TRUTHS ─────────────────────────────────────────────

export function calculateTextStatistics(text) {
  if (!text || typeof text !== 'string') {
    return { sentenceCount: 0, wordCount: 0, questionCount: 0 };
  }
  // Dividir en oraciones por '.', '!', '?'
  const sentences = text
    .split(/[.!?]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const words = text.trim().split(/\s+/).filter(Boolean);
  const questionMarks = (text.match(/\?/g) || []).length;

  return {
    sentenceCount: sentences.length,
    wordCount: words.length,
    questionCount: questionMarks,
  };
}

export function evaluateRulesAndRegex(text, rules = {}) {
  const lower = (text || '').toLowerCase();
  const violations = [];
  const passes = [];

  if (rules.affective_filter) {
    const harshWords = ['you made a mistake', 'is wrong', 'are wrong', 'incorrect sentence', 'fatal error'];
    const foundHarsh = harshWords.filter(hw => lower.includes(hw));
    if (foundHarsh.length > 0) {
      violations.push(`Filtro afectivo fallido: contiene palabras punitivas (${foundHarsh.join(', ')})`);
    } else {
      passes.push('Filtro afectivo cumplido (sin juicio punitivo)');
    }
  }

  if (rules.require_followup_question) {
    const questions = (text.match(/\?/g) || []).length;
    if (questions === 1) {
      passes.push('Pregunta de seguimiento única correcta (exactamente 1 ?)');
    } else if (questions > 1) {
      violations.push(`Exceso de preguntas: ${questions} preguntas detectadas (debe ser 1)`);
    } else {
      violations.push('Falta pregunta de seguimiento (0 preguntas detectadas)');
    }
  }

  const stats = calculateTextStatistics(text);
  if (rules.min_sentences && stats.sentenceCount < rules.min_sentences) {
    violations.push(`Oraciones insuficientes: ${stats.sentenceCount} < ${rules.min_sentences}`);
  }
  if (rules.max_sentences && stats.sentenceCount > rules.max_sentences) {
    violations.push(`Exceso de oraciones: ${stats.sentenceCount} > ${rules.max_sentences}`);
  }

  if (rules.indirect_correction_patterns) {
    const matchedCorr = rules.indirect_correction_patterns.filter(p => lower.includes(p.toLowerCase()));
    if (matchedCorr.length > 0) {
      passes.push(`Modelado indirecto detectado: coincidió con [${matchedCorr.join(', ')}]`);
    } else {
      violations.push(`No se detectaron patrones de modelado esperados`);
    }
  }

  if (rules.refusal_or_redirect_patterns) {
    const matchedRedir = rules.refusal_or_redirect_patterns.filter(p => lower.includes(p.toLowerCase()));
    if (matchedRedir.length > 0) {
      passes.push(`Redirección de dominio exitosa: mención de [${matchedRedir.join(', ')}]`);
    } else {
      violations.push(`No se detectó redirección al aprendizaje de inglés`);
    }
  }

  return {
    passedAll: violations.length === 0,
    passes,
    violations,
    statistics: stats,
  };
}
