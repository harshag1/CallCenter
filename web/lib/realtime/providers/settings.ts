export function settingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function providerTuning(
  settings: Record<string, unknown>,
  reserved: string[]
): Record<string, unknown> {
  const tuning = { ...settings };
  for (const key of reserved) delete tuning[key];
  return tuning;
}
