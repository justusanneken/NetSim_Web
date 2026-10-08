import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** Fügt im Produktions-Build eine strikte CSP ein (Dev braucht Inline-Skripte für HMR). */
function csp(): Plugin {
  return {
    name: 'netsim-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
      ].join('; ');
      return html.replace(
        '<!--csp-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 900 },
  server: { port: 5173 },
});
