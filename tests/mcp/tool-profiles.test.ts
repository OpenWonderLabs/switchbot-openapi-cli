import { describe, expect, it } from 'vitest';
import { TOOL_PROFILES, resolveToolProfile, type ToolProfile } from '../../src/mcp/tool-profiles.js';
import { createSwitchBotMcpServer, listRegisteredTools } from '../../src/commands/mcp.js';
import { MCP_TOOLS } from '../../src/commands/capabilities.js';

describe('tool-profiles', () => {
  describe('TOOL_PROFILES sets', () => {
    it('readonly has 14 tools (core read only)', () => {
      expect(TOOL_PROFILES.readonly.size).toBe(14);
    });

    it('default has 17 tools (core read + action)', () => {
      expect(TOOL_PROFILES.default.size).toBe(17);
    });

    it('all has 28 tools', () => {
      expect(TOOL_PROFILES.all.size).toBe(28);
    });

    it('readonly is a subset of default', () => {
      for (const tool of TOOL_PROFILES.readonly) {
        expect(TOOL_PROFILES.default.has(tool)).toBe(true);
      }
    });

    it('default is a subset of all', () => {
      for (const tool of TOOL_PROFILES.default) {
        expect(TOOL_PROFILES.all.has(tool)).toBe(true);
      }
    });

    it('readonly excludes action tools', () => {
      expect(TOOL_PROFILES.readonly.has('send_command')).toBe(false);
      expect(TOOL_PROFILES.readonly.has('run_scene')).toBe(false);
      expect(TOOL_PROFILES.readonly.has('plan_run')).toBe(false);
    });

    it('default excludes admin tools', () => {
      expect(TOOL_PROFILES.default.has('policy_validate')).toBe(false);
      expect(TOOL_PROFILES.default.has('audit_query')).toBe(false);
      expect(TOOL_PROFILES.default.has('rules_suggest')).toBe(false);
    });
  });

  describe('resolveToolProfile', () => {
    it('returns default for undefined', () => {
      expect(resolveToolProfile(undefined)).toBe('default');
    });

    it('returns default for "default"', () => {
      expect(resolveToolProfile('default')).toBe('default');
    });

    it('returns readonly', () => {
      expect(resolveToolProfile('readonly')).toBe('readonly');
    });

    it('returns all', () => {
      expect(resolveToolProfile('all')).toBe('all');
    });

    it('throws on unknown profile', () => {
      expect(() => resolveToolProfile('bad')).toThrow(/Unknown tool profile "bad"/);
    });
  });

  describe('createSwitchBotMcpServer respects toolProfile', () => {
    it.each<[ToolProfile, number]>([
      ['readonly', 14],
      ['default', 17],
      ['all', 28], // 25 canonical + 3 deprecated device_history aliases
    ])('profile "%s" registers %d tools', (profile, expected) => {
      const server = createSwitchBotMcpServer({ toolProfile: profile });
      expect(listRegisteredTools(server)).toHaveLength(expected);
    });

    it('default profile includes send_command but not audit_query', () => {
      const server = createSwitchBotMcpServer({ toolProfile: 'default' });
      const tools = listRegisteredTools(server);
      expect(tools).toContain('send_command');
      expect(tools).not.toContain('audit_query');
    });

    it('readonly profile excludes all action tools', () => {
      const server = createSwitchBotMcpServer({ toolProfile: 'readonly' });
      const tools = listRegisteredTools(server);
      expect(tools).not.toContain('send_command');
      expect(tools).not.toContain('run_scene');
      expect(tools).not.toContain('plan_run');
    });
  });

  describe('capabilities MCP_TOOLS stays in sync with registered tools', () => {
    it('MCP_TOOLS matches the names registered under toolProfile=all', () => {
      const server = createSwitchBotMcpServer({ toolProfile: 'all' });
      const registered = [...listRegisteredTools(server)].sort();
      const advertised = [...MCP_TOOLS].sort();
      expect(advertised).toEqual(registered);
    });
  });
});
