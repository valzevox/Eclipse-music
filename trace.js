const fs = require('fs');
const { handleLyrics } = require('./src/server/server');
const fakeReq = { headers: {} };
const fakeRes = { writeHead: () => {}, end: (d) => console.log('Returned end:', d.substring(0, 80)) };
handleLyrics(fakeReq, fakeRes, 'LAVIAI', 'Wxrdie', true, 'auto', 180, null);
