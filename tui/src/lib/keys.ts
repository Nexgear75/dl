/**
 * Ink delivers keys typed in a fast burst as one string (e.g. "j\r\x15").
 * Split it into separate events: text runs, Enter, Tab, Esc and Ctrl-letter keys.
 */
export function splitBurst(input: string, key: any): [string, any][] {
  if (input.length <= 1 || key.ctrl || key.meta || !/[\x00-\x1f]/.test(input)) return [[input, key]];
  const out: [string, any][] = [];
  for (const part of input.split(/([\x00-\x1f])/)) {
    if (part === '') continue;
    const code = part.charCodeAt(0);
    if (part.length > 1 || code >= 0x20) out.push([part, {}]);
    else if (part === '\r' || part === '\n') out.push(['', { return: true }]);
    else if (part === '\t') out.push(['', { tab: true }]);
    else if (part === '\x1b') out.push(['', { escape: true }]);
    else if (code >= 1 && code <= 26) out.push([String.fromCharCode(code + 96), { ctrl: true }]);
  }
  return out;
}
