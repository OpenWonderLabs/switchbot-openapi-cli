import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeviceHistoryStore } from "../../src/mcp/device-history.js";
import { withRequestContext } from "../../src/lib/request-context.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchbot-device-history-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  process.argv = ["node", "switchbot"];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("device history profile isolation", () => {
  it("keeps named histories isolated while the default profile uses the legacy directory", () => {
    const history = new DeviceHistoryStore();

    withRequestContext({ profile: "default" }, () => {
      history.record("DEV-1", "default/topic", "Bot", { owner: "default" }, "2026-10-12T00:00:00.000Z");
      expect(history.getHistoryDir()).toBe(path.join(tmpHome, ".switchbot", "device-history"));
    });

    withRequestContext({ profile: "alpha" }, () => {
      history.record("DEV-1", "alpha/topic", "Bot", { owner: "alpha" }, "2026-10-12T00:00:01.000Z");
    });

    const betaHistory = withRequestContext({ profile: "beta" }, () => history.getHistory("DEV-1"));
    const defaultHistory = withRequestContext({ profile: "default" }, () => history.getHistory("DEV-1"));

    expect(betaHistory).toEqual([]);
    expect(defaultHistory).toHaveLength(1);
    expect(defaultHistory[0]?.payload).toEqual({ owner: "default" });
  });
});
