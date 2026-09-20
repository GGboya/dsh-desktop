import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authenticateWebHost, forwardWebRequest, serveWebDocument } from '../src/web-document.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('serves the Web entry and assets without starting or contacting a Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-web-'))
  roots.push(root)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<html><head></head><body><script src="assets/entry.js"></script></body></html>')
  await writeFile(join(root, 'assets/entry.js'), 'globalThis.entryLoaded = true')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const response = await serveWebDocument(new Request('dsh-app://app/'), root)
  const html = await response.text()
  expect(html.indexOf('Promise.withResolvers()')).toBeLessThan(html.indexOf('assets/entry.js'))
  expect(await (await serveWebDocument(new Request('dsh-app://app/assets/entry.js'), root)).text()).toContain('entryLoaded')
  expect(fetch).not.toHaveBeenCalled()
  expect((await serveWebDocument(new Request('dsh-app://app/%2e%2e%2fprivate'), root)).status).toBe(403)
  expect((await serveWebDocument(new Request('dsh-app://app/missing.js'), root)).status).toBe(404)
})

it('requires the Host authentication exchange and retains only its cookie value', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 303, headers: { 'set-cookie': 'session=owned; HttpOnly; SameSite=Strict' } }))
    .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
  vi.stubGlobal('fetch', fetch)
  expect(await authenticateWebHost('http://127.0.0.1:1234/?token=owned')).toBe('session=owned')
  await expect(authenticateWebHost('http://127.0.0.1:1234/')).rejects.toThrow('authentication failed')
})

it('forwards upload bytes and cancellation with Host credentials while keeping the response streaming', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close() } })
  const fetch = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-encoding': 'gzip', 'set-cookie': 'private' } }))
  vi.stubGlobal('fetch', fetch)
  const request = Object.assign(new Request('dsh-app://app/api/upload?name=file', {
    method: 'POST', body: 'upload bytes', headers: { origin: 'dsh-app://app', cookie: 'untrusted' },
  }), { initiatorOrigin: 'dsh-app://app' })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/?token=secret', 'session=owned')
  const [target, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit]
  expect(target.href).toBe('http://127.0.0.1:1234/api/upload?name=file')
  expect(new Headers(init.headers).get('cookie')).toBe('session=owned')
  expect(new Headers(init.headers).get('origin')).toBeNull()
  expect(init.signal).toBe(request.signal)
  expect(init.body).toBe(request.body)
  expect(response.headers.get('set-cookie')).toBeNull()
  expect(response.headers.get('content-encoding')).toBeNull()
  expect(await response.text()).toBe('stream')
})

it('refuses another page origin without forwarding its request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const request = Object.assign(new Request('dsh-app://app/api/read', { headers: { origin: 'https://other.example' } }), { initiatorOrigin: 'dsh-app://app' })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')
  expect(response.status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['sources', 'operations/preview', 'operations/execute'])('forwards native Market %s without an Origin header', async path => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  // Electron protocol.handle supplies the initiator independently of HTTP headers.
  const request = Object.assign(new Request(`dsh-app://app/api/community-market/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }), { initiatorOrigin: 'dsh-app://app' })
  const response = await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned', 'native-token')
  expect(response.status).toBe(200)
  const headers = new Headers(fetch.mock.calls[0]![1].headers)
  expect(headers.get('origin')).toBe('http://127.0.0.1:1234')
  expect(headers.get('sec-fetch-site')).toBe('same-origin')
  expect(headers.get('cookie')).toBe('session=owned')
  expect(headers.get('x-dsh-desktop-renderer')).toBe('native-token')
})

it('preserves Market mutation authority only for the owned application origin', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const url = 'dsh-app://app/api/community-market/operations/preview'
  expect((await forwardWebRequest(new Request(url, { method: 'POST', body: '{}' }), 'http://127.0.0.1:1234/', 'session=owned')).status).toBe(403)
  expect(fetch).not.toHaveBeenCalled()
  const request = Object.assign(new Request(url, { method: 'POST', headers: { origin: 'dsh-app://app' }, body: '{}' }), { initiatorOrigin: 'dsh-app://app' })
  await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')
  const headers = new Headers(fetch.mock.calls[0]![1].headers)
  expect(headers.get('origin')).toBe('http://127.0.0.1:1234')
  expect(headers.get('sec-fetch-site')).toBe('same-origin')
  expect(headers.get('cookie')).toBe('session=owned')
})

it.each([undefined, 'null', 'https://other.example', 'dsh-app://shell', 'dsh-app://app.evil', 'dsh-app://app:1234'])(
  'rejects initiator %s even with app-looking headers and referrer', async initiatorOrigin => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = Object.assign(new Request('dsh-app://app/api/community-market/sources', {
      method: 'POST', body: '{}', referrer: 'dsh-app://app/',
      headers: { origin: 'dsh-app://app', 'sec-fetch-site': 'same-origin' },
    }), initiatorOrigin === undefined ? {} : { initiatorOrigin })
    expect((await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  },
)

it.each(['dsh-app://shell/api/read', 'dsh-app://app:1234/api/read', 'https://app/api/read'])(
  'does not forward credentials for another request authority: %s', async url => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const request = Object.assign(new Request(url), { initiatorOrigin: 'dsh-app://app' })
    expect((await forwardWebRequest(request, 'http://127.0.0.1:1234/', 'session=owned')).status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  },
)
