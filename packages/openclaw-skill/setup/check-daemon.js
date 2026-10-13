// setup/check-daemon.js — 若 policy 启用了 automation，确保 daemon 正在运行
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { switchbotInvocation } from './cli-invocation.js';

const exec = promisify(execFile);

async function automationEnabled() {
  try {
    const invocation = switchbotInvocation(['daemon', 'status', '--json']);
    const { stdout } = await exec(invocation.command, invocation.args, { timeout: 8000 });
    const data = JSON.parse(stdout);
    // daemon 已在运行，无需再检查 policy
    if (data?.data?.running === true || data?.running === true) return { needed: false };
  } catch {
    // daemon 命令失败或未运行，继续检查 policy
  }

  // 尝试读取 rules list 来判断是否有激活的规则
  try {
    const invocation = switchbotInvocation(['rules', 'list', '--json']);
    const { stdout } = await exec(invocation.command, invocation.args, { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    const data = parsed?.data ?? parsed;
    const rules = data?.rules;
    if (data?.automationEnabled === true && Array.isArray(rules) && rules.some((rule) => rule?.enabled !== false)) {
      return { needed: true };
    }
  } catch {
    // 无法确认，保守处理：不强行启动
  }

  return { needed: false };
}

export async function checkDaemon() {
  const { needed } = await automationEnabled();
  if (!needed) return { ok: true };

  process.stderr.write('[switchbot-channel] 检测到自动化规则，正在启动规则引擎 daemon…\n');
  try {
    const invocation = switchbotInvocation(['daemon', 'start']);
    execFileSync(invocation.command, invocation.args, { stdio: ['ignore', 2, 2], timeout: 30_000 });
    process.stderr.write('[switchbot-channel] daemon 已启动。\n');
  } catch (err) {
    // daemon 启动失败不应阻塞 channel，仅打印警告
    process.stderr.write(
      `[switchbot-channel] 警告：daemon 启动失败（${err instanceof Error ? err.message : String(err)}）。自动化规则暂不生效，可手动运行 switchbot daemon start。\n`,
    );
  }

  return { ok: true };
}
