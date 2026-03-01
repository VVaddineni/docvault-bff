// bff/src/services/apimClient.js
// ============================================================
// Azure API Management Client
//
// All Spring Boot microservices are called exclusively through
// Azure APIM.  This module centralises:
//   - Subscription key injection (Ocp-Apim-Subscription-Key)
//   - Correlation ID forwarding
//   - Retry logic (3 attempts, exponential back-off)
//   - Timeout (30 s)
//   - Error normalisation
// ============================================================

const axios  = require('axios');
const logger = require('../utils/logger');

const APIM_ENDPOINT = process.env.APIM_ENDPOINT;  // https://docvault.azure-api.net
const APIM_KEY      = process.env.APIM_SUBSCRIPTION_KEY;

if (!APIM_ENDPOINT) {
  logger.warn('[APIM] APIM_ENDPOINT not set — downstream calls will fail');
}

// ── Axios instance wired to APIM ──────────────────────────────────────────
const apim = axios.create({
  baseURL: APIM_ENDPOINT,
  timeout: 30_000,
  headers: {
    'Ocp-Apim-Subscription-Key': APIM_KEY,
    'Content-Type':              'application/json',
  },
});

// ── Request interceptor: inject correlation ID + trace ────────────────────
apim.interceptors.request.use(config => {
  if (config._correlationId) {
    config.headers['X-Correlation-Id'] = config._correlationId;
  }
  logger.debug(`[APIM →] ${config.method?.toUpperCase()} ${config.baseURL}${config.url}`);
  return config;
});

// ── Response interceptor: log + normalise ─────────────────────────────────
apim.interceptors.response.use(
  res => {
    logger.debug(`[APIM ←] ${res.status} ${res.config.url}`);
    return res;
  },
  async err => {
    const cfg    = err.config;
    const status = err.response?.status;
    logger.warn(`[APIM ✗] ${status} ${cfg?.url}: ${err.message}`);

    // Retry on 429 (rate-limited by APIM) or 503 (service unavailable)
    cfg._retryCount = cfg._retryCount || 0;
    if ((status === 429 || status === 503) && cfg._retryCount < 3) {
      cfg._retryCount++;
      const backoff = cfg._retryCount * 1000;
      logger.info(`[APIM] Retrying (${cfg._retryCount}/3) after ${backoff}ms…`);
      await new Promise(r => setTimeout(r, backoff));
      return apim(cfg);
    }

    // Normalise APIM / downstream error into a standard shape
    const downstreamError  = err.response?.data;
    const normalised       = new Error(
      downstreamError?.message || downstreamError?.error || err.message
    );
    normalised.status      = status || 500;
    normalised.code        = downstreamError?.error || 'APIM_ERROR';
    normalised.downstream  = downstreamError;
    throw normalised;
  }
);

// ── Typed request helpers ─────────────────────────────────────────────────

/**
 * Forward a GET to APIM.
 * @param {string}  path          e.g. '/documents/v1/documents'
 * @param {object}  params        query string parameters
 * @param {string}  correlationId request trace ID
 */
async function get(path, params = {}, correlationId) {
  const res = await apim.get(path, { params, _correlationId: correlationId });
  return res.data;
}

/**
 * Forward a POST to APIM (JSON body).
 */
async function post(path, body = {}, correlationId) {
  const res = await apim.post(path, body, { _correlationId: correlationId });
  return res.data;
}

/**
 * Forward a PATCH to APIM.
 */
async function patch(path, body = {}, correlationId) {
  const res = await apim.patch(path, body, { _correlationId: correlationId });
  return res.data;
}

/**
 * Forward a DELETE to APIM.
 */
async function del(path, correlationId) {
  const res = await apim.delete(path, { _correlationId: correlationId });
  return res.data;
}

/**
 * Forward a multipart file upload to APIM.
 * @param {string}     path
 * @param {FormData}   formData    Node.js form-data instance
 * @param {string}     correlationId
 * @param {Function}   onUploadProgress
 */
async function upload(path, formData, correlationId, onUploadProgress) {
  const res = await apim.post(path, formData, {
    headers: {
      ...formData.getHeaders(),
      'Ocp-Apim-Subscription-Key': APIM_KEY,
      'X-Correlation-Id':          correlationId,
    },
    onUploadProgress,
    _correlationId: correlationId,
    timeout: 120_000,   // Allow up to 2 min for large files
  });
  return res.data;
}

module.exports = { get, post, patch, del, upload };
