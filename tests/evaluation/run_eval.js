import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  calculateItemMatch,
  calculateJsonMatch,
  calculateRougeN,
  calculateRougeL,
  calculateBleu,
  calculateTextStatistics,
  evaluateRulesAndRegex,
} from './metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const BASE_URL = `http://localhost:${process.env.PORT || 3000}`;
const API_KEY = process.env.API_KEY || '6feba21e37550086fa1c01ec7decf36e168540b0f692d934';

const headers = {
  'Content-Type': 'application/json',
  'x-api-key': API_KEY,
};

async function getOrCreateTestUser(level) {
  const email = `eval_test_${level.toLowerCase()}@vlingo.edu.co`;
  const res = await fetch(`${BASE_URL}/api/progress/user`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: `Estudiante Eval ${level}`,
      email,
      level,
    }),
  });
  if (!res.ok) {
    throw new Error(`Error al crear usuario para nivel ${level}: ${res.statusText}`);
  }
  const data = await res.json();
  return data.user.id;
}

async function runEvaluation() {
  console.log('='.repeat(70));
  console.log('   VLINGO AI - SUITE DE EVALUACIÓN AUTOMATIZADA DE LLMs');
  console.log('   (Evaluación con y sin Ground Truths - Diapositivas ICESI)');
  console.log('='.repeat(70));
  console.log(`Conectando a: ${BASE_URL}`);

  // 1. Cargar dataset
  const datasetPath = path.resolve(__dirname, 'dataset.json');
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
  console.log(`Casos de prueba cargados: ${dataset.length}\n`);

  // 2. Preparar usuarios por nivel
  const levels = ['A1', 'A2', 'B1', 'B2'];
  const userMap = {};
  for (const lvl of levels) {
    try {
      userMap[lvl] = await getOrCreateTestUser(lvl);
      console.log(`[Setup] Usuario de prueba para nivel ${lvl} preparado (ID: ${userMap[lvl]})`);
    } catch (e) {
      console.error(`[Setup Error] ${e.message}`);
    }
  }
  console.log('');

  const results = [];
  let totalLatency = 0;
  let failures = 0;

  for (const testCase of dataset) {
    const { id, name, type, endpoint, level, payload, ground_truth, validation_rules } = testCase;
    const userId = userMap[level];
    console.log(`\n------------------------------------------------------------`);
    console.log(`Ejecutando [${id}]: ${name} (${level})`);
    console.log(`Tipo: ${type} | Endpoint: ${endpoint}`);

    const fullPayload = { ...payload, userId };
    const startTime = Date.now();
    let responseObj = null;
    let statusCode = 200;
    let errorDetail = null;

    try {
      const res = await fetch(`${BASE_URL}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(fullPayload),
      });
      statusCode = res.status;
      if (!res.ok) {
        failures++;
        errorDetail = `HTTP ${res.status}: ${await res.text()}`;
      } else {
        responseObj = await res.json();
      }
    } catch (err) {
      failures++;
      statusCode = 500;
      errorDetail = err.message;
    }

    const latencyMs = Date.now() - startTime;
    totalLatency += latencyMs;
    console.log(`Latencia: ${latencyMs} ms | Estado: ${statusCode}`);

    const caseResult = {
      id,
      name,
      type,
      level,
      endpoint,
      latencyMs,
      statusCode,
      success: statusCode === 200,
      metrics: {},
    };

    if (statusCode === 200 && responseObj) {
      if (endpoint === '/api/chat/evaluate') {
        const jsonMatch = calculateJsonMatch(
          responseObj,
          ground_truth?.required_json_keys || ['score', 'grammar_errors', 'corrections', 'positive', 'tip'],
          ground_truth ? { min: ground_truth.expected_min_score, max: ground_truth.expected_max_score } : null
        );
        caseResult.metrics.jsonMatch = jsonMatch;
        console.log(` - JSON Match: ${jsonMatch.validJson ? 'VÁLIDO' : 'INVÁLIDO'} (Claves: ${jsonMatch.matchedKeysRate * 100}%)`);
        console.log(` - Score asignado: ${responseObj.score} (En rango esperado: ${jsonMatch.scoreInRange ? 'SÍ' : 'NO'})`);
        console.log(` - Errores detectados: [${responseObj.grammar_errors.join(', ')}]`);
        console.log(` - Corrección sugerida: "${responseObj.corrections[0] || ''}"`);
      }

      else if (type === 'with_ground_truth' && ground_truth?.reference_text) {
        const text = responseObj.message || '';
        const rouge1 = calculateRougeN(text, ground_truth.reference_text, 1);
        const rouge2 = calculateRougeN(text, ground_truth.reference_text, 2);
        const rougeL = calculateRougeL(text, ground_truth.reference_text);
        const bleu = calculateBleu(text, ground_truth.reference_text);
        const itemMatch = calculateItemMatch(text, ground_truth.expected_keywords || []);

        caseResult.metrics = {
          rouge1,
          rouge2,
          rougeL,
          bleu,
          itemMatch,
          textLength: text.length,
        };

        console.log(` - ROUGE-1 (F1): ${rouge1.f1} (Recall: ${rouge1.recall}, Precision: ${rouge1.precision})`);
        console.log(` - ROUGE-2 (F1): ${rouge2.f1}`);
        console.log(` - ROUGE-L (F1): ${rougeL.f1}`);
        console.log(` - BLEU: ${bleu}`);
        console.log(` - Item Match (Palabras clave): ${(itemMatch.matchRate * 100).toFixed(1)}%`);
      }

      else if (type === 'without_ground_truth') {
        const text = responseObj.message || '';
        const ruleEval = evaluateRulesAndRegex(text, validation_rules || {});
        caseResult.metrics = {
          ...ruleEval,
          rawResponse: text,
        };

        console.log(` - Estadísticas de texto: ${ruleEval.statistics.sentenceCount} oraciones, ${ruleEval.statistics.wordCount} palabras, ${ruleEval.statistics.questionCount} preguntas`);
        console.log(` - Cumplimiento de reglas: ${ruleEval.passedAll ? 'APROBADO' : 'OBSERVACIONES'}`);
        if (ruleEval.passes.length) console.log(`   * Aprobados: ${ruleEval.passes.join(' | ')}`);
        if (ruleEval.violations.length) console.log(`   * Violaciones: ${ruleEval.violations.join(' | ')}`);
      }
    } else {
      caseResult.error = errorDetail;
      console.log(` - Error en la petición: ${errorDetail}`);
    }

    results.push(caseResult);
  }

  const avgLatency = Math.round(totalLatency / dataset.length);
  const failureRate = ((failures / dataset.length) * 100).toFixed(2);

  const summary = {
    totalTests: dataset.length,
    successfulTests: dataset.length - failures,
    failureRatePercent: parseFloat(failureRate),
    avgLatencyMs: avgLatency,
    timestamp: new Date().toISOString(),
    results,
  };

  const outputPath = path.resolve(__dirname, 'results.json');
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  console.log('\n' + '='.repeat(70));
  console.log('              RESUMEN DE RESULTADOS DE EVALUACIÓN');
  console.log('='.repeat(70));
  console.log(`Total de pruebas ejecutadas: ${summary.totalTests}`);
  console.log(`Pruebas exitosas:           ${summary.successfulTests}`);
  console.log(`Tasa de fallos:             ${summary.failureRatePercent}% (Meta TG: < 1.0%)`);
  console.log(`Latencia promedio:          ${summary.avgLatencyMs} ms (Meta TG: < 3000 ms)`);
  console.log(`Resultados detallados guardados en: ${outputPath}`);
  console.log('='.repeat(70));

  return summary;
}

runEvaluation().catch(err => {
  console.error('Error fatal al ejecutar la evaluación:', err);
  process.exit(1);
});
