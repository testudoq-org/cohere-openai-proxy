// Vitest configuration with coverage enabled
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html'],
      include: ['src/**/*.mjs'],
      exclude: ['test/**', '**/*.test.mjs'],
    },
  },
});