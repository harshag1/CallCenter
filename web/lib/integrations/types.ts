export type IntegrationCategory = "voice" | "telephony" | "email" | "data" | "deployment";

export type IntegrationDefinition = {
  readonly id: string;
  readonly label: string;
  readonly category: IntegrationCategory;
  readonly description: string;
  readonly docsUrl: string;
  readonly requiredEnv: readonly string[];
  /** At least one complete alternative must be configured. */
  readonly alternativeEnv?: readonly (readonly string[])[];
  readonly optionalEnv?: readonly string[];
  readonly capabilities: readonly string[];
};
export type IntegrationStatus = IntegrationDefinition & {
  readonly configured: boolean;
  readonly missingEnv: readonly string[];
  readonly missingAlternatives: readonly (readonly string[])[];
};

export type IntegrationEnvironment = Readonly<Record<string, string | undefined>>;

export type IntegrationRegistry = Readonly<{
  definitions: readonly IntegrationDefinition[];
  statuses(environment?: IntegrationEnvironment): readonly IntegrationStatus[];
}>;
