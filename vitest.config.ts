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
        // Hard-ceiling: require live infrastructure, not unit-testable
        'src/mcp/device-history.ts',       // MCP streaming protocol (live server required)
        'src/mcp/events-subscription.ts',  // MCP event subscription (live server required)
        'src/mqtt/client.ts',              // MQTT broker required
        'src/llm/providers/anthropic.ts',  // Anthropic API key + live endpoint required
        'src/llm/providers/openai.ts',     // OpenAI API key + live endpoint required
      ],
      reporter: ['text', 'html'],
      // Thresholds locked to post-2026-05-16 backfill actuals.
      // Remaining ceiling: rules.ts (57%), mcp.ts (68%) require live infrastructure.
      thresholds: {
        lines: 79,
        branches: 79,
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
