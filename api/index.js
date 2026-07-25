const app = require('../server.js');

module.exports = (req, res) => {
  try {
    if (req.url && !req.url.startsWith('/api')) {
      req.url = '/api' + (req.url.startsWith('/') ? '' : '/') + req.url;
    }
    return app(req, res);
  } catch (err) {
    console.error('[Vercel Function Error]', err);
    return res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
};
