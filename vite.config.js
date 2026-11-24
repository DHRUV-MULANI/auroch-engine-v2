import { defineConfig } from 'vite';

const hosts = ['localhost', '127.0.0.1', 'auroch.dhruvmulani.com'];

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 6001, allowedHosts: hosts },
  preview: { host: '0.0.0.0', port: 6001, allowedHosts: hosts },
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false }
});
