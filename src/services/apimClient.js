// bff/src/services/apimClient.js
// ============================================================
// Direct Service Client
//
// Routes BFF requests to the appropriate microservice directly,
// without going through Azure APIM.
//
// Path routing (matches APIM convention so route files are unchanged):
//   /documents/v1/** → DOCUMENT_SERVICE_URL/v1/**
//   /search/v1/**    → SEARCH_SERVICE_URL/v1/**
// ============================================================

const axios  = require('axios');
const logger = require('../utils/logger');

const DOCUMENT_SERVICE_URL = process.env.DOCUMENT_SERVICE_URL || 'http://localhost:8080';
const SEARCH_SERVICE_URL   = process.env.SEARCH_SERVICE_URL   || 'http://localhost:8081';

if (!process.env.DOCUMENT_SERVICE_URL) {
  logger.warn('[Services] DOCUMENT_SERVICE_URL not set — defaulting to http://localhost:8080');
}
if (!process.env.SEARCH_SERVICE_URL) {
  logger.warn('[Services] SEARCH_SERVICE_URL not set — defaulting to http://localhost:8081');
}

// ── Shared axios factory ───────────────────────────────────────────────────
function makeClient(baseURL, name) {
  const client = axios.create({
    baseURL,
    timeout: 30_000,
    headers: { 'Content-Type': 'application/json' },
  });

  client.interceptors.request.use(config => {
    if (config._correlationId) {
      config.headers['X-Correlation-Id'] = config._correlationId;
    }
    logger.debug(`[${name} →] ${config.method?.toUpperCase()} ${baseURL}${config.url}`);
    return config;
  });

  client.interceptors.response.use(
    res => {
      logger.debug(`[${name} ←] ${res.status} ${res.config.url}`);
      return res;
    },
    async err => {
      const cfg    = err.config;
      const status = err.response?.status;
      logger.warn(`[${name} ✗] ${status ?? 'ERR'} ${cfg?.url}: ${err.message}`);

      // Retry on 503 (service temporarily unavailable)
      cfg._retryCount = cfg._retryCount || 0;
      if (status === 503 && cfg._retryCount < 3) {
        cfg._retryCount++;
        const backoff = cfg._retryCount * 1000;
        logger.info(`[${name}] Retrying (${cfg._retryCount}/3) after ${backoff}ms…`);
        await new Promise(r => setTimeout(r, backoff));
        return client(cfg);
      }

      // Normalise downstream error into a standard shape
      const downstreamError = err.response?.data;
      const normalised      = new Error(
        downstreamError?.message || downstreamError?.error || err.message
      );
      normalised.status     = status || 500;
      normalised.code       = downstreamError?.error || 'SERVICE_ERROR';
      normalised.downstream = downstreamError;
      throw normalised;
    }
  );

  return client;
}

const docClient    = makeClient(DOCUMENT_SERVICE_URL, 'DocSvc');
const searchClient = makeClient(SEARCH_SERVICE_URL,   'SearchSvc');

// ── Path router ───────────────────────────────────────────────────────────
// Strips the leading service-name segment that APIM used for routing.
// e.g. /documents/v1/documents → /v1/documents  (docClient)
//      /search/v1/search       → /v1/search      (searchClient)
function route(path) {
  if (path.startsWith('/documents/')) {
    return { client: docClient,    svcPath: path.slice('/documents'.length) };
  }
  if (path.startsWith('/search/')) {
    return { client: searchClient, svcPath: path.slice('/search'.length) };
  }
  // Fallback — send to document service as-is
  return { client: docClient, svcPath: path };
}

// ── Typed helpers — same API surface as the old apimClient ────────────────

async function get(path, params = {}, correlationId) {
  const { client, svcPath } = route(path);
  const res = await client.get(svcPath, { params, _correlationId: correlationId });
  return res.data;
}

async function post(path, body = {}, correlationId) {
  const { client, svcPath } = route(path);
  const res = await client.post(svcPath, body, { _correlationId: correlationId });
  return res.data;
}

async function patch(path, body = {}, correlationId) {
  const { client, svcPath } = route(path);
  const res = await client.patch(svcPath, body, { _correlationId: correlationId });
  return res.data;
}

async function del(path, correlationId) {
  const { client, svcPath } = route(path);
  const res = await client.delete(svcPath, { _correlationId: correlationId });
  return res.data;
}

async function upload(path, formData, correlationId) {
  const { client, svcPath } = route(path);
  const res = await client.post(svcPath, formData, {
    headers: {
      ...formData.getHeaders(),
      'X-Correlation-Id': correlationId,
    },
    _correlationId: correlationId,
    timeout: 120_000,   // 2 min for large file uploads
  });
  return res.data;
}

module.exports = { get, post, patch, del, upload };
