const express = require('express');
const serverApp = require('../server.js');

const app = express();
app.use('/api', serverApp);
app.use('/', serverApp);

module.exports = app;
