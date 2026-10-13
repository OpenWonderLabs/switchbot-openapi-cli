import { getCachedDevice } from "../devices/cache.js";
import { findCatalogEntry } from "../devices/catalog.js";
import { parseParameterForWire, validateParameter } from "../devices/param-validator.js";
import { resolveDeviceId } from "../utils/name-resolver.js";
import { fetchDeviceList, isDestructiveCommand, validateCommand } from "./devices.js";

export interface PlanPreflightCommandStep {
  type: "command";
  deviceId?: string;
  deviceName?: string;
  command: string;
  parameter?: unknown;
  commandType?: "command" | "customize";
}

export interface PlanPreflightOtherStep {
  type: "scene" | "wait";
}

export type PlanPreflightStep = PlanPreflightCommandStep | PlanPreflightOtherStep;

export interface PreparedPlanCommand {
  stepIndex: number;
  deviceId: string;
  deviceType: string;
  command: string;
  parameter: unknown;
  commandType: "command" | "customize";
  destructive: boolean;
}

export interface PlanPreflightFailure {
  ok: false;
  stepIndex: number;
  deviceId?: string;
  kind: "unknown-target" | "command-validation" | "parameter-validation";
  message: string;
  hint?: string;
  safetyCritical: boolean;
}

export interface PlanPreflightSuccess {
  ok: true;
  commands: PreparedPlanCommand[];
}

export type PlanPreflightResult = PlanPreflightSuccess | PlanPreflightFailure;

/**
 * Resolve, type-confirm, validate, and freeze every command target before a
 * plan starts dispatching mutations. A cold cache is refreshed only once.
 */
export async function preparePlanTargets(
  steps: readonly PlanPreflightStep[],
): Promise<PlanPreflightResult> {
  const commandSteps = steps
    .map((step, stepIndex) => ({ step, stepIndex }))
    .filter((entry): entry is { step: PlanPreflightCommandStep; stepIndex: number } => entry.step.type === "command");

  if (commandSteps.some(({ step }) => !step.deviceId || !getCachedDevice(step.deviceId))) {
    await fetchDeviceList();
  }

  const commands: PreparedPlanCommand[] = [];
  for (const { step, stepIndex } of commandSteps) {
    const deviceId = resolveDeviceId(step.deviceId, step.deviceName, { strategy: "require-unique" });
    const cached = getCachedDevice(deviceId);
    if (!cached) {
      return {
        ok: false,
        stepIndex,
        deviceId,
        kind: "unknown-target",
        message: `Unable to confirm target "${deviceId}" from the device inventory.`,
        hint: "Refresh the device list and use a known deviceId before running this plan.",
        safetyCritical: true,
      };
    }

    const catalog = findCatalogEntry(cached.type);
    if (!catalog || Array.isArray(catalog)) {
      return {
        ok: false,
        stepIndex,
        deviceId,
        kind: "unknown-target",
        message: `Unable to confirm the device type for "${deviceId}".`,
        hint: "Refresh the device list and use a target with a known catalog type before running this plan.",
        safetyCritical: true,
      };
    }

    const commandType = step.commandType ?? "command";
    const rawParameter = step.parameter === undefined
      ? undefined
      : typeof step.parameter === "string" ? step.parameter : JSON.stringify(step.parameter);
    const commandValidation = validateCommand(deviceId, step.command, rawParameter, commandType);
    if (!commandValidation.ok) {
      return {
        ok: false,
        stepIndex,
        deviceId,
        kind: "command-validation",
        message: commandValidation.error.message,
        hint: commandValidation.error.hint,
        safetyCritical: false,
      };
    }

    const command = commandValidation.normalized ?? step.command;
    let parameter = step.parameter;
    if (commandType === "command") {
      const parameterValidation = validateParameter(cached.type, command, rawParameter);
      if (!parameterValidation.ok) {
        return {
          ok: false,
          stepIndex,
          deviceId,
          kind: "parameter-validation",
          message: parameterValidation.error,
          hint: "Correct the parameter before running this plan.",
          safetyCritical: false,
        };
      }
      if (parameterValidation.normalized !== undefined) {
        parameter = parseParameterForWire(parameterValidation.normalized);
      }
    }

    commands.push({
      stepIndex,
      deviceId,
      deviceType: cached.type,
      command,
      parameter,
      commandType,
      destructive: isDestructiveCommand(cached.type, command, commandType),
    });
  }

  return { ok: true, commands };
}
