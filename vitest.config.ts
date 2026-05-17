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
        // Live infrastructure required: cannot be unit-tested
        'src/mcp/device-history.ts', // MCP streaming protocol (live server required)
        'src/mcp/events-subscription.ts', // MCP event subscription (live server required)
        'src/mqtt/client.ts', // MQTT broker required
        'src/llm/providers/anthropic.ts', // Anthropic API key + live endpoint required
        'src/llm/providers/openai.ts', // OpenAI API key + live endpoint required
      ],
      reporter: ['text', 'html'],
      // Thresholds locked to post-2026-05-17 backfill actuals.
      // Hard ceiling: see docs/coverage-annotations.md for excluded + structurally untestable files.
      thresholds: {
        lines: 81,
        branches: 79,
        'src/commands/**': {
          lines: 75,
          branches: 74,
        },
      },
    },
    clearMocks: true,
    restoreMocks: true,
  },
});
