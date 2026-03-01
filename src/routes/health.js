// bff/src/routes/health.js
const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => res.json({
  service: 'docvault-bff',
  status:  'UP',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
}));

module.exports = router;
