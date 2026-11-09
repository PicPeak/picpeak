// Local preview of the gallery admin cleanup (not committed).
import base from './vite.config';

const cfg = base as { server: { proxy: Record<string, object> } } & Record<string, unknown>;
export default {
  ...cfg,
  server: {
    ...cfg.server,
    port: 5193,
    strictPort: true,
    proxy: Object.fromEntries(Object.entries(cfg.server.proxy).map(([k, v]) => [k, { ...v, target: 'http://localhost:3031' }])),
  },
};
