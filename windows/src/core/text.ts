// Plain-text helpers for what agents write.

/**
 * A possibly multi-line Markdown message as one line of plain text: only the
 * first non-empty paragraph (a blank line, a horizontal rule or a table row ends
 * it), without `**`, `__`, backticks, leading `#` or list markers.
 */
export function toOneLine(text: string, maxChars = 200): string {
  const trimWS = (s: string) => s.replace(/^[ \t]+|[ \t]+$/g, "");
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const t = trimWS(line);
    const isHR = t.length >= 3 && (/^-+$/.test(t) || /^\*+$/.test(t) || /^_+$/.test(t));
    if (t === "" || isHR || t.startsWith("|")) {
      if (current.length) paragraphs.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length) paragraphs.push(current);

  for (const para of paragraphs) {
    const s = para.join("\n").replaceAll("**", "").replaceAll("__", "").replaceAll("`", "");
    const processed: string[] = [];
    for (const line of s.split("\n")) {
      let l = trimWS(line.replace(/^#+/, ""));
      if (l.startsWith("- ") || l.startsWith("* ") || l.startsWith("• ")) l = l.slice(2);
      else l = l.replace(/^\d+\.\s+/, "");
      l = trimWS(l);
      if (l) processed.push(l);
    }
    const collapsed = processed.join(" ").split(/\s+/).filter(Boolean).join(" ");
    if (collapsed) return Array.from(collapsed).slice(0, maxChars).join("");
  }
  return "";
}
