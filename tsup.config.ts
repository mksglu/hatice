import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'bin/hatice.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
});
