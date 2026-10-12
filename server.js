// Export the Express app for Vercel-compatible adapters.
module.exports = app;

// Start a standalone server when running with Node.js.
if (require.main === module) {
  (async () => {
    try {
      await fs.mkdir(SESSION_DIR, { recursive: true });
      await fs.access(
        SESSION_DIR,
        fsSync.constants.R_OK | fsSync.constants.W_OK
      );

      app.listen(PORT, '0.0.0.0', () => {
        console.log(
          `[server] DILSHAN-MD Pair API listening on ${PORT}; session storage=${SESSION_DIR}`
        );
      });
    } catch (err) {
      console.error(
        'Could not initialize session storage:',
        err?.stack || err?.message || err
      );
      process.exit(1);
    }
  })();
}
