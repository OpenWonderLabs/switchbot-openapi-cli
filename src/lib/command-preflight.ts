import { getCachedDevice } from "../devices/cache.js";
import { validateCommand } from "./devices.js";
import { validateParameter } from "../devices/param-validator.js";

export type CommandPreflightKind =
  | "unknown-device"
  | "unknown-device-type"
  | "read-only-device"
  | "unknown-command"
  | "unexpected-parameter"
  | "missing-parameter"
  | "param-out-of-range"
  | "inconsistent-normalization";

export interface PreflightedCommandTarget {
  deviceId: string;
  command: string;
  parameter: string | undefined;
}

export interface CommandPreflightFailure {
  ok: false;
  deviceId: string;
  kind: CommandPreflightKind;
  message: string;
  hint?: string;
}

export interface CommandPreflightSuccess {
  ok: true;
  command: string;
  targets: PreflightedCommandTarget[];
}

export type CommandPreflightResult = CommandPreflightSuccess | CommandPreflightFailure;

/**
 * Validate every cached target before a multi-device command is dispatched.
 * The returned command and per-target parameter values are normalized and may
 * be frozen by a caller before it begins execution.
 */
export function preflightCommandTargets(
  targetIds: readonly string[],
  command: string,
  parameter: string | undefined,
  commandType: "command" | "customize",
): CommandPreflightResult {
  const cachedTargets: Array<{ deviceId: string; deviceType: string }> = [];
  let normalizedCommand: string | undefined;

  for (const deviceId of targetIds) {
    const cached = getCachedDevice(deviceId);
    if (!cached) {
      return {
        ok: false,
        deviceId,
        kind: "unknown-device",
        message: `Unknown deviceId "${deviceId}" — not in local cache. Run "switchbot devices list" first.`,
        hint: "Refresh the device list before issuing a batch command.",
      };
    }

    const validation = validateCommand(deviceId, command, parameter, commandType);
    if (!validation.ok) {
      return {
        ok: false,
        deviceId,
        kind: validation.error.kind,
        message: validation.error.message,
        hint: validation.error.hint,
      };
    }

    const targetCommand = validation.normalized ?? command;
    if (normalizedCommand !== undefined && normalizedCommand !== targetCommand) {
      return {
        ok: false,
        deviceId,
        kind: "inconsistent-normalization",
        message: `Command "${command}" resolves differently across batch targets.`,
        hint: "Use the canonical command name supported by every target.",
      };
    }
    normalizedCommand = targetCommand;
    cachedTargets.push({ deviceId, deviceType: cached.type });
  }

  const effectiveCommand = normalizedCommand ?? command;
  const targets: PreflightedCommandTarget[] = [];
  for (const target of cachedTargets) {
    let normalizedParameter = parameter;
    if (commandType === "command") {
      const parameterValidation = validateParameter(target.deviceType, effectiveCommand, parameter);
      if (!parameterValidation.ok) {
        return {
          ok: false,
          deviceId: target.deviceId,
          kind: "param-out-of-range",
          message: parameterValidation.error,
          hint: "Correct the parameter before running this batch.",
        };
      }
      normalizedParameter = parameterValidation.normalized ?? parameter;
    }
    targets.push({
      deviceId: target.deviceId,
      command: effectiveCommand,
      parameter: normalizedParameter,
    });
  }

  return { ok: true, command: effectiveCommand, targets };
}
