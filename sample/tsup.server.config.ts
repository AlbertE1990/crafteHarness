import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server/index.ts'],
  outDir: 'dist-server',
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ['craft-harness', 'craft-harness/adapters'],
})
