/**
 * High-confidence credential shapes. Ordinary notes should not match.
 * Work text is stored after replacement. Memory writes that match are refused
 * so the secret is not written at all.
 */
const PATTERNS: { label: string; re: RegExp }[] = [
  { label: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "api key", re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g },
  { label: "connection key", re: /\brmk_[A-Za-z0-9_-]{8,}\b/g },
  { label: "aws access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "bearer token", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{12,}=*/gi },
  {
    label: "secret assignment",
    re: /\b(?:ROLEMEM_ADMIN_TOKEN|AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|LLM_API_KEY|DATABASE_URL)\s*=\s*\S+/gi,
  },
  {
    label: "credential assignment",
    re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/gi,
  },
];

export function secretFindings(text: string): string[] {
  const labels: string[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    if (pattern.re.test(text)) labels.push(pattern.label);
    pattern.re.lastIndex = 0;
  }
  return [...new Set(labels)];
}

export function redactSecrets(text: string): { text: string; redacted: boolean; labels: string[] } {
  let out = text;
  const labels: string[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    if (!pattern.re.test(out)) continue;
    labels.push(pattern.label);
    pattern.re.lastIndex = 0;
    out = out.replace(pattern.re, "[redacted]");
  }
  return { text: out, redacted: labels.length > 0, labels };
}
