// bff/src/routes/search.js
const express = require('express');
const asyncH  = require('express-async-handler');
const apim    = require('../services/apimClient');

const router  = express.Router();

// GET /api/search?q=&department=&tier=&dateFrom=&dateTo=&from=0&size=20
router.get('/', asyncH(async (req, res) => {
  const { q = '*', department, tier, dateFrom, dateTo, from = 0, size = 20 } = req.query;
  const data = await apim.get('/search/v1/search', { q, department, tier, dateFrom, dateTo, from, size }, req.correlationId);
  res.json(data);
}));

// GET /api/search/suggest?q=prefix
router.get('/suggest', asyncH(async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ suggestions: [] });
  const data = await apim.get('/search/v1/suggest', { q }, req.correlationId);
  res.json(data);
}));

module.exports = router;
