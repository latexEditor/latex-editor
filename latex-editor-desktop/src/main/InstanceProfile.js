const fs = require('node:fs');
const path = require('node:path');

function acquireInstanceLock(app, dataDirectory, filesystem = fs) {
  // Electron scopes its Windows singleton to userData, not our settings path.
  // Set this before acquiring the lock (and before creating any sessions).
  // Keep the default Electron profile unchanged for existing installations.
  if (dataDirectory) {
    const profile = path.resolve(dataDirectory, 'electron');
    filesystem.mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  }
  return app.requestSingleInstanceLock();
}

module.exports = { acquireInstanceLock };
