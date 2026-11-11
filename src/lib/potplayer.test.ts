import { describe, expect, it } from 'vitest';
import {
  buildPotPlayerPlaylist,
  isDirectMediaUrl,
  looksLikeWindows,
  playlistFilename,
  potPlayerHref,
} from './potplayer';

describe('isDirectMediaUrl', () => {
  it('只接受 http/https 绝对地址', () => {
    expect(isDirectMediaUrl('https://cdn.example/a.m3u8?token=1&id=2')).toBe(true);
    expect(isDirectMediaUrl('http://10.0.0.8/live.ts')).toBe(true);
  });

  it('拒绝相对地址、协议相对地址和脚本地址', () => {
    expect(isDirectMediaUrl('/api/proxy?url=https%3A%2F%2Fx')).toBe(false);
    expect(isDirectMediaUrl('//cdn.example/a.m3u8')).toBe(false);
    expect(isDirectMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isDirectMediaUrl('potplayer://https://cdn.example/a.m3u8')).toBe(false);
  });
});

describe('potPlayerHref', () => {
  it('保留查询串，编码空格和井号', () => {
    expect(potPlayerHref('https://cdn.example/a.m3u8?token=1&id=2')).toBe(
      'potplayer://https://cdn.example/a.m3u8?token=1&id=2',
    );
    expect(potPlayerHref('https://cdn.example/my file.mp4#t=1')).toBe(
      'potplayer://https://cdn.example/my%20file.mp4%23t=1',
    );
  });

  it('非法地址不生成协议链接', () => {
    expect(potPlayerHref('/relative.m3u8')).toBeNull();
  });
});

describe('looksLikeWindows', () => {
  it('认 Windows NT 和 Win32/Win64', () => {
    expect(looksLikeWindows('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
    expect(looksLikeWindows('Mozilla/5.0', 'Win32')).toBe(true);
  });

  it('手机、macOS 和 Linux 不是 PotPlayer 的平台', () => {
    expect(looksLikeWindows('Mozilla/5.0 (Windows Phone 10.0)')).toBe(false);
    expect(looksLikeWindows('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(looksLikeWindows('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64')).toBe(false);
  });
});

describe('buildPotPlayerPlaylist', () => {
  it('生成 PotPlayer 能打开的 dpl，序号从 1 开始', () => {
    const text = buildPotPlayerPlaylist([
      { url: 'https://cdn.example/1.m3u8', title: '第一集' },
      { url: 'not a url', title: '丢掉' },
      { url: 'https://cdn.example/2.m3u8?a=1&b=2', title: '第二集\n*' },
    ]);
    expect(text).toBe(
      [
        'DAUMPLAYLIST',
        'playname=LibreTV',
        'topindex=0',
        'saveplaypos=0',
        '1*file*https://cdn.example/1.m3u8',
        '1*title*第一集',
        '1*played*0',
        '2*file*https://cdn.example/2.m3u8?a=1&b=2',
        '2*title*第二集',
        '2*played*0',
        '',
      ].join('\r\n'),
    );
  });

  it('地址里的星号改成百分号编码，避免被 dpl 当成分隔符', () => {
    const text = buildPotPlayerPlaylist([{ url: 'https://cdn.example/a*b.mp4', title: '片' }]);
    expect(text).toContain('1*file*https://cdn.example/a%2Ab.mp4');
  });

  it('没有可用地址时不生成文件', () => {
    expect(buildPotPlayerPlaylist([{ url: '/api/proxy?url=1', title: '代理' }])).toBeNull();
    expect(buildPotPlayerPlaylist([])).toBeNull();
  });
});

describe('playlistFilename', () => {
  it('去掉文件名里的非法字符', () => {
    expect(playlistFilename('名侦探 / 第一季: 上')).toBe('名侦探 第一季 上.dpl');
    expect(playlistFilename('   ')).toBe('LibreTV.dpl');
  });
});
