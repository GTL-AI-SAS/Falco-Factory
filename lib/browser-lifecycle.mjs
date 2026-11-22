/** Hold one connection per browser tab; close Studio after the last tab leaves. */
export function browserLifecycle({ onIdle, isBusy = () => false, closeDelayMs = 3000,
  startupTimeoutMs = 60000, retryMs = 500, pingMs = 15000 } = {}) {
  const clients = new Set();
  let disposed = false;
  let timer;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (disposed || clients.size) return;
      if (isBusy()) { schedule(retryMs); return; }
      void onIdle();
    }, delay);
    timer.unref?.();
  }
  return {
    start() { schedule(startupTimeoutMs); },
    connect(response) {
      clearTimeout(timer);
      clients.add(response);
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      response.write(': connected\n\n');
      const ping = setInterval(() => response.write(': keepalive\n\n'), pingMs);
      ping.unref?.();
      response.on('close', () => {
        clearInterval(ping);
        clients.delete(response);
        if (!disposed && !clients.size) schedule(closeDelayMs);
      });
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const response of clients) response.end();
      clients.clear();
    }
  };
}
