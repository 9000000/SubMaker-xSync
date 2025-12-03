// Placeholder worker for single-thread core (v12.10). The main ffmpeg-core.js does not require this, but it is exposed for completeness.
self.onmessage = (event) => {
  postMessage({ type: 'error', message: 'ffmpeg-core.worker.js placeholder loaded unexpectedly.' });
};
