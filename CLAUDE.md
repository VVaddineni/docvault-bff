# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

This is a multi-repo project. The four services live in sibling directories:

```
docvault/
├── docvault-frontend/              # React SPA (port 3000)
├── docvault-bff/                   # Node.js BFF (this repo, port 4000)
├── documentservice/
│   └── docvault-document-service/  # Spring Boot (port 8080)
└── docvault-search-service/        # Spring Boot (port 8081)
```

## Commands

```bash
npm install          # install deps
npm run dev          # dev server with nodemon (auto-reload) on :4000
npm start            # production server
npm test             # Jest test runner
```

## Architecture

### Request Flow
```
Browser → React SPA (3000)
       → BFF /api/... (4000)   ← this repo
         → Document Service /v1/documents (8080)
         → Search Service /v1/search (8081)
```

The BFF is a pure proxy/aggregation layer. The React SPA **never** calls microservices directly.

### Source Layout
```
src/
├── server.js          Express app entry point (port 4000)
├── routes/
│   ├── documents.js   Proxy routes for /api/documents
│   ├── search.js      Proxy routes for /api/search
│   └── health.js      GET /health
├── services/
│   └── apimClient.js  Axios HTTP client (wraps calls to downstream services)
└── utils/
    └── logger.js      Winston logger
```

### Route → Downstream Mapping
All BFF routes strip `/api` and forward to the appropriate service:

| BFF Route | Downstream |
|-----------|-----------|
| `GET /api/documents` | `GET DOCUMENT_SERVICE_URL/v1/documents` |
| `POST /api/documents/upload` | `POST DOCUMENT_SERVICE_URL/v1/documents` |
| `GET /api/documents/:id/download` | `GET DOCUMENT_SERVICE_URL/v1/documents/:id/download` |
| `POST /api/documents/:id/rehydrate` | `POST DOCUMENT_SERVICE_URL/v1/documents/:id/rehydrate` |
| `PATCH /api/documents/:id` | `PATCH DOCUMENT_SERVICE_URL/v1/documents/:id` |
| `DELETE /api/documents/:id` | `DELETE DOCUMENT_SERVICE_URL/v1/documents/:id` |
| `GET /api/documents/stats` | `GET DOCUMENT_SERVICE_URL/v1/documents/stats` |
| `GET /api/search` | `GET SEARCH_SERVICE_URL/v1/search` |
| `GET /api/search/suggest` | `GET SEARCH_SERVICE_URL/v1/search/suggest` |

### File Upload Handling
- Uses `multer` with memory storage (no disk writes)
- Max file size: **100MB**
- Allowed MIME types: `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.*`, `text/csv`, `text/plain`
- BFF re-streams the file as `multipart/form-data` to Document Service
- The `metadata` part must be forwarded with `Content-Type: application/json`

### Request Tracing
Every request gets an `X-Correlation-ID` header (UUID) that is:
1. Attached on inbound request (or preserved if already present)
2. Propagated in all outbound calls to downstream services
3. Included in all Winston log lines
4. Returned in error responses

### Security Middleware (applied in order)
- `helmet()` — sets secure HTTP headers
- `cors({ origin: FRONTEND_URL })` — restricts CORS to frontend origin
- `express-rate-limit` — 200 requests/minute per IP
- Body parser: 2MB JSON limit

## Configuration

### Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | BFF listen port |
| `FRONTEND_URL` | `http://localhost:3000` | CORS allowed origin |
| `DOCUMENT_SERVICE_URL` | `http://localhost:8080` | Document Service base URL |
| `SEARCH_SERVICE_URL` | `http://localhost:8081` | Search Service base URL |
| `LOG_LEVEL` | `info` | Winston log level |
| `AZURE_AD_TENANT_ID` | — | Optional: Azure AD tenant |
| `AZURE_AD_CLIENT_ID` | — | Optional: Azure AD client |

Copy `.env.example` to `.env` for local development.

## Key Patterns

### Error Handling
Global error handler in `server.js` catches all unhandled errors and returns:
```json
{ "error": "message", "correlationId": "uuid" }
```
Use `express-async-handler` to wrap async route handlers so errors propagate to the global handler.

### Logging
Use the shared Winston logger from `src/utils/logger.js`:
```js
const logger = require('../utils/logger');
logger.info('message', { correlationId, ...extra });
```

### Adding a New Route
1. Add route file in `src/routes/`
2. Mount in `server.js`: `app.use('/api/newservice', require('./routes/newservice'))`
3. Add downstream URL to `.env.example` and update `apimClient.js` if needed

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
1. Build Docker image → `ghcr.io/vvaddineni/docvault-bff:latest` and `:<sha>`
2. Deploy to Azure Container App: `docvault-bff` in `docvault-dev-rg`
3. Injects `DOCUMENT_SERVICE_URL` and `SEARCH_SERVICE_URL` via `az containerapp update --set-env-vars`

Note: CI does **not** run `npm test` — add a test step if adding meaningful test coverage.

**Required GitHub Secrets**: `AZURE_CREDENTIALS`, `AZURE_RESOURCE_GROUP`, `GHCR_TOKEN`, `DOCUMENT_SERVICE_URL`, `SEARCH_SERVICE_URL`

## Docker

Single-stage build: Node.js 20-alpine.
- Non-root user: `appuser`
- Healthcheck: `wget http://localhost:4000/health` (30s interval, 5s timeout, 10s start period)
- Exposes port **4000**
