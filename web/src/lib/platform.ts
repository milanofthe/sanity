// Which webview the app is running in, for the few places a webview's own
// bugs have to be worked around rather than fixed.

/** The Linux webview: WebKit on Linux, and not Chromium, which says
 *  AppleWebKit too. */
export function isWebKitGTK(): boolean {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  return /Linux/.test(ua) && /AppleWebKit/.test(ua) && !/Chrom(e|ium)|Android/.test(ua);
}
