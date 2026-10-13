import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const homedirMock = vi.hoisted(() => vi.fn(() => "/tmp/switchbot-simulate-profile-initial"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

import os from "node:os";
import type { Rule } from "../../src/rules/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchbot-simulate-profile-"));
  homedirMock.mockReturnValue(tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("simulateRule profile isolation", () => {
  it("does not use global or another profile history for a beta simulation", async () => {
    const deviceId = "DEV-1";

    const against = path.join(tmpHome, "events.jsonl");
    fs.writeFileSync(against, JSON.stringify({
      source: "mqtt",
      event: "motion.detected",
      t: "2026-10-12T00:01:00.000Z",
      deviceId,
    }) + "\n");
    const rule: Rule = {
      name: "profile-check",
      when: { source: "mqtt", event: "motion.detected" },
      conditions: [{ device: deviceId, field: "t", op: "==", value: "2026-10-12T00:00:00.000Z" }],
      then: [{ command: "turnOn", device: "light" }],
    };

    // simulateRule caches os.homedir() at module initialization, so load it after the fixture home is set.
    const { simulateRule } = await import("../../src/rules/simulate.js");
    const { withRequestContext } = await import("../../src/lib/request-context.js");
    const { DeviceHistoryStore } = await import("../../src/mcp/device-history.js");
    new DeviceHistoryStore("default").record(deviceId, "status", "Bot", { openState: "CLOSE" }, "2026-10-12T00:00:00.000Z");
    new DeviceHistoryStore("alpha").record(deviceId, "status", "Bot", { openState: "CLOSE" }, "2026-10-12T00:00:00.000Z");

    const defaultReport = await withRequestContext({ profile: "default" }, () => simulateRule({ rule, against }));
    const report = await withRequestContext({ profile: "beta" }, () => simulateRule({ rule, against }));

    expect(defaultReport.wouldFire).toBe(1);

    expect(report.wouldFire).toBe(0);
    expect(report.blockedByCondition).toBe(1);
  });
});
