import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/globalSetup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/sinks/**',              // I/O adapters — require live integration, no unit tests
        'src/commands/install.ts',   // system-level operations — require OS privilege
        'src/commands/uninstall.ts', // system-level operations — require OS privilege
      ],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 75,
        branches: 75,
        'src/commands/**': {
          lines: 75,
          branches: 75,
        },
      },
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
