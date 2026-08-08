import 'dotenv/config';
import { spawn } from 'child_process';

const PORT = process.env.PORT || 3000;
const BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CONFIG_ROW_KEY = 'api_url';

const REGEX_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const REINTENTO_MS = 5000;

let urlPublicada = null;
let cerrando = false;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

async function publicarEnSupabase(url) {
  if (url === urlPublicada) return;

  const endpoint = `${SUPABASE_URL}/rest/v1/app_config?key=eq.${CONFIG_ROW_KEY}`;
  const res = await fetch(endpoint, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ value: url, updated_at: new Date().toISOString() }),
  });

  if (!res.ok) {
    const detalle = await res.text().catch(() => '');
    throw new Error(`Supabase respondió ${res.status}: ${detalle.slice(0, 300)}`);
  }

  const filas = await res.json().catch(() => []);
  if (!Array.isArray(filas) || filas.length === 0) {
    throw new Error(
      `No existe la fila key='${CONFIG_ROW_KEY}' en app_config. Créala antes de publicar.`,
    );
  }

  urlPublicada = url;
  console.log(`\n  URL publicada en Supabase → ${url}\n`);
}

function manejarSalida(texto) {
  process.stdout.write(texto);

  const match = texto.match(REGEX_URL);
  if (!match) return;

  publicarEnSupabase(match[0]).catch(err => {
    console.error(`\n  No se pudo publicar la URL: ${err.message}`);
    console.error(`  Actualízala a mano en app_config → ${match[0]}\n`);
  });
}

function lanzar() {
  console.log(`Levantando túnel hacia http://localhost:${PORT} ...`);

  const proc = spawn(BIN, ['tunnel', '--url', `http://localhost:${PORT}`], {
    shell: process.platform === 'win32',
  });

  // cloudflared escribe la URL asignada por stderr, no por stdout.
  proc.stdout.on('data', d => manejarSalida(d.toString()));
  proc.stderr.on('data', d => manejarSalida(d.toString()));

  proc.on('error', err => {
    console.error(`\nNo se pudo ejecutar '${BIN}': ${err.message}`);
    console.error('¿Está cloudflared instalado y en el PATH?');
    process.exit(1);
  });

  proc.on('exit', code => {
    if (cerrando) return;
    console.error(`\ncloudflared terminó (código ${code}). Reintentando en ${REINTENTO_MS / 1000}s...`);
    urlPublicada = null;
    setTimeout(lanzar, REINTENTO_MS);
  });

  const cerrar = () => {
    cerrando = true;
    proc.kill();
    process.exit(0);
  };
  process.once('SIGINT', cerrar);
  process.once('SIGTERM', cerrar);
}

lanzar();
