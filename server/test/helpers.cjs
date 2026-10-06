// Ayudas compartidas por las pruebas.
'use strict';

const net = require('net');

/** Un puerto libre que elige el sistema (evita choques entre servidores de prueba). */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

module.exports = { freePort };
