import crypto from 'crypto';

// GET /api/speed-test?bytes=N
//
// The footer links "Speed Test" to a page that has to report a real number, not
// a static paragraph, so this streams a known number of incompressible random
// bytes. The client times the transfer and divides by the elapsed seconds.
//
// `Cache-Control: no-store` matters: without it a proxy or the browser will
// serve a cached body and the measurement will be meaningless.
export const speedTest = (req, res) => {
  // Clamp hard — this endpoint is public, so an unbounded ?bytes must not be
  // able to be turned into a memory or bandwidth amplifier.
  const requested = Number(req.query.bytes);
  const bytes = Number.isFinite(requested)
    ? Math.min(Math.max(Math.trunc(requested), 1024), 8 * 1024 * 1024)
    : 1024 * 1024;

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(bytes));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');

  // One reusable random block. crypto.randomBytes is CPU-expensive at scale, so
  // it is generated once and written repeatedly — the payload is random, which
  // is what stops the response being compressed down to nothing.
  const block = crypto.randomBytes(64 * 1024);
  let sent = 0;
  let closed = false;

  req.on('close', () => { closed = true; });
  res.on('close', () => { closed = true; });

  const pump = () => {
    // A client that navigated away stops the transfer instead of us writing
    // into a dead socket.
    while (sent < bytes && !closed) {
      const size = Math.min(block.length, bytes - sent);
      sent += size;
      if (!res.write(size === block.length ? block : block.subarray(0, size))) {
        res.once('drain', pump);
        return;
      }
    }
    if (!closed) res.end();
  };

  pump();
};
