# 已实测的点播源配置

[sources.researched.json](sources.researched.json) 是本 fork 按用户要求整理的部署配置，非上游内置列表。2026-11-03 在部署端通过应用代理逐源验证：16 个源各至少一个影片或剧集成功解码视频帧。

将文件的 JSON 数组作为 `DEFAULT_SOURCES` 环境变量传入容器即可。现有部署请合并到自己的 Compose 覆盖配置，保留密码和其他环境变量。例如：

```yaml
services:
  libretv:
    environment:
      DEFAULT_SOURCES: ${DEFAULT_SOURCES:?请设置点播源 JSON}
```

```sh
export DEFAULT_SOURCES="$(cat config/sources.researched.json)"
docker compose config --quiet
docker compose up -d
```

刷新网页后，新出现的预置源自动勾选；用户已经主动关闭的源保持原设置。前 3 项顺序保留，避免现有观看记录的源标识发生变化。

光速、豪华、红牛等存在共享媒体片源，多个站名不等于独立的画质版本。暴风、量子、如意及其他源均发现过部分条目断链或超时；通过样本验证不能保证每个标题、每集或整片一直可播。猫眼已验证的部分影片为 3840 像素宽编码，不能据此证明原生 4K 或 HDR。

厂长、百度、虎牙、索尼本轮未通过解码验证；此前返回拒绝、无效响应或无法解析的其他候选源也未加入。直播源沿用部署者单独设置的 `DEFAULT_LIVE_SOURCES`。

如果接口正常但媒体被拒，应分别检查媒体域名的网络出口、清单、密钥和分片。当前服务器已验证的精确域名路由保留在部署端，不随源码发布代理配置或凭据。
