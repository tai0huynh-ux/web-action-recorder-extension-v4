import('./electronSmoke.js').catch((error) => {
  console.error(error);
  process.exitCode = 1;
  const { app } = require('electron');
  app.quit();
});
