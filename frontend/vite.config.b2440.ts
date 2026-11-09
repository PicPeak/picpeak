// Local preview of the issue 2440 booking (not committed).
import base from './vite.config';

const cfg = base as { server: { proxy: Record<string, object> } } & Record<string, unknown>;
export default {
  ...cfg,
  server: {
    ...cfg.server,
    port: 5441,
    strictPort: true,
    proxy: Object.fromEntries(Object.entries(cfg.server.proxy).map(([k, v]) => [k, { ...v, target: 'http://localhost:3441' }])),
  },
};
