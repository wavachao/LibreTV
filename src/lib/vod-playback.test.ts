import { describe, expect, it } from 'vitest';
import { resumeTime, vodMediaType } from './vod-playback';

describe('点播媒体选择与续播', () => {
  it('按实际媒体路径分流，忽略签名和查询参数中的伪扩展名', () => {
    expect(vodMediaType('https://cdn.example.com/video.MP4?signature=a#t=3')).toBe('file');
    expect(vodMediaType('https://cdn.example.com/video?next=abc.mp4')).toBe('unknown');
    expect(vodMediaType('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/a.m3u8?auth=1'))).toBe('hls');
  });

  it('换源可以保留几秒内的位置，片尾和无效位置从头播放', () => {
    expect(resumeTime(2.5, 22)).toBe(2.5);
    expect(resumeTime(14)).toBe(14);
    expect(resumeTime(21, 22)).toBe(0);
    expect(resumeTime(Infinity, 22)).toBe(0);
  });
});
