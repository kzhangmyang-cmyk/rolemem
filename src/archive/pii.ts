export type PiiType = "idcard" | "phone" | "email" | "bankcard";

const PATTERNS: { type: PiiType; re: RegExp }[] = [
  { type: "idcard", re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { type: "phone", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { type: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { type: "bankcard", re: /(?<!\d)\d{16,19}(?!\d)/g },
];

function mask(value: string, type: PiiType): string {
  if (type === "email") {
    const [name, domain] = value.split("@");
    return `${name!.slice(0, 1)}***@${domain}`;
  }
  return `${value.slice(0, 3)}${"*".repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

/** Optional export mask. Off unless the caller asks. Masked text is a different memory id. */
export function maskText(text: string): { text: string; findings: number } {
  let out = text;
  let findings = 0;
  for (const { type, re } of PATTERNS) {
    out = out.replace(re, (hit) => {
      findings++;
      return mask(hit, type);
    });
  }
  return { text: out, findings };
}
