import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { queryDeviceHistory } from "../../src/devices/history-query.js";
import { aggregateDeviceHistory } from "../../src/devices/history-agg.js";
import { withRequestContext } from "../../src/lib/request-context.js";

let tmpHome: string;

function writeRecord(file: string, owner: string, temperature: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    t: "2026-10-12T00:00:00.000Z",
    topic: "status",
    payload: { owner, temperature },
  }) + "\n");
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchbot-history-reader-"));
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
  process.argv = ["node", "switchbot"];
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("profile-scoped history readers", () => {
  it("keeps query and aggregate reads within the active profile directory", async () => {
    writeRecord(path.join(tmpHome, ".switchbot", "device-history", "DEV-1.jsonl"), "default", 10);
    writeRecord(path.join(tmpHome, ".switchbot", "profiles", "alpha", "device-history", "DEV-1.jsonl"), "alpha", 25);

    const alpha = await withRequestContext({ profile: "alpha" }, async () => ({
      records: await queryDeviceHistory("DEV-1"),
      aggregate: await aggregateDeviceHistory("DEV-1", { metrics: ["temperature"], aggs: ["avg"] }),
    }));
    const beta = await withRequestContext({ profile: "beta" }, async () => ({
      records: await queryDeviceHistory("DEV-1"),
      aggregate: await aggregateDeviceHistory("DEV-1", { metrics: ["temperature"], aggs: ["avg"] }),
    }));

    expect(alpha.records).toHaveLength(1);
    expect(alpha.records[0]?.payload).toEqual({ owner: "alpha", temperature: 25 });
    expect(alpha.aggregate.buckets[0]?.metrics.temperature?.avg).toBe(25);
    expect(beta.records).toEqual([]);
    expect(beta.aggregate.buckets).toEqual([]);
  });
});
