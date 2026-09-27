export function secureHttpUrl(raw: string, label = 'server URL'): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid HTTPS address`); }
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS (HTTP is allowed only for this device's loopback address)`);
  }
  return url;
}

export function safeBrowserUrl(raw: string): string {
  return secureHttpUrl(raw, 'URL').toString();
}
