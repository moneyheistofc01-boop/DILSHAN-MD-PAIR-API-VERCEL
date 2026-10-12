'use strict';

// Vercel catch-all function for /api/* routes.
// The Express app defines /api/health, /api/pair/start, and /api/session/:token.
const app = require('../server');

module.exports = app;
