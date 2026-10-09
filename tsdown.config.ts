import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/tinyglobby.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  platform: 'node',
  target: 'node20',
  clean: true,
})
