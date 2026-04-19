/**
 * Resolve MQTT broker config from environment variables.
 *
 * Required env vars:
 *   SWITCHBOT_MQTT_HOST      — broker hostname (e.g. mqtt.example.com)
 *   SWITCHBOT_MQTT_USERNAME  — MQTT username
 *   SWITCHBOT_MQTT_PASSWORD  — MQTT password
 *
 * Optional:
 *   SWITCHBOT_MQTT_PORT      — broker port (default 8883)
 */
export interface MqttConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export function getMqttConfig(): MqttConfig | null {
  const host = process.env.SWITCHBOT_MQTT_HOST;
  const username = process.env.SWITCHBOT_MQTT_USERNAME;
  const password = process.env.SWITCHBOT_MQTT_PASSWORD;

  if (!host || !username || !password) return null;

  const rawPort = process.env.SWITCHBOT_MQTT_PORT;
  const port = rawPort ? Number(rawPort) : 8883;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;

  return { host, port, username, password };
}
