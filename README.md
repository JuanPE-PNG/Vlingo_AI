# VLINGO AI Backend — Guía de Instalación y Ejecución Local

Servicio backend basado en Node.js, Express y LangChain que proporciona una API REST para la asistencia en el aprendizaje del idioma inglés, integrando un modelo de lenguaje local ejecutado mediante Ollama y almacenamiento local en SQLite.

---

## 1. Requisitos Previos del Sistema

Para el despliegue y ejecución local del backend se requiere contar con las siguientes herramientas instaladas en el sistema operativo:

- **Node.js**: Versión `>= 20.16.0`
- **npm**: Administrador de paquetes de Node.js (incluido en la instalación de Node.js).
- **Ollama**: Motor de ejecución de modelos LLM locales, instalado y en ejecución accesible en `http://127.0.0.1:11434`.
- **Modelo de lenguaje**: `qwen2.5:3b-instruct` descargado en Ollama.
- **Hardware de aceleración (GPU)**: Se recomienda una GPU con al menos 4 GB de VRAM para soportar el modelo `qwen2.5:3b` cuantizado junto con una ventana de contexto de 4096 tokens (`OLLAMA_NUM_CTX=4096`). A mayor consumo de VRAM que se le pueda dar al modelo, mejor modelos se puede seleccionar.
- **Cloudflared**: Herramienta de línea de comandos de Cloudflare requerida únicamente si se planea levantar un túnel de acceso remoto mediante `scripts/tunnel.js`.
- **Cuenta y proyecto de Supabase**: Requerido únicamente para la publicación remota de la URL del túnel en la tabla `app_config`.

---

## 2. Variables de Entorno (.env)

El proyecto utiliza un archivo `.env` en la raíz de `vlingo-api` para gestionar su configuración. A continuación se detallan las variables reconocidas por el sistema:

| Variable | Descripción | Valor por defecto / Ejemplo |
|---|---|---|
| `PORT` | Puerto HTTP en el que se ejecuta el servidor Express. | `3000` |
| `NODE_ENV` | Entorno de ejecución (`development` o `production`). | `development` |
| `OLLAMA_MODEL` | Nombre del modelo descargado en Ollama. | `qwen2.5:3b-instruct` |
| `OLLAMA_BASE_URL` | Dirección base del servicio de Ollama. | `http://127.0.0.1:11434` |
| `OLLAMA_NUM_CTX` | Tamaño de la ventana de contexto en tokens enviada a Ollama. | `4096` |
| `MODEL_TEMPERATURE` | Temperatura de generación del modelo principal. | `0.4` |
| `MODEL_MAX_TOKENS` | Límite máximo de tokens generados en la respuesta principal. | `900` |
| `CONTEXT_WINDOW` | Límite de mensajes históricos considerados para la sesión. | `10` |
| `DB_PATH` | Ruta al archivo de base de datos SQLite. | `./data/vlingo.db` |
| `API_KEY` | Clave secreta requerida en la cabecera HTTP `x-api-key` para acceder a los endpoints protegidos. | *(Cadena hexadecimal secreta)* |
| `JWT_SECRET` | Clave para firmado o validación de tokens JWT. | `vlingo_dev_secret_change_in_production_2025` |
| `RATE_LIMIT_PER_MINUTE` | Número máximo de solicitudes permitidas por minuto por cliente. | `60` |
| `INPUT_CHAR_BUDGET` | Presupuesto máximo en caracteres para contexto e historial. | `9000` |
| `MEMORY_KEEP_RECENT` | Mensajes recientes preservados tras la compactación de memoria. | `6` |
| `MEMORY_COMPACT_TRIGGER` | Cantidad de mensajes pendientes requerida para activar resumen. | `12` |
| `CLOUDFLARED_BIN` | Nombre o ruta absoluta del binario de Cloudflare Tunnel. | `cloudflared` |
| `SUPABASE_URL` | URL del proyecto Supabase (utilizado por `scripts/tunnel.js`). | `https://<id-proyecto>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Clave de rol de servicio de Supabase para actualizar `app_config`. | `eyJ...` |
| `LANGCHAIN_TRACING_V2` | Activa el rastreo de ejecuciones en LangSmith (`true`/`false`). | `true` |
| `LANGCHAIN_ENDPOINT` | Endpoint de la API de LangSmith. | `https://api.smith.langchain.com` |
| `LANGCHAIN_API_KEY` | Clave de API de LangSmith. | `lsv2_pt_...` |
| `LANGCHAIN_PROJECT` | Nombre del proyecto asignado en LangSmith. | `vlingo-dev` |

> **Importante sobre la seguridad**: Si la variable `API_KEY` está presente en el archivo `.env`, toda petición hacia rutas que no comiencen por `/health` exigirá la cabecera `x-api-key`. Si no se envía dicha cabecera con el valor idéntico, el servidor devolverá código HTTP `401 Unauthorized`.

---

## 3. Guía de Instalación Paso a Paso

### Paso 1: Clonar o posicionarse en el directorio del proyecto

Se debe abrir una terminal en la carpeta principal del backend:

```bash
cd vlingo-api
```

### Paso 2: Instalar las dependencias de Node.js

Se instalan los paquetes definidos en `package.json` mediante:

```bash
npm install
```

Alternativamente, el proyecto cuenta con el comando de configuración asistida:

```bash
npm run setup
```
*(Dicho script ejecuta automáticamente `npm install` y posteriormente descarga el modelo local configurado).*

### Paso 3: Iniciar Ollama y descargar el modelo

Se debe asegurar que el servicio de Ollama esté ejecutándose en segundo plano (`ollama serve`). Luego, se descarga el modelo requerido:

```bash
npm run pull-model
```

Dicho comando invoca internamente:

```bash
ollama pull qwen2.5:3b-instruct
```

### Paso 4: Configurar el archivo de entorno

Se verifica la existencia del archivo `.env` en la raíz de `vlingo-api`. En caso de desplegar una instancia nueva, se deben ajustar variables críticas como `API_KEY`, `PORT`, `OLLAMA_MODEL` y `OLLAMA_BASE_URL`.

### Paso 5: Inicialización de la Base de Datos

No se requiere crear tablas manualmente. Al arrancar el servidor o al ejecutar el script de ingesta, el módulo `src/services/database.js` crea automáticamente el archivo `./data/vlingo.db` (activando el modo WAL) con el esquema completo (`users`, `sessions`, `messages`, `lessons`, `user_progress`, `materials`, `user_memory`, `user_errors`), e inserta automáticamente 4 lecciones semilla iniciales (niveles A1 a B1) si la tabla se encuentra vacía.

### Paso 6: Ingesta de Material Pedagógico (RAG)

Para poblar la base de conocimiento pedagógico utilizada por el sistema de recuperación (RAG):

1. Se colocan los archivos fuente en la carpeta `data/materials/` (se soportan formatos `.pdf`, `.txt`, `.md`).
2. Se debe seguir la convención de nomenclatura de archivos:
   ```
   [NIVEL]_[categoria]_[descripcion].[extension]
   ```
   - **Niveles válidos**: `A1`, `A2`, `B1`, `B2`, `C1`, `C2`.
   - **Categorías válidas**: `grammar`, `vocabulary`, `speaking`, `listening`, `culture`, `general`.
   - *Ejemplos*: `A1_grammar_present_simple.txt`, `B1_general_EverydayEnglish2.pdf`.
3. Se ejecuta el proceso de ingesta por lote:

```bash
npm run ingest
```

El script fragmenta los documentos en bloques de 800 caracteres con 100 de solapamiento, extrae palabras clave e indexa la información en la tabla `materials`.

---

## 4. Ejecución del Servidor

El proyecto dispone de dos modalidades de arranque:

### Modo desarrollo (con recarga automática ante cambios)
Utiliza el observador nativo de Node.js (`--watch`):

```bash
npm run dev
```

### Modo estándar / Producción
Inicia el proceso principal de Node.js:

```bash
npm start
```

Al iniciar, el servidor verifica la conexión con Ollama mediante una inferencia básica de comprobación. Si Ollama no responde o el modelo no está disponible, el proceso terminará con error.

Una vez en ejecución exitosa, la terminal informará:
```
VLINGO AI Backend
Inicializando base de datos...
Verificando Ollama (qwen2.5:3b-instruct)...
Ollama conectado

Servidor corriendo en http://localhost:3000
```

### Verificación de estado del servicio
Se puede consultar el endpoint de salud sin necesidad de credenciales:

```bash
curl -X GET http://localhost:3000/health
```

Respuesta esperada:
```json
{
  "status": "ok",
  "timestamp": "2026-11-13T...",
  "version": "1.0.0",
  "model": "qwen2.5:3b-instruct",
  "ollama": "ready"
}
```

---

## 5. Conexión de Clientes y Aplicación Móvil

Para conectar clientes externos (por ejemplo, la aplicación móvil VLINGO):

### Opción A: Conexión en Red Local (LAN)
1. Se localiza la dirección IP local de la computadora anfitriona (en Windows mediante `ipconfig`, buscando el campo *Dirección IPv4*).
2. Se configura la URL base en el cliente:
   ```
   http://<DIRECCION_IP_LOCAL>:3000
   ```
3. Se debe verificar que el Firewall del sistema operativo permita tráfico entrante en el puerto TCP `3000`.
4. El cliente debe incluir la cabecera `x-api-key` con el valor definido en el `.env` del servidor.

### Opción B: Conexión Remota con Cloudflare Tunnel
El repositorio incluye el script `scripts/tunnel.js` para exponer el servidor local a través de Cloudflare y sincronizar la URL resultante con Supabase:

1. Se ejecuta el script SQL `scripts/app_config.sql` en el panel de Supabase (*SQL Editor*) para crear la tabla `public.app_config` y habilitar su lectura pública.
2. Se configuran las variables `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` en el archivo `.env`.
3. Se ejecuta el script del túnel en una terminal separada:
   ```bash
   npm run tunnel
   ```
4. El script iniciará `cloudflared`, obtendrá una URL pública (`https://*.trycloudflare.com`) y actualizará automáticamente la clave `api_url` en la tabla `app_config` de Supabase, permitiendo que la aplicación móvil consulte la URL vigente sin necesidad de recompilar el cliente.

---

## 6. Referencia de la API REST

Todas las peticiones a endpoints bajo `/api/` requieren las siguientes cabeceras:
- `Content-Type: application/json`
- `x-api-key: <VALOR_DE_API_KEY>`

### 6.1. Salud del Sistema

#### `GET /health`
Verifica el estado del servidor, del modelo y del enlace con Ollama. No requiere autenticación.

#### `GET /health/session/:sessionId`
Retorna estadísticas de la sesión en memoria (conteo de mensajes y vista previa de mensajes).

---

### 6.2. Conversación y Chat (`/api/chat`)

#### `POST /api/chat/new-session`
Crea una sesión nueva para un usuario determinado.

- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario"
  }
  ```
- **Respuesta**:
  ```json
  {
    "sessionId": "uuid-de-sesion-creada"
  }
  ```

#### `POST /api/chat/message`
Envía un mensaje al tutor virtual de inteligencia artificial.

- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario",
    "message": "How do I use present simple?",
    "sessionId": "uuid-sesion-opcional",
    "stream": false,
    "userRole": "estudiante",
    "attachedContext": "Contexto opcional del curso actual"
  }
  ```
- **Cabeceras opcionales**: `X-Session-ID`.
- **Respuesta estándar (`stream: false`)**:
  ```json
  {
    "sessionId": "uuid-de-la-sesion",
    "message": "We use the present simple for habits and general truths...",
    "userLevel": "A1",
    "debug": {
      "mode": "grammar",
      "totalInDB": 2,
      "sentToModel": 2,
      "hasSummary": false,
      "memoryChars": 0
    }
  }
  ```
- **Respuesta en streaming (`stream: true`)**:
  Devuelve flujo de eventos SSE (`text/event-stream`). Cada fragmento emite:
  ```
  data: {"chunk": "fragmento de texto"}
  ```
  Al finalizar la emisión se envía:
  ```
  data: {"done": true, "sessionId": "uuid-de-la-sesion"}
  ```

#### `GET /api/chat/history/:sessionId?userId=<id>`
Obtiene la lista cronológica de mensajes pertenecientes a una sesión.

#### `GET /api/chat/sessions/:userId`
Obtiene las últimas 20 sesiones de conversación activas del usuario especificado.

#### `DELETE /api/chat/sessions/:sessionId`
Elimina la sesión, sus mensajes asociados y limpia la memoria en caché.
- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario"
  }
  ```

#### `POST /api/chat/evaluate`
Evalúa la calidad gramatical de un texto escrito por el estudiante según la escala y rúbrica del MCER. Registra automáticamente los errores reincidentes en `user_errors`.

- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario",
    "text": "Yesterday I go to the store.",
    "exerciseContext": "Past simple practice",
    "userRole": "estudiante"
  }
  ```
- **Respuesta**:
  ```json
  {
    "score": 75,
    "grammar_errors": [
      "go debe ser went: para acciones en pasado se usa la forma en pasado del verbo."
    ],
    "corrections": [
      "Yesterday I went to the store."
    ],
    "positive": "Buena estructura de la oración para describir una acción pasada.",
    "tip": "Recuerda que el verbo go es irregular y cambia a went en pasado simple."
  }
  ```

---

### 6.3. Lecciones y Ejercicios (`/api/lessons`)

#### `GET /api/lessons`
Lista las lecciones disponibles en la base de datos.
- **Parámetros de consulta opcionales**:
  - `level`: Filtrar por nivel (ej. `A1`).
  - `category`: Filtrar por categoría (ej. `grammar`).
  - `userId`: Incluye el progreso del usuario en cada lección devuelta.

#### `GET /api/lessons/:id`
Obtiene los detalles completos y los ejercicios de una lección específica.

#### `POST /api/lessons/:id/explain`
Solicita al asistente pedagógico una explicación conceptual vinculada a la lección.
- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario",
    "concept": "present simple negative"
  }
  ```

#### `POST /api/lessons/:id/hint`
Solicita una pista orientativa para un ejercicio concreto sin revelar la solución directa.
- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario",
    "exerciseIndex": 0,
    "studentAnswer": "He don't"
  }
  ```

---

### 6.4. Usuarios y Progreso (`/api/progress`)

#### `POST /api/progress/user`
Registra un usuario nuevo en SQLite o sincroniza el nivel si ya existe por correo.
- **Cuerpo de la petición**:
  ```json
  {
    "name": "Carlos Gomez",
    "email": "carlos@example.com",
    "level": "A1"
  }
  ```

#### `GET /api/progress/user/:userId`
Retorna el perfil del usuario junto con estadísticas de progreso (lecciones iniciadas, completadas, promedio de calificación, sesiones de chat y total de mensajes).

#### `PUT /api/progress/user/:userId`
Actualiza el nombre o nivel del usuario.
- **Cuerpo de la petición**:
  ```json
  {
    "name": "Carlos Gomez",
    "level": "A2"
  }
  ```

#### `POST /api/progress/lesson`
Registra o actualiza el avance y puntaje del usuario en una lección. Si el usuario supera suficientes lecciones con nota alta, sugiere una subida de nivel (`levelUp`).
- **Cuerpo de la petición**:
  ```json
  {
    "userId": "uuid-del-usuario",
    "lessonId": "greetings-a1",
    "status": "completed",
    "score": 90
  }
  ```

#### `GET /api/progress/:userId/lessons`
Obtiene el desglose de avance de todas las lecciones existentes para el usuario indicado.

---

### 6.5. Gestión de Material Pedagógico (`/api/materials`)

#### `POST /api/materials/ingest`
Carga un archivo multipart (`.pdf`, `.txt`, `.md`, `.json`, máximo 20 MB) para fragmentación e indexación.
- **Form-data**:
  - `file`: Archivo binario.
  - `level`: Nivel del material (`A1`, `A2`, etc.).
  - `category`: Categoría (`grammar`, `vocabulary`, etc.).

#### `POST /api/materials/ingest-text`
Ingresa texto directo en formato JSON.
- **Cuerpo de la petición**:
  ```json
  {
    "text": "Present continuous is used for actions happening right now...",
    "filename": "present_continuous_note",
    "level": "A2",
    "category": "grammar"
  }
  ```

#### `GET /api/materials`
Devuelve el listado de archivos indexados agrupados por nombre, nivel y categoría.

#### `DELETE /api/materials/:filename`
Elimina de la base de datos todos los fragmentos asociados al archivo indicado.

---

## 7. Pruebas y Evaluación Automatizada

El backend cuenta con una suite de evaluación cuantitativa del modelo de lenguaje basada en métricas estándar (con y sin *Ground Truth*), ubicada en el directorio `tests/evaluation/`.

Para ejecutar la suite de pruebas:

1. Se debe asegurar que el servidor backend esté corriendo en una terminal (`npm run dev` o `npm start`).
2. En otra terminal, se ejecuta:

```bash
npm run test:eval
```

### Métricas evaluadas
El script `tests/evaluation/run_eval.js` procesa los casos de prueba contenidos en `tests/evaluation/dataset.json` y evalúa:
- **Latencia**: Tiempo de respuesta en milisegundos por inferencia.
- **Formato y estructura JSON**: Verificación de claves obligatorias y coherencia en `/api/chat/evaluate`.
- **Métricas con Ground Truth**:
  - **ROUGE-1, ROUGE-2 y ROUGE-L** (Precision, Recall y F1-Score).
  - **BLEU Score**: Coincidencia n-gramática con respecto al texto de referencia.
  - **Item Match Rate**: Porcentaje de términos clave esperados encontrados en la respuesta.
- **Métricas sin Ground Truth**: Conteo de oraciones, palabras, preguntas y cumplimiento de reglas mediante expresiones regulares.

Los resultados finales y el resumen se guardan automáticamente en el archivo `tests/evaluation/results.json`.

---

## 8. Estructura del Directorio

```
vlingo-api/
├── .env                             # Variables de entorno y secretos del sistema
├── .gitignore                       # Exclusiones de Git (node_modules, SQLite, logs)
├── package.json                     # Metadatos del proyecto, motores y scripts
├── package-lock.json                # Bloqueo de dependencias de npm
├── README.md                        # Guía de instalación y documentación del backend
├── data/
│   ├── materials/                   # Repositorio de archivos pedagógicos (.pdf, .txt, .md)
│   └── vlingo.db                    # Base de datos SQLite (generada automáticamente)
├── scripts/
│   ├── app_config.sql               # Script SQL para crear la tabla de configuración en Supabase
│   ├── ingest.js                    # Script de ingesta y fragmentación por lote de materiales
│   └── tunnel.js                    # Gestor de túnel Cloudflare y sincronización con Supabase
├── src/
│   ├── index.js                     # Punto de entrada de la aplicación Express y middlewares
│   ├── routes/
│   │   ├── chat.js                  # Endpoints de conversación, sesiones y evaluación de escritura
│   │   ├── health.js                # Endpoints de verificación de estado y estadísticas de sesión
│   │   ├── lessons.js               # Endpoints de consulta de lecciones, explicaciones y pistas
│   │   ├── materials.js             # Endpoints de ingesta y administración de materiales RAG
│   │   └── progress.js              # Endpoints de gestión de usuarios, avances y estadísticas
│   └── services/
│       ├── database.js              # Conexión, esquemas y semillas de la base de datos SQLite
│       ├── memory.js                # Extracción de hechos, registro de errores y compactación
│       ├── ollama.js                # Integración con Ollama via LangChain y cadenas de prompts
│       ├── prompts.js               # Plantillas de sistema, perfiles MCER (A1-C2) y modos
│       └── rag.js                   # Fragmentación de texto y recuperación de contexto pedagógico
└── tests/
    └── evaluation/
        ├── dataset.json             # Dataset de casos de prueba para evaluación
        ├── metrics.js               # Implementación de métricas (ROUGE, BLEU, Item Match)
        ├── results.json             # Salida detallada de la última evaluación ejecutada
        └── run_eval.js              # Script ejecutor de la suite de evaluación
```
