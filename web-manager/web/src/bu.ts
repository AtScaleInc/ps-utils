/** The business unit the app works in. A BU is an isolated realm (its own Git
 * profile and dev/test/qa/prod hosts); the API scopes every call to the BU in
 * its `X-BU` header (api/envs/registry.py). The pick is remembered per browser. */

const KEY = 'envManager.bu'

function stored(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let current: string | null = stored()

export const getBu = () => current

export function setBu(id: string) {
  current = id
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // private window / blocked storage: the pick just isn't remembered
  }
}

function isApi(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const url = new URL(raw, window.location.origin)
  return url.origin === window.location.origin && url.pathname.startsWith('/api/')
}

/** api.ts, build/client.ts, test/api.ts and monitor/api.ts each call fetch
 * themselves; adding the header here, once, means none of them can forget it. */
export function installBuHeader() {
  const fetch = window.fetch.bind(window)
  window.fetch = (input, init) => {
    if (!current || !isApi(input)) return fetch(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set('X-BU', current)
    return fetch(input, { ...init, headers })
  }
}

/** A plain link (a download) sends no header: the BU goes in the query string. */
export function withBu(href: string): string {
  return current ? `${href}${href.includes('?') ? '&' : '?'}bu=${encodeURIComponent(current)}` : href
}
