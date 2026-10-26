/**
 * Quarantine obvious prompt-injection phrasing in memories that arrive from
 * outside the operator (MCP clients and pasted exports). Prefer misses over
 * blocking ordinary notes. Native JSON import is not screened, so a round-trip
 * of the operator's own archive stays lossless.
 */
const RULES: { label: string; re: RegExp }[] = [
  { label: "ignore previous instructions", re: /(忽略|无视|忘掉|忘记)[^。\n]{0,8}(之前|以上|前面|上面|所有|全部|原有)[^。\n]{0,6}(指令|提示|设定|规则|要求)/ },
  { label: "ignore previous instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i },
  { label: "mentions the system prompt", re: /(系统提示词?|system\s*prompt|developer\s*(message|prompt))/i },
  { label: "forged role tag", re: /<\/?\s*(system|assistant|developer|ump:memory)\b[^>]*>/i },
  { label: "jailbreak phrasing", re: /(jailbreak|\bDAN\b|不受(任何)?限制的?(AI|助手|模型)|解除(所有)?限制)/i },
  { label: "asks for credentials", re: /(泄露|输出|发送|告诉我|打印)[^。\n]{0,10}(密钥|api[\s_-]?key|token|密码|凭证)/i },
  { label: "impersonates an admin", re: /(我是|作为)(平台|系统|管理员|开发者)[^。\n]{0,6}(要求|命令|指示)/ },
];

export function injectionFindings(text: string): string[] {
  return [...new Set(RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.label))];
}
