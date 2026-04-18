/**
 * Sensitive data redaction.
 *
 * Runs over extracted text BEFORE it's sent to LM Studio and BEFORE
 * summaries are written to .dovai/index/. Catches common secret patterns
 * (API keys, tokens, passwords, credit cards, private keys) and replaces
 * them with `[REDACTED]` markers.
 *
 * This is a best-effort safety net, not a guarantee. It prevents the most
 * common accidental leaks into the index where summaries live on disk.
 */

interface RedactPattern {
  pattern: RegExp;
  label: string;
}

const PATTERNS: RedactPattern[] = [
  // Private keys (must come first — multi-line)
  {
    pattern: /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/g,
    label: "PRIVATE_KEY",
  },
  // JWT tokens (three dot-separated base64 segments)
  { pattern: /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+\b/g, label: "JWT" },
  // OpenAI / Anthropic API keys
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, label: "API_KEY" },
  { pattern: /\b(sk-ant-[a-zA-Z0-9_-]{20,})\b/g, label: "API_KEY" },
  // Slack tokens
  { pattern: /\b(xoxb-[a-zA-Z0-9-]+)\b/g, label: "SLACK_TOKEN" },
  { pattern: /\b(xoxp-[a-zA-Z0-9-]+)\b/g, label: "SLACK_TOKEN" },
  // GitHub tokens
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, label: "GITHUB_TOKEN" },
  { pattern: /\b(gho_[a-zA-Z0-9]{36,})\b/g, label: "GITHUB_TOKEN" },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g, label: "GITHUB_TOKEN" },
  // AWS access keys
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, label: "AWS_KEY" },
  // Bearer tokens in headers
  { pattern: /Bearer\s+[a-zA-Z0-9._\-]{20,}/gi, label: "BEARER_TOKEN" },
  // Google App Passwords (four groups of four lowercase letters)
  { pattern: /\b[a-z]{4}\s[a-z]{4}\s[a-z]{4}\s[a-z]{4}\b/g, label: "APP_PASSWORD" },
  // Telegram bot tokens (numeric:alphanumeric)
  { pattern: /\b\d{8,10}:[a-zA-Z0-9_-]{35}\b/g, label: "BOT_TOKEN" },
  // Generic "password = ..." or "secret: ..." in config-style text
  {
    pattern: /(?:password|passwd|secret|token|api_key|apikey|auth_token|private_key|client_secret)\s*[:=]\s*["']?[^\s"'\n]{8,}["']?/gi,
    label: "CREDENTIAL",
  },
  // Credit card numbers (13-19 digits, optionally separated by spaces or dashes)
  { pattern: /\b(?:\d{4}[\s-]?){3,4}\d{1,4}\b/g, label: "CREDIT_CARD" },
];

export interface RedactResult {
  /** The text with secrets replaced by [LABEL REDACTED] markers */
  text: string;
  /** List of labels for what was redacted (for logging) */
  redacted: string[];
}

/**
 * Redact sensitive data from text. Returns a new string with secrets replaced
 * and a list of what was found (for audit logging).
 */
export function redact(text: string): RedactResult {
  const redacted: string[] = [];
  let result = text;

  for (const { pattern, label } of PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      redacted.push(label);
      return `[${label} REDACTED]`;
    });
  }

  return { text: result, redacted };
}

/**
 * Quick check: does the text likely contain sensitive data?
 * Cheaper than full redaction — use to decide whether to log a warning.
 */
export function containsSensitiveData(text: string): boolean {
  for (const { pattern } of PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
