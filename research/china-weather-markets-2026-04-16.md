# 中国天气事件梳理

更新时间：`2026-04-15 Asia/Shanghai`

## 范围

- 来源页：`https://polymarket.com/zh/weather`
- 事件类型：`Highest temperature in ... on April 16, 2026`
- 当前天气页一共提取到 `50` 个城市天气事件
- 其中当前明确属于中国大陆的城市共有 `7` 个
- 另外还有 `香港` 这一条中国相关事件；`台北` 当前也在全球天气页里，但我没有并入大陆城市组

## 中国大陆城市清单

| 城市 | 事件链接 | Polymarket 结算站点 | 站点代码 | 建议天气查询目标 | 备注 |
|---|---|---|---|---|---|
| 北京 | https://polymarket.com/zh/event/highest-temperature-in-beijing-on-april-16-2026 | Beijing Capital International Airport | `ZBAA` | 北京顺义为主，朝阳作辅助对照 | 首都机场的观测更接近机场站，不建议直接用北京市整体预报替代 |
| 上海 | https://polymarket.com/zh/event/highest-temperature-in-shanghai-on-april-16-2026 | Shanghai Pudong International Airport | `ZSPD` | 上海浦东新区 | 这条最直观，后面模拟可以直接先从浦东做 |
| 广州 | https://polymarket.com/zh/event/highest-temperature-in-guangzhou-on-april-16-2026 | Guangzhou Baiyun International Airport | `ZGGG` | 广州花都为主，白云作辅助对照 | 白云机场行政边界不够干净，花都更像主查询目标 |
| 深圳 | https://polymarket.com/zh/event/highest-temperature-in-shenzhen-on-april-16-2026 | Shenzhen Bao'an International Airport | `ZGSZ` | 深圳宝安区 | 机场站和区级预报相对容易对应 |
| 武汉 | https://polymarket.com/zh/event/highest-temperature-in-wuhan-on-april-16-2026 | Wuhan Tianhe International Airport | `ZHHH` | 武汉黄陂区 | 天河机场在黄陂方向，后面优先查黄陂 |
| 成都 | https://polymarket.com/zh/event/highest-temperature-in-chengdu-on-april-16-2026 | Chengdu Shuangliu International Airport | `ZUUU` | 成都双流区 | 这条应当直接按双流查 |
| 重庆 | https://polymarket.com/zh/event/highest-temperature-in-chongqing-on-april-16-2026 | Chongqing Jiangbei International Airport | `ZUCK` | 重庆渝北区 | 江北机场名称容易误导，实际更应查渝北 |

## 中国相关但单列

| 城市 | 事件链接 | Polymarket 结算站点 | 站点代码 | 建议天气查询目标 | 备注 |
|---|---|---|---|---|---|
| 香港 | https://polymarket.com/zh/event/highest-temperature-in-hong-kong-on-april-16-2026 | Hong Kong International Airport | `VHHH` | 香港国际机场 / 离岛区赤鱲角方向 | 我先单列，不并入大陆组 |

## 当前不在大陆城市组里的相关事件

- `Taipei`
  - 当前全球天气页里有：`https://polymarket.com/zh/event/highest-temperature-in-taipei-on-april-16-2026`
  - 先不并入“中国大陆城市”这份列表

## 这些站点是怎么抓出来的

- 不是手工猜的，是从每个 Polymarket 事件页的结算说明里直接抽出来的
- 事件页里明确写了结算站点，例如：
  - `Shanghai Pudong International Airport`
  - `Beijing Capital International Airport`
- 同时事件页里也附了 Wunderground 历史观测链接，因此可以反推出对应站点代码：
  - 上海：`ZSPD`
  - 北京：`ZBAA`
  - 广州：`ZGGG`
  - 深圳：`ZGSZ`
  - 武汉：`ZHHH`
  - 成都：`ZUUU`
  - 重庆：`ZUCK`
  - 香港：`VHHH`

## 对后面模拟的直接建议

- 第一版先只做中国大陆这 `7` 个城市
- 先不把香港和台北并进去，避免范围不清
- 预报源先按“机场所在区”的日最高温做代理，不直接拿整个城市总预报
- 北京和广州这两条最好保留一个“主查询区 + 辅助对照区”
  - 北京：顺义主查，朝阳辅助
  - 广州：花都主查，白云辅助

## 下一步

- 把这 `7` 个城市逐个接到中央气象台 / 中国天气网的查询源
- 固定在每天 `00:00` 左右记录当日最高温预报区间
- 用区间上沿作为目标温度，模拟买该温度档位的 `No`
- 每城每次 `1` 注，后面再统计命中率和收益
