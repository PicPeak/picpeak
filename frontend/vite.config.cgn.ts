// Local preview of the CRM gallery notifications (not committed).
import base from './vite.config';

const cfg = base as { server: { proxy: Record<string, object> } } & Record<string, unknown>;
export default {
  ...cfg,
  server: {
    ...cfg.server,
    port: 5198,
    strictPort: true,
    proxy: Object.fromEntries(Object.entries(cfg.server.proxy).map(([k, v]) => [k, { ...v, target: 'http://localhost:3061' }])),
  },
};
