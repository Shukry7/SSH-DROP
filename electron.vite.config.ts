import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  preload: { build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } } },
  renderer: {
    plugins: [
      react(),
      {
        name: 'sshdrop-csp',
        transformIndexHtml(html, context) {
          const scripts = context.server ? "'self' 'unsafe-inline'" : "'self'";
          const connect = context.server ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'none'";
          return html.replace(
            '__CSP__',
            `default-src 'none'; script-src ${scripts}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'; object-src 'none'`,
          );
        },
      },
    ],
  },
});
