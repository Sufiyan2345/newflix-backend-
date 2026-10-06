import 'dotenv/config';
import app, { initializeApp } from './server.js';

const start = async () => {
  await initializeApp();

  const port = process.env.PORT || 5000;
  const server = app.listen(port, () => {
    console.log(`StreamFlix API running on port ${port} [${process.env.NODE_ENV || 'development'}]`);
  });
  server.on('error', (err) => {
    console.error('Server failed to start:', err.message);
    process.exit(1);
  });
};

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
start().catch((err) => {
  console.error('Backend startup failed:', err.message);
  process.exit(1);
});
