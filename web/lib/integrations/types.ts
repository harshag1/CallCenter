export type IntegrationCategory = "voice" | "telephony" | "email" | "data" | "deployment";

export type IntegrationDefinition = {
  id: string;
  label: string;
  category: IntegrationCategory;
  description: string;
  docsUrl: string;
  requiredEnv: string[];
  /** At least one complete alternative must be configured. */
  alternativeEnv?: string[][];
  optionalEnv?: string[];
  capabilities: string[];
};
export type IntegrationStatus = IntegrationDefinition & {
  configured: boolean;
  missingEnv: string[];
  missingAlternatives: string[][];
};
