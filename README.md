# VLINGO AI Backend

API REST que conecta tu app móvil con un modelo LLM local via Ollama.  
Corre 100% en tu PC (sin nube, sin costos), optimizado para 16GB RAM / 4GB VRAM NVIDIA.

---

## Requisitos

- Node.js 18+
- Ollama instalado y corriendo (`ollama serve`)
- GPU NVIDIA con CUDA (ya configurado)
- Windows 10/11

---

## Instalación rápida

```bash
# 1. Instalar dependencias
npm install

# 2. Descargar el modelo (solo la primera vez, ~2GB)
ollama pull llama3.2:3b

# 3. Copiar y configurar variables de entorno
copy .env .env.local
# (editar .env si necesitas cambiar puertos o modelo)

# 4. Iniciar el servidor
npm run dev
```

El servidor arranca en `http://localhost:3000`.

---

## Conectar desde la app móvil

La app debe conectar a la IP local de tu PC (no `localhost`).  
Para encontrar tu IP: ejecuta `ipconfig` en cmd y busca "Dirección IPv4".

```
http://192.168.x.x:3000
```

Asegúrate de que el firewall de Windows permita el puerto 3000.

---

## Endpoints principales

### Chat (conversación con el asistente)

```
POST /api/chat/message
Content-Type: application/json

{
  "userId": "uuid-del-usuario",
  "message": "How do I use present simple?",
  "sessionId": "uuid-sesion-opcional",
  "stream": false
}

Respuesta:
{
  "sessionId": "uuid",
  "message": "Great question! Present simple...",
  "userLevel": "A1"
}
```

**Modo streaming** (respuesta aparece mientras se genera):
```
"stream": true
→ Responde con SSE (text/event-stream)
→ Cada evento: data: {"chunk": "texto..."}
→ Final: data: {"done": true, "sessionId": "..."}
```

### Evaluación de texto

```
POST /api/chat/evaluate

{
  "userId": "uuid",
  "text": "Yesterday I go to the store",
  "exerciseContext": "past simple practice"
}

Respuesta:
{
  "score": 65,
  "grammar_errors": ["go should be went"],
  "corrections": ["Yesterday I went to the store"],
  "positive": "Good attempt at past tense!",
  "tip": "Los verbos irregulares como 'go' cambian a 'went' en pasado"
}
```

### Usuarios y progreso

```
POST /api/progress/user          → Crear usuario
GET  /api/progress/user/:id      → Perfil + estadísticas
PUT  /api/progress/user/:id      → Actualizar nivel
POST /api/progress/lesson        → Guardar progreso en lección
GET  /api/progress/:userId/lessons → Progreso en todas las lecciones
```

### Lecciones

```
GET  /api/lessons                → Listar (filtrar por ?level=A1&userId=xxx)
GET  /api/lessons/:id            → Detalle con ejercicios
POST /api/lessons/:id/explain    → El asistente explica un concepto
POST /api/lessons/:id/hint       → Pista para un ejercicio
```

### Material pedagógico (RAG)

```
POST /api/materials/ingest       → Subir archivo (.txt, .pdf, .md)
POST /api/materials/ingest-text  → Texto directo en JSON
GET  /api/materials              → Ver material ingresado
DELETE /api/materials/:filename  → Eliminar material
```

### Salud del sistema

```
GET /health → Estado de Ollama y el modelo
```

---

## Agregar tu material pedagógico

### Opción 1: Script por lote (recomendado)

1. Coloca tus archivos `.txt` o `.md` en `data/materials/`
2. Nombra los archivos con la convención: `[NIVEL]_[categoria]_descripcion.txt`
   - `A1_grammar_present_simple.txt`
   - `B1_vocabulary_business_english.txt`
   - `A2_culture_american_customs.md`
3. Ejecuta: `npm run ingest`

### Opción 2: API en tiempo real

```bash
# Subir archivo
curl -X POST http://localhost:3000/api/materials/ingest \
  -F "file=@mi_material.txt" \
  -F "level=A1" \
  -F "category=grammar"

# Texto directo
curl -X POST http://localhost:3000/api/materials/ingest-text \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Present simple is used for habits...",
    "filename": "present_simple_notes",
    "level": "A2",
    "category": "grammar"
  }'
```

---

## Ajustar el modelo

En `.env`:

| Variable | Descripción | Por defecto |
|---|---|---|
| `OLLAMA_MODEL` | Modelo a usar | `llama3.2:3b` |
| `MODEL_TEMPERATURE` | Creatividad (0-1) | `0.7` |
| `MODEL_MAX_TOKENS` | Longitud máx respuesta | `512` |
| `CONTEXT_WINDOW` | Mensajes de historial | `10` |

### Modelos alternativos para tu hardware

```bash
# Más rápido, menos calidad (~1.5GB VRAM)
ollama pull phi3:mini
# Cambiar en .env: OLLAMA_MODEL=phi3:mini

# Mejor calidad, usa RAM+VRAM (~4GB total)
ollama pull mistral:7b
# OLLAMA_MODEL=mistral:7b
```

---

## Estructura del proyecto

```
vlingo-api/
├── src/
│   ├── index.js              # Servidor Express
│   ├── routes/
│   │   ├── chat.js           # Conversación con IA
│   │   ├── lessons.js        # Lecciones y ejercicios
│   │   ├── progress.js       # Usuarios y progreso
│   │   ├── materials.js      # Ingesta de material
│   │   └── health.js         # Health check
│   └── services/
│       ├── ollama.js         # Integración con Ollama
│       ├── database.js       # SQLite
│       └── rag.js            # Retrieval de contexto
├── scripts/
│   └── ingest.js             # Ingesta en lote
├── data/
│   ├── materials/            # Aquí van tus archivos
│   └── vlingo.db             # Base de datos (auto-generada)
├── .env                      # Configuración
└── package.json
```
