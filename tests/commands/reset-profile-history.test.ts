import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const homedirMock = vi.hoisted(() => vi.fn(() => "/tmp/switchbot-reset-profile-initial"));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: homedirMock, default: { ...actual, homedir: homedirMock } };
});

import os from "node:os";
import { runCli } from "../helpers/cli.js";

let tmpHome: string;

function writeHistory(profile: string | undefined): string {
  const dir = profile === undefined
    ? path.join(tmpHome, ".switchbot", "device-history")
    : path.join(tmpHome, ".switchbot", "profiles", profile, "device-history");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "DEV-1.jsonl");
  fs.writeFileSync(file, "{}\n");
  return dir;
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "switchbot-reset-profile-"));
  homedirMock.mockReturnValue(tmpHome);
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("reset profile history isolation", () => {
  it("clears only the selected named profile history namespace", async () => {
    const defaultDir = writeHistory(undefined);
    const alphaDir = writeHistory("alpha");
    const betaDir = writeHistory("beta");
    const { registerResetCommand } = await import("../../src/commands/reset.js");

    const result = await runCli(registerResetCommand, [
      "--profile", "beta", "reset", "--yes", "--keep-credentials",
    ]);

    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(betaDir)).toBe(false);
    expect(fs.existsSync(alphaDir)).toBe(true);
    expect(fs.existsSync(defaultDir)).toBe(true);
  });
});
