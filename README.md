# Perchance Image API v2

API independiente para generación de imágenes via Perchance. Usa Chrome CDP para autenticación con `image-generation.perchance.org`.

## Uso

```bash
node server.cjs              # Puerto 8810
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/health` | Estado del servicio |
| GET | `/v1/models` | Modelos disponibles |
| POST | `/v1/images/generations` | Generar imagen |

### POST /v1/images/generations

```json
{
  "prompt": "un gato astronauta",
  "size": "768x768",
  "negative_prompt": "bad quality",
  "seed": -1,
  "response_format": "b64_json"
}
```

Tamaños soportados: `512x512`, `768x768`, `1024x1024`, `portrait`, `square`, `landscape`

## Requisitos

- Node.js 18+
- Chrome con `--remote-debugging-port=9222`
