import type { DeviceConfig } from "../../../packages/protocol/src/index.ts";

/** Normalize routing fields before handlers build durable fingerprints or locks.
 * Never walk arbitrary env, command payloads, templates or user data. Unknown
 * names retain the existing handler's error/partial-batch behavior. */
export function canonicalDeviceArguments(input: unknown, devices: DeviceConfig[]): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const canonical = (name: unknown) => typeof name === "string"
    ? devices.find(d => [d.name, ...(d.aliases ?? [])].some(n => n.toLowerCase() === name.toLowerCase()))?.name ?? name
    : name;
  const result = { ...input } as Record<string, unknown>;
  for (const key of ["device", "sourceDevice", "destinationDevice", "relayDevice"]) {
    if (Object.hasOwn(result, key)) result[key] = canonical(result[key]);
  }
  if (Array.isArray(result.devices)) result.devices = result.devices.map(canonical);
  if (Array.isArray(result.items)) result.items = result.items.map(item => canonicalDeviceArguments(item, devices));
  return result;
}
