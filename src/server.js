// bff/src/server.js
// ============================================================
// DocVault — Node.js Backend-for-Frontend (BFF)
//
// Role: single entry-point for the React SPA.
//   1. Validates / enriches requests
//   2. Attaches Azure APIM subscription key
//   3. Forwards to appropriate Spring Boot microservice via APIM
//   4. Normalises responses back to the SPA
// ============================================================

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { v4: uuid } = require('uuid');

const logger            = require('./utils/logger');
const documentsRouter   = require('./routes/documents');
const searchRouter      = require('./routes/search');
const healthRouter      = require('./routes/health');

const app  = express();
const PORT = process.env.PORT || 4000;

// Trust ACA's load balancer so express-rate-limit can read X-Forwarded-For
app.set('trust proxy', 1);

// ── Security middleware ────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,  // React handles its own CSP
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin:      process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods:     ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
app.use('/api', rateLimit({
  windowMs: 60_000,
  max:      200,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests', retryAfter: 60 },
}));

// ── Request parsing ────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ────────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: msg => logger.http(msg.trim()) },
}));

// ── Correlation ID ─────────────────────────────────────────────────────────
// Attach a correlation ID to every request so it can be traced across
// BFF → APIM → Spring Boot microservices.
app.use((req, _res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuid();
  next();
});

// ── Routes ─────────────────────────────────────────────────────────────────
app.use('/api/documents', documentsRouter);
app.use('/api/search',    searchRouter);
app.use('/health',        healthRouter);

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ── Global error handler ────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error(`[${req.correlationId}] ${err.message}`, { stack: err.stack });
  if (res.headersSent) return; // client disconnected — can't send response
  const status = err.status || err.response?.status || 500;
  res.status(status).json({
    error:         err.code || 'INTERNAL_ERROR',
    message:       err.message || 'An unexpected error occurred',
    correlationId: req.correlationId,
  });
});

// ── Process-level safety nets ────────────────────────────────────────────────
// Prevent a single bad request from crashing the entire process.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — process will continue', { message: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
});

app.listen(PORT, () => {
  logger.info(`DocVault BFF running on port ${PORT}`);
  logger.info(`Document Service: ${process.env.DOCUMENT_SERVICE_URL || 'http://localhost:8080'}`);
  logger.info(`Search Service:   ${process.env.SEARCH_SERVICE_URL   || 'http://localhost:8081'}`);
});

module.exports = app;
