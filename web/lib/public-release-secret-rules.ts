import { createHash } from "node:crypto";

/**
 * Every expression is compatible with both JavaScript RegExp and `git grep -E`.
 * Keep these high-signal: this gate is deliberately fail-closed, and exact-file
 * allowlisting exists for the rare synthetic fixture that cannot be fragmented.
 */
export const PUBLIC_RELEASE_SECRET_PATTERNS = Object.freeze([
  { patternClass: "openai_project_key", expression: "sk-proj-[A-Za-z0-9_-]{32,}" },
  { patternClass: "openai_service_account_key", expression: "sk-svcacct-[A-Za-z0-9_-]{32,}" },
  { patternClass: "openai_legacy_key", expression: "sk-[A-Za-z0-9]{40,}" },
  { patternClass: "anthropic_api_key", expression: "sk-ant-[A-Za-z0-9_-]{32,}" },
  { patternClass: "xai_api_key", expression: "xai-[A-Za-z0-9_-]{32,}" },
  { patternClass: "google_api_key", expression: "AIza[0-9A-Za-z_-]{35}" },
  { patternClass: "google_oauth_client_secret", expression: "GOCSPX-[0-9A-Za-z_-]{20,}" },
  { patternClass: "groq_api_key", expression: "gsk_[0-9A-Za-z]{32,}" },
  { patternClass: "github_token", expression: "gh[pousr]_[A-Za-z0-9]{36,255}" },
  { patternClass: "github_fine_grained_token", expression: "github_pat_[A-Za-z0-9_]{40,255}" },
  { patternClass: "aws_access_key", expression: "(AKIA|ASIA)[0-9A-Z]{16}" },
  { patternClass: "stripe_live_secret", expression: "sk_live_[0-9A-Za-z]{20,}" },
  { patternClass: "stripe_webhook_secret", expression: "whsec_[0-9A-Za-z]{24,}" },
  { patternClass: "resend_api_key", expression: "re_[0-9A-Za-z]{24,}" },
  { patternClass: "sendgrid_api_key", expression: "SG\\.[0-9A-Za-z_-]{22}\\.[0-9A-Za-z_-]{43}" },
  { patternClass: "slack_token", expression: "xox[baprs]-[0-9A-Za-z-]{20,}" },
  { patternClass: "npm_token", expression: "npm_[0-9A-Za-z]{32,}" },
  { patternClass: "huggingface_token", expression: "hf_[0-9A-Za-z]{32,}" },
  { patternClass: "replicate_token", expression: "r8_[0-9A-Za-z]{32,}" },
  {
    patternClass: "private_key_pem",
    expression: "-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----",
  },
  {
    patternClass: "jwt_credential",
    expression: "eyJ[0-9A-Za-z_-]{20,}\\.[0-9A-Za-z_-]{20,}\\.[0-9A-Za-z_-]{20,}",
  },
  {
    patternClass: "database_url_with_password",
    expression: "postgres(ql)?://[^:/ \\t\\r\\n]+:[^@/<>{} \\t\\r\\n]{12,}@",
  },
  {
    patternClass: "url_embedded_credentials",
    expression: "https?://[^:/ \\t\\r\\n]+:[^@/<>{} \\t\\r\\n]{12,}@",
  },
  {
    patternClass: "authorization_credential",
    expression: "(Bearer|Basic)[ \\t]+[0-9A-Za-z_.~+/-]{32,}",
  },
  {
    patternClass: "provider_secret_assignment",
    expression: [
      "^[ \\t]*(export[ \\t]+)?((const|let|var)[ \\t]+)?((ENV|ARG)[ \\t]+)?[ \\t]*[{]?[ \\t]*[\"']?(",
      "(TWILIO_AUTH_TOKEN|TWILIO_AUTH_TOKEN_NEXT|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY)",
      "[\"']?[ \\t]*(=|:)[ \\t]*[\"']?[0-9A-Fa-f]{32,64}[\"']?[ \\t]*,?[ \\t]*[}]?[ \\t]*[;]?[ \\t]*$|",
      "[\"']?(TWILIO_API_KEY_SECRET|TELEPHONY_RECEIPT_SECRET)",
      "[\"']?[ \\t]*(=|:)[ \\t]*[\"']?[^\"' \\t\\r\\n]{20,256}[\"']?[ \\t]*,?[ \\t]*[}]?[ \\t]*[;]?[ \\t]*$|",
      "[\"']?(AUTH_CODE_HMAC_SECRET|CAMPAIGN_COMMITMENT_SECRET|ENV_VAULT_MASTER_KEY|HACC_OUTBOUND_SPEECH_ASR_RECEIPT_HMAC_KEY|MCP_GATEWAY_SECRET|MCP_SCOPE_SECRET|SESSION_SECRET)",
      "[\"']?[ \\t]*(=|:)[ \\t]*[\"']?[0-9A-Za-z_+./=-]{32,256}[\"']?[ \\t]*,?[ \\t]*[}]?[ \\t]*[;]?[ \\t]*$|",
      "[\"']?AWS_SECRET_ACCESS_KEY[\"']?[ \\t]*(=|:)[ \\t]*[\"']?[0-9A-Za-z/+]{40}=?[\"']?[ \\t]*,?[ \\t]*[}]?[ \\t]*[;]?[ \\t]*$|",
      "[\"']?(AZURE_OPENAI_API_KEY|CARTESIA_API_KEY|CLOUDFLARE_API_TOKEN|LIVEKIT_API_SECRET|MISTRAL_API_KEY|TOGETHER_API_KEY|VERCEL_TOKEN)",
      "[\"']?[ \\t]*(=|:)[ \\t]*[\"']?[0-9A-Za-z_]{32,}[\"']?[ \\t]*,?[ \\t]*[}]?[ \\t]*[;]?[ \\t]*$)",
    ].join(""),
  },
  {
    patternClass: "json_oauth_credential",
    expression: "\"(access_token|client_secret|refresh_token|service_role_key)\"[ \\t]*:[ \\t]*\"[^\"<>{} \\t\\r\\n]{20,}\"",
  },
  {
    patternClass: "base64_provider_key",
    expression: "(c2stcHJvai|c2stc3ZjYWNjd|c2stYW50L|eGFpL|QUl6Y|Z3NrX|cmVf)[0-9A-Za-z+/]{28,}={0,2}",
  },
  {
    patternClass: "base64_private_key",
    expression: "LS0tLS1CRUdJTiB([0-9A-Za-z+/]{24,})",
  },
  {
    patternClass: "url_encoded_provider_key",
    expression: "(sk%2[dD](proj|svcacct|ant)%2[dD]|xai%2[dD])[0-9A-Za-z_%.-]{32,}",
  },
  {
    patternClass: "hex_encoded_provider_key",
    expression: "(736b2d70726f6a2d|736b2d616e742d|7861692d)[0-9A-Fa-f]{64,}",
  },
] as const);

export type PublicReleaseSecretPatternClass =
  typeof PUBLIC_RELEASE_SECRET_PATTERNS[number]["patternClass"];

export const PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES = Object.freeze([
  "private_environment_file",
  "private_key_material",
  "recording_or_transcript_data",
  "customer_or_runtime_data",
  "raw_benchmark_evidence",
  "sensitive_value_in_path",
] as const);

export type PublicReleaseSensitivePathClass =
  typeof PUBLIC_RELEASE_SENSITIVE_PATH_CLASSES[number];

export type PublicReleaseAllowlistableClass =
  | PublicReleaseSecretPatternClass
  | PublicReleaseSensitivePathClass;

const PUBLIC_ENV_TEMPLATE = /\.env(?:\.[^/]+)?\.(example|sample|template)$/i;
const PRIVATE_ENV = /(^|\/)\.env(?:$|\.)/i;
const KEY_MATERIAL = /(^|\/)(id_rsa|id_ed25519|credentials\.json|service[-_]account(?:\.[^/]*)?\.json|google[-_]credentials\.json)$|\.(pem|key|p12|pfx|jks|keystore)$/i;
const AUDIO_OR_CAPTURE = /\.(wav|mp3|m4a|aac|aiff?|caf|ogg|opus|flac|pcm|mulaw|ulaw|mp4|mov|webm|vtt|srt|har|pcap|pcapng)$/i;
const PRIVATE_DATA_EXTENSION = /\.(csv|tsv|jsonl|ndjson|parquet|xlsx?|sqlite3?|db|dump|bak|tar|tgz|zip|gz)$/i;
const PRIVATE_DATA_LOCATION = /(^|\/)(recordings?|call[-_]recordings?|transcripts?|call[-_]transcripts?|uploads?|exports?|dumps?|backups?|customer[-_]data|caller[-_]data|member[-_]data)(\/|$)/i;
const RECORDING_DATA_LOCATION = /(^|\/)(recordings?|call[-_]recordings?|transcripts?|call[-_]transcripts?)(\/|$)/i;
const CUSTOMER_DATA_LOCATION = /(^|\/)(uploads?|exports?|dumps?|backups?|customer[-_]data|caller[-_]data|member[-_]data)(\/|$)/i;
const SOURCE_CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|rs|go|java|kt|swift|c|cc|cpp|h|hpp|sql)$/i;
const PRIVATE_DATA_FILENAME = /(^|\/)(customer|caller|member|patient|contact|lead)[^/]*(data|export|dump|backup)[^/]*$/i;
const RAW_BENCHMARK = /(^|\/)benchmarks\/[^/]+\/(results|\.local|fixtures\/generated)(\/|$)/i;

export function sensitivePathClasses(path: string): PublicReleaseSensitivePathClass[] {
  const classes = new Set<PublicReleaseSensitivePathClass>();
  if (PRIVATE_ENV.test(path) && !PUBLIC_ENV_TEMPLATE.test(path)) {
    classes.add("private_environment_file");
  }
  if (KEY_MATERIAL.test(path)) classes.add("private_key_material");
  if (
    AUDIO_OR_CAPTURE.test(path)
    || RECORDING_DATA_LOCATION.test(path) && !SOURCE_CODE_EXTENSION.test(path)
  ) {
    classes.add("recording_or_transcript_data");
  }
  if (
    CUSTOMER_DATA_LOCATION.test(path)
    || PRIVATE_DATA_EXTENSION.test(path)
      && (PRIVATE_DATA_LOCATION.test(path) || PRIVATE_DATA_FILENAME.test(path))
  ) {
    classes.add("customer_or_runtime_data");
  }
  if (RAW_BENCHMARK.test(path)) classes.add("raw_benchmark_evidence");
  if (pathContainsReportableSensitiveValue(path)) classes.add("sensitive_value_in_path");
  return [...classes].sort();
}

export function secretPatternClasses(value: string): PublicReleaseSecretPatternClass[] {
  const classes: PublicReleaseSecretPatternClass[] = [];
  for (const rule of PUBLIC_RELEASE_SECRET_PATTERNS) {
    const expression = new RegExp(rule.expression, "gm");
    if (expression.test(value)) classes.push(rule.patternClass);
  }
  return classes;
}

export function isBinarySecretContent(value: Buffer): boolean {
  if (value.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
    return false;
  } catch {
    return true;
  }
}

/**
 * Search views shared by working-tree and reachable-history scanners. Binary
 * content is inspected as single-byte text and as UTF-16 LE/BE at both byte
 * alignments so a harmless prefix cannot hide an interleaved credential.
 */
export function secretSearchViews(value: Buffer, binary: boolean): string[] {
  if (!binary) return [value.toString("utf8")];
  const views = new Set<string>([value.toString("latin1")]);
  for (const offset of [0, 1]) {
    const slice = value.subarray(offset);
    if (slice.length >= 2) {
      views.add(slice.toString("utf16le"));
      const evenLength = slice.length - slice.length % 2;
      const swapped = Buffer.allocUnsafe(evenLength);
      for (let index = 0; index < evenLength; index += 2) {
        swapped[index] = slice[index + 1];
        swapped[index + 1] = slice[index];
      }
      views.add(swapped.toString("utf16le"));
    }
  }
  return [...views];
}

const PATH_EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PATH_USERINFO = /[A-Z][A-Z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
const PATH_PHONE = /(^|[^0-9])\+[1-9][0-9]{7,14}([^0-9]|$)/;
const PATH_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export function pathContainsReportableSensitiveValue(path: string): boolean {
  return PATH_EMAIL.test(path)
    || PATH_USERINFO.test(path)
    || PATH_PHONE.test(path)
    || PATH_CONTROL_CHARACTER.test(path);
}

/** Credential- or PII-like filenames must not themselves enter a report. */
export function safeReportedPath(path: string, forceRedaction = false): string {
  if (
    !forceRedaction
    &&
    secretPatternClasses(path).length === 0
    && !pathContainsReportableSensitiveValue(path)
  ) return path;
  const digest = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16);
  return `[REDACTED_PATH:${digest}]`;
}
