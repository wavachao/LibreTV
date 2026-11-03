// Fork modification by wavachao (2026-11-03): preserve upstream failures and reject invalid playlists.
import { describe, expect, it, vi } from 'vitest';
import { handleProxyRequest } from './proxy-handlers';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./api-guard', () => ({ guardRequest: () => null, jsonError: (error: string, status: number) => Response.json({ error }, { status }) }));
vi.mock('./ssrf', () => ({ isValidProxyUrl: () => true, isBlockedByDNS: async () => false }));
vi.mock('./fetch-utils', () => ({ fetchWithSafeRedirects: mocks.fetch }));

describe('点播播放列表代理', () => {
  const target = 'https://cdn.example/video.m3u8?token=test';
  const req = new Request('https://libretv.example/api/proxy');
  it('保留 403 错误且不缓存，不把 HTML 错误页改写成 m3u8', async () => {
    mocks.fetch.mockResolvedValue({ res: new Response('<html>denied</html>', { status: 403 }), finalUrl: target });
    const res = await handleProxyRequest(req, target);
    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('HTTP 403');
  });
  it('拒绝状态 200 的伪播放列表', async () => {
    mocks.fetch.mockResolvedValue({ res: new Response('<html>blocked</html>'), finalUrl: target });
    expect((await handleProxyRequest(req, target)).status).toBe(502);
  });
  it('带鉴权参数的清单仍按重定向后的地址改写', async () => {
    mocks.fetch.mockResolvedValue({ res: new Response('#EXTM3U\n#EXTINF:10,\na.ts\n'), finalUrl: 'https://media.example/moved/video.m3u8?token=x' });
    const res = await handleProxyRequest(req, target);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(encodeURIComponent('https://media.example/moved/a.ts'));
  });
});
