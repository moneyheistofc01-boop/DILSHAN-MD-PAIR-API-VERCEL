'use strict';

module.exports = function sessionLookupUnavailable(_req, res) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  return res.status(503).json({
    error: 'Session lookup requires persistent storage. Use the Render API URL configured with the included persistent disk.',
  });
};
