# Polymarket BTC 监控与交易后台

这是一个围绕 Polymarket BTC 涨跌事件构建的本地后台，当前包含三条主链路：

- 监控：按 `5M / 15M / 1H / 4H` 周期采样并生成汇总
- 下单：按策略独立运行，当前默认启用 `1H`
- 结算：独立扫描可卖仓位与可领取仓位，优先走 API

首页是统一后台入口，可以查看：

- 监控列表
- 下单小时汇总
- 订单明细
- 结算日志

## 目录说明

主要目录：

- `app/`：Next.js 后台页面
- `scripts/`：监控、下单、结算脚本
- `data/events/`：原始监控采样数据
- `data/summaries/`：监控汇总结果
- `data/orders/`：下单状态、报表、结算日志

主要启动文件：

- `run-monitor.bat`：启动监控
- `run-order.bat`：启动下单
- `run-settlement.bat`：启动结算

## 后台页面

启动前端：

```bash
npm run dev
```

打开：

```text
http://localhost:3000
```

监控页当前支持：

- 最近 15 天筛选
- 分页
- `5M / 15M / 1H / 4H` 切换
- 阈值命中汇总
- 首次触发时间
- 采样健康度

## 监控

统一启动全部监控：

```bash
npm run monitor
```

或直接双击：

```text
run-monitor.bat
```

当前默认采样参数：

- `5M`：每 `3` 秒采样一次，有效覆盖至少 `4.5` 分钟
- `15M`：每 `5` 秒采样一次，有效覆盖至少 `13` 分钟
- `1H`：每 `5` 秒采样一次，有效覆盖至少 `50` 分钟
- `4H`：每 `15` 秒采样一次，有效覆盖至少 `210` 分钟

可单独启动某个周期：

```bash
npm run monitor:15m
npm run monitor:1h
npm run monitor:4h
```

## 下单

启动下单：

```bash
npm run order
```

或直接双击：

```text
run-order.bat
```

### 1H 默认策略

- 首单阈值：`<= 38c`
- 对冲阈值：`<= 38c`
- 首单最晚剩余时间：`30` 分钟
- 默认金额：`$1`
- 如果上一有效小时没有同时出现上下两侧 `<= 38c`，下一小时切到 `$2`
- 一旦某小时再次出现上下两侧都 `<= 38c`，下一小时恢复 `$1`

### 5M 备用策略

`5M` 代码已经接入，并且现在会跟 `1H` 一起由 `run-order.bat` / `npm run order` 同时拉起。两条策略是两个独立进程：

- `1H` 崩了只重启 `1H`
- `5M` 崩了只重启 `5M`
- 两边各自写自己的 runtime-state，不互相覆盖

当前内置默认值：

- 首单阈值：`<= 30c`
- 对冲阈值：`<= 50c`
- 首单最晚剩余时间：`1.5` 分钟
- 如果脚本重启后进入当前 `5M` 窗口时剩余时间已经少于 `4.5` 分钟，则这一根直接跳过，等下一根
- 固定金额：每边 `$1`
- 不使用 `1 -> 2` 翻倍
- 风控：滚动 `12` 小时净值 `<= -$10` 时，暂停 `8` 小时

如需单独运行 `5M` 路径：

```bash
npm run order:5m
```

如需只跑 `1H` 调试：

```bash
npm run order:1h
```

脚本会优先读取 `ORDER_5M_*`，没有配置时自动使用上面的默认值；不会被 `1H` 的全局 `ORDER_*` 参数误覆盖。

## 结算

启动结算：

```bash
npm run settlement
```

或直接双击：

```text
run-settlement.bat
```

当前结算逻辑：

- 独立于下单运行，不混在 `run-order.bat`
- 通过 `run-settlement.bat` 单独启动
- `run-settlement.bat` / `npm run settlement` 现在会守护 `auto_redeem.py`，如果结算进程异常退出会在 `5` 秒后自动重启
- 优先扫描本地策略小时单对应的持仓
- 到价后自动卖出
- 每轮最多卖 `1` 笔
- 默认每 `5` 分钟扫描一次
- 可领取仓位走 API 自动领取

自动卖出说明：

- 不读取页面 DOM
- 先读 `positions` API 中的 `curPrice / currentValue`
- 再用真实 orderbook 可成交价做二次确认
- 当前默认卖出阈值是 `99.9c`

## 配置

建议把运行配置放到：

```text
.env.order
```

脚本按下面顺序加载：

1. `.env.order.local`
2. `.env.order`
3. `.env.local`
4. `.env`

常用 `1H` 下单配置：

```env
ORDER_DRY_RUN=true
ORDER_VARIANT=1h
ORDER_BASE_USD=2
ORDER_ESCALATED_USD=3
ORDER_FIRST_ENTRY_CENTS=38
ORDER_HEDGE_ENTRY_CENTS=38
ORDER_MIN_FIRST_ENTRY_MINUTES_REMAINING=30
ORDER_MIN_BALANCE_USD=2
```

常用 `5M` 覆盖配置：

```env
ORDER_5M_FIRST_ENTRY_CENTS=30
ORDER_5M_HEDGE_ENTRY_CENTS=50
ORDER_5M_MIN_FIRST_ENTRY_MINUTES_REMAINING=1.5
ORDER_5M_MIN_STARTUP_MINUTES_REMAINING=4.5
ORDER_5M_BASE_USD=1
ORDER_5M_ESCALATED_USD=1
ORDER_5M_RISK_PAUSE_ENABLED=true
ORDER_5M_RISK_WINDOW_HOURS=12
ORDER_5M_RISK_MAX_LOSS_USD=10
ORDER_5M_RISK_PAUSE_HOURS=8
```

常用结算配置：

```env
ORDER_SETTLEMENT_IDLE_INTERVAL_MS=300000
ORDER_SETTLEMENT_ACTIVE_INTERVAL_MS=300000
ORDER_SETTLEMENT_MAX_SELLS_PER_RUN=1
ORDER_SETTLEMENT_MAX_CLAIMS_PER_RUN=0
ORDER_AUTO_REDEEM_TRACKED_ONLY=true
ORDER_AUTO_SELL_ENABLED=true
ORDER_AUTO_SELL_TARGET_CENTS=99.9
ORDER_CLOB_HTTP2=false
ORDER_CLOB_HTTP_TIMEOUT_MS=15000
ORDER_5M_EXECUTION_GUARD_ENABLED=true
ORDER_5M_EXECUTION_GUARD_LOOKBACK=5
ORDER_5M_EXECUTION_GUARD_MAX_FAILURES=2
ORDER_5M_EXECUTION_GUARD_PAUSE_HOURS=8
```

账户相关配置：

```env
POLY_PRIVATE_KEY=
POLY_FUNDER=
POLY_SIGNATURE_TYPE=
```

兼容别名：

- `PK`
- `PORTFOLIO_PRIVATE_KEY`
- `FUNDER`
- `POLY_*`
- `CLOB_*`

## 报表与日志

下单报表：

- `data/orders/reports/hour-details.json`
- `data/orders/reports/order-details.json`
- `data/orders/reports/summary.json`

结算日志：

- `data/orders/redeems/auto-redeem-log.jsonl`

监控数据：

- 原始采样：`data/events/`
- 汇总结果：`data/summaries/`

## 保留策略

监控原始数据和汇总数据按周期分别保留：

- `5M`：原始 `7` 天，汇总 `60` 天
- `15M`：原始 `14` 天，汇总 `90` 天
- `1H`：原始 `30` 天，汇总 `180` 天
- `4H`：原始 `60` 天，汇总 `365` 天

## 日常操作

平时只需要记住这三个入口：

```text
run-monitor.bat
run-order.bat
run-settlement.bat
```

对应职责：

- `run-monitor.bat`：持续监控并写入后台数据
- `run-order.bat`：当前会同时启动 `1H + 5M`
- `run-settlement.bat`：单独处理到价卖出和可领取检测

---

## 天气事件后台（2026-06-17 实现）

天气事件后台是独立于 BTC 监控的另一条链路，围绕 Polymarket 高温预测市场构建。入口在首页切换到「天气」surface，包含两个 Tab：

- **实盘明细**（`weatherTab=live`）：收益指标卡、服务启停、下单明细表、模拟策略对比
- **城市温差**（`weatherTab=review`）：实盘收益指标卡 + 国内外城市温差条带图

### 数据文件

所有天气数据位于 `data/weather_predictions/`：

| 文件 | 用途 |
|------|------|
| `records.json` | 抓取的预报 + Polymarket 市场快照（核心数据源） |
| `live-orders.json` | 实盘订单（当前为空，因为 `executionMode=simulation`） |
| `sim-orders.json` | 模拟订单（策略 A：0度偏移；策略 B：跟昨天偏差） |
| `records-midday-no95.json` | 中午时段扫描记录（价格 > 0.95 跳过） |
| `records-threshold-sim.json` | 阈值模拟策略记录 |
| `config.json` | 运行配置（`executionMode` / `offsetStrategies` 等） |

### 城市配置

城市配置在 `lib/weather-data.js`，按 `region` 字段分区：

#### 国内城市（region: domestic，9 个）

| 城市 | 预报源 | 结算站 |
|------|--------|--------|
| 北京 | nmc（中国气象局） | ZBAA 首都机场 |
| 上海 | nmc | ZSPD 浦东机场 |
| 广州 | nmc | ZGGG 白云机场 |
| 深圳 | nmc | ZGSZ 宝安机场 |
| 武汉 | nmc | ZHHH 天河机场 |
| 成都 | nmc | ZUUU 双流机场 |
| 重庆 | nmc | ZUCK 江北机场 |
| 香港 | hko-fnd（香港天文台 9-day forecast） | 香港天文台 |
| 台北 | cwa-county-63（台湾中央气象署） | RCSS 松山机场 |

#### 亚洲国外城市（region: asia-foreign，5 个）

| 城市 | 预报源 | 结算站 |
|------|--------|--------|
| 东京 | Open-Meteo | RJTT 羽田机场 |
| 首尔 | Open-Meteo | RKSS 金浦机场 |
| 新加坡 | Open-Meteo | WSSS 樟宜机场 |
| 吉隆坡 | Open-Meteo | WMKK 国际机场 |
| 马尼拉 | Open-Meteo | RPLL 尼诺伊机场 |

### 天气预报数据源

不同城市使用不同预报源，优先用各国官方气象机构：

| 数据源 | 覆盖城市 | 接口 | 说明 |
|--------|---------|------|------|
| nmc | 国内 7 城 | `https://www.nmc.cn/rest/weather?stationid={code}` | 中国气象局官方，按站点 ID 抓取 |
| hko-fnd | 香港 | `https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=fnd&lang=en` | 香港天文台 9 天预报 open data |
| cwa-county-63 | 台北 | `https://www.cwa.gov.tw/Data/js/TableData_36hr_County_C.js` | 台湾中央气象署县市预报（需 vm 解析 script） |
| open-meteo | 亚洲 5 城 | `https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min&timezone={tz}` | 免费、全球覆盖，默认模型自动选最优数值预报 |

**关键发现**：
- Polymarket 天气事件结算源 = **Wunderground 机场气象站**（如东京羽田 RJTT）
- Open-Meteo 默认模型对东京预报与 JMA 专属模型**结果完全一致**，无需单独接 JMA
- Open-Meteo 已在 `lib/weather-rotation-sim-data.js` 有现成实现，`lib/weather-trading-data.js` 中新增 `fetchOpenMeteoForecast` 复用同一 API

预报抓取入口：`lib/weather-trading-data.js` 的 `fetchForecastForCity(config, ymd)`，按 `config.forecastSource` 分发到对应实现。

### 下单逻辑

#### 当前状态：模拟下单

`config.json` 中 `executionMode=simulation`，所以 `scripts/weather_live_order.py` 启动时直接 return，真实下单链路不走。页面收益主要来自 `scripts/weather_sync.js` 的 `maybeRunSimulationOrders` 写入的 `sim-orders.json`。

#### 下单链路

1. **前端设置** → `POST /api/weather` → `lib/weather-live-config.js` 写入 `config.json`
2. **同步循环** `scripts/weather_sync.js` 每 5 分钟跑一次：
   - `getWeatherDashboardSnapshot` 拉数据（抓预报、抓 Polymarket 事件、刷新结算）
   - `maybeRunWeatherLiveReconcile` 对账
   - `maybeRunWeatherLiveOrders` 实盘下单（simulation 模式跳过）
   - `maybeRunSimulationOrders` 模拟下单（不区分模式，每天都跑）

#### 实盘下单脚本 `scripts/weather_live_order.py`

- 从 `records.json` 取当天 `slot=00` 的候选市场，按 `temperatureOffsets` 过滤（默认只 `[0]`）
- `compute_city_progression` 计算每个城市每个偏移的递进 step（连胜归零、连亏+1）
- `compute_city_stake` 按 step 从序列 `[1,1,1,1,1]` 取下注额
- 调 `scripts/order.py` 的 `create_trader()` → `trader.place_buy(tokenId, stakeUsd, priceCap, ...)`
- 价格上限 `MAX_NO_PRICE=0.95`，超过则跳过
- 下单后 `get_position_size` 确认持仓，写入 `live-orders.json`

#### 模拟下单 `maybeRunSimulationOrders`

- 策略 A（`sim-0-offset`）：0 度偏移，$1 固定
- 策略 B（`sim-follow-yesterday`）：用昨天 `actualMaxTempC - forecastMaxTempC` 作为今天的偏移
- 不调真实交易所，只写 `sim-orders.json`，结算时按 `actualMaxTempC` 判断 bucket 是否命中

### 页面展示

#### 实盘明细 Tab

- 4 个汇总卡（总收益、当天、胜率、盈亏比）
- 0 度 vs 跟偏差策略对比条
- 服务启停 + 设置弹窗（运行模式、偏移策略、初始额度、递进倍数）
- 按日期分页的订单明细表
- 模拟策略 A/B 对比

#### 城市温差 Tab（2026-06-17 精简）

- 4 个指标卡：实盘总收益、当天收益、7 天收益、昨日亏损城市（在 helper 里列出城市名）
- **国内城市温差**区块：9 个国内城市，每格显示温差 + 实际/预报温度
- **亚洲城市温差**区块：5 个亚洲国外城市，有数据时才显示
- 每个区块独立分页，每页 7 天

### 本次会话改动记录（2026-06-17）

#### 1. 模拟收益数据清除

清除了 3 个文件的结算字段（保留预报+市场数据）：

| 文件 | 清除内容 |
|------|---------|
| `records.json` | 144 条结算字段（actualMaxTempC / pnlUsd / resolvedOutcome 等） |
| `sim-orders.json` | 92 条结算字段（accountingPnlUsd / resolvedOutcome 等） |
| `records-midday-no95.json` | 20 条结算字段 |

均有 `.bak.20260617*` 备份。

#### 2. 复盘页面精简

`app/components/weather-review-section.js`：
- 删除 `DailyPnlStrip`（近7天天气收益条）组件
- 删除 `YesterdayLossCities`（昨日亏损城市大卡片）组件
- 昨日亏损城市改为在指标卡 helper 中列出城市名
- 清理 4 个不再使用的工具函数
- `MetricCard` 新增 `tone` 参数支持亏损红色显示

#### 3. 城市名全部中文化

UI 层 3 处去掉 `cityEn` 回退，统一用 `cityZh`：
- `app/components/weather-simulation-section.js`
- `app/weather-rotation/page.js`
- `app/components/weather-review-section.js`

#### 4. Tab 改名

`app/page.js`：「复盘数据」→「城市温差」

理由：页面核心是城市温度条带对比图，"城市温差"直接描述内容。

#### 5. 国内外城市分区展示

**新增 5 个亚洲国外城市**（`lib/weather-data.js`）：
- 东京、首尔、新加坡、吉隆坡、马尼拉
- 每个城市配置 `region: "asia-foreign"` + `forecastSource: "open-meteo"` + 经纬度 + 时区

**分区渲染**（`app/components/weather-review-city-strips.js`）：
- `CityTemperatureStrips` 拆分为 `CityRegionStrips`，按 `region` 字段分两组
- 国内城市温差区块（9 城）+ 亚洲城市温差区块（5 城，有数据时才显示）
- 每个区块独立分页

**数据层**（`lib/weather-trading-data.js`）：
- `buildCityReviewRows` 传递 `region` 字段
- 新增 `fetchOpenMeteoForecast`，用 Open-Meteo API 抓取亚洲城市预报

#### 6. 外国天气预测实现

预报源：**Open-Meteo**（`https://api.open-meteo.com/v1/forecast`）

接口参数：
```
latitude={lat}
longitude={lon}
daily=temperature_2m_max,temperature_2m_min
timezone={tz}
start_date={ymd}
end_date={ymd}
```

实现位置：`lib/weather-trading-data.js` 的 `fetchOpenMeteoForecast(config, ymd)`

返回结构（与其他预报源一致）：
```js
{
  forecastDate: ymd,
  publishTime: null,
  minTempC: number,
  maxTempC: number,
  rangeText: "min~max",
  dayWeather: null,
  nightWeather: null
}
```

准确性验证：
- Open-Meteo 默认模型对东京预报与 JMA 专属模型结果完全一致（26.1°C）
- Polymarket 结算源是 Wunderground 机场站，Open-Meteo 预报可作为下单参考

### 改动文件清单（本次会话）

| 文件 | 改动 |
|------|------|
| `app/page.js` | Tab 改名「城市温差」 |
| `lib/weather-data.js` | 新增 5 个亚洲国外城市配置 + region 字段 |
| `lib/weather-trading-data.js` | 新增 `fetchOpenMeteoForecast` + `buildCityReviewRows` 传递 region |
| `app/components/weather-review-city-strips.js` | 拆分为 `CityRegionStrips` 分区渲染 |
| `app/components/weather-review-section.js` | 删除近7天收益条 + 昨日亏损城市大卡片 + fallback 文案改名 |
| `app/components/weather-simulation-section.js` | 城市名中文化 |
| `app/weather-rotation/page.js` | 城市名中文化 |

---

## 城市温差 Tab 分区改为子 Tab 切换（2026-06-17 迭代）

### 背景

原方案是国内 + 亚洲两个区块上下堆叠在一个页面。考虑到未来还要加入欧洲、北美等其他州的城市，上下堆叠会导致页面过长、用户需要大量下拉才能找到目标城市，体验不佳。

### 改动

将 `app/components/weather-review-city-strips.js` 的 `CityTemperatureStrips` 从「上下堆叠多区块」改为「顶部子 Tab 切换」：

#### 区域子 Tab 配置

```js
const REGION_TABS = [
  { value: "domestic", label: "国内", subtitle: "每格 = 实际高温 - 预报高温" },
  { value: "asia-foreign", label: "亚洲", subtitle: "预报源：Open-Meteo · 结算源：Wunderground 机场站" },
  { value: "europe", label: "欧洲", subtitle: "敬请期待", placeholder: true },
  { value: "north-america", label: "北美", subtitle: "敬请期待", placeholder: true },
];
```

#### 交互设计

- **有数据的 Tab**：可点击，显示城市数量徽标，点击切换内容
- **预留 Tab**（`placeholder: true`）：禁用状态，半透明，点击无反应，显示「Coming Soon」占位
- **默认选中**：第一个有数据的 Tab，否则选国内
- **每个 Tab 内**：独立分页，每页 7 天

#### 扩展方式

未来加欧洲/北美城市只需两步：
1. 在 `REGION_TABS` 中把对应 Tab 的 `placeholder` 改为 `false`（或删除该字段）
2. 在 `lib/weather-data.js` 中添加对应城市配置，`region` 字段设为 `"europe"` 或 `"north-america"`

### 改动文件

| 文件 | 改动 |
|------|------|
| `app/components/weather-review-city-strips.js` | `CityTemperatureStrips` 改为子 Tab 切换式，新增 `REGION_TABS` 配置 + `RegionPlaceholder` 组件 |

---

## 实盘明细 Tab 改造 + 数据重新清理（2026-06-17 迭代）

### 背景

1. 之前清理的模拟收益数据被 `weather_sync` 服务重新拉取覆盖，数据"复活"
2. 实盘明细页的"各偏移量明细"区块信息冗余，用户不需要
3. "胜率"和"盈亏比"两个指标卡不如直接看收益直观
4. 实盘明细页也需要像城市温差页一样按区域分子 Tab

### 改动

#### 1. 停掉 weather_sync 服务

`weather_sync` 服务（`scripts/weather_sync_launcher.js` + `scripts/weather_sync.js`）每 5 分钟跑一次，会重新拉取结算数据覆盖清理结果。停掉后再清理数据才有效。

#### 2. 重新清理数据

| 文件 | 清除内容 | 备份 |
|------|---------|------|
| `records.json` | 144 条结算字段 | `.bak.20260617034734` |
| `sim-orders.json` | 92 条结算字段 | `.bak.20260617034734` |
| `records-midday-no95.json` | 20 条结算字段 | `.bak.20260617034734` |

#### 3. 删除"各偏移量明细"区块

`app/components/weather-section.js` 的 `OffsetComparisonStrip` 组件删除了 `deltaGroups` 渲染部分（偏移 -4°C ~ +5°C 的明细条），只保留 0 度 vs 跟偏差的策略对比卡。

#### 4. 指标卡改造：胜率/盈亏比 → 赢的收益/输的收益

`buildRecordsSummary` 新增 `winsPnlUsd`（所有赢的笔数总收益）和 `lossesPnlUsd`（所有输的笔数总收益）。

4 个指标卡变为：
- 总收益（已结算笔数）
- 当天收益（日期）
- 赢的收益（赢 N 笔，绿色）
- 输的收益（输 N 笔，红色）

#### 5. 实盘明细页加区域子 Tab

`app/components/weather-paginated-tables.js` 的 `PaginatedRecordTables` 新增 `RegionTabBar` 组件：
- 国内 / 亚洲 / 欧洲（预留）/ 北美（预留）
- 与城市温差页的子 Tab 设计保持一致
- 按 `region` 字段过滤每个日期的城市记录
- 切换 Tab 时重置分页
- 无数据的区域显示"该区域暂无天气记录"

`app/components/weather-section.js` 的 `buildAllDateRows` 新增 `region` 字段，通过 `CITY_REGION_MAP`（从 `WEATHER_CITY_CONFIGS` 构建）查 `citySlug` 对应的 region。

#### 6. 5 个亚洲城市天气预报验证

通过 Open-Meteo API 跑了今天（2026-06-17）的预报：

| 城市 | 最高温 | 最低温 |
|------|--------|--------|
| 东京 | 25.6°C | 19.4°C |
| 首尔 | 28.7°C | 18.9°C |
| 新加坡 | 29.9°C | 25.4°C |
| 吉隆坡 | 29.9°C | 23.0°C |
| 马尼拉 | 34.7°C | 27.8°C |

### 改动文件

| 文件 | 改动 |
|------|------|
| `app/components/weather-section.js` | 引入 `WEATHER_CITY_CONFIGS` 构建 `CITY_REGION_MAP`；`buildRecordsSummary` 加 `winsPnlUsd`/`lossesPnlUsd`；`OffsetComparisonStrip` 删除 `deltaGroups`；指标卡改为赢的收益/输的收益；`buildAllDateRows` 加 `region` 字段 |
| `app/components/weather-paginated-tables.js` | `PaginatedRecordTables` 新增 `RegionTabBar` 子 Tab 切换 + region 过滤 |

### 注意事项

- `weather_sync` 服务已停掉，重启后会重新拉取结算数据。如需保持清理状态，不要重启该服务
- 临时文件 `temp/run_asia_forecast.py` 和 `temp/clean_data.py` 待清理（按规则执行完询问）

---

## 温差下单逻辑实现 + 真实价格 + 下单温度列（2026-06-17 迭代）

### 背景

用户要求实盘明细的下单逻辑改为：**用昨天温差作为今天偏移，下在「预报温度 + 偏移」的 bucket 上，温度必须相等才下单，全部模拟**。国外城市昨天没温差数据则跳过，等有记录后再模拟下单。

### 下单逻辑

```
昨天温差 = 昨天实际温度 - 昨天预报温度
今天目标温度 = 今天预报温度 + 昨天温差
从 Polymarket gamma-api 找目标温度对应的市场（温度必须相等）
获取该市场的真实 No 价格
下单（模拟，$1 固定）
```

### 关键改动

#### 1. `maybeRunSimulationOrders` Strategy B 改用真实价格

- 新增 `fetchTargetTempMarket(record, targetTempC)` 函数：调 `gamma-api.polymarket.com/events?slug=...` 获取事件所有市场，找 `bucket.value === targetTempC` 的 exact 市场，提取真实 No 价格
- Strategy B 不再依赖 `candidateMarkets`（之前只有 offset=0），直接用 gamma-api 获取目标温度市场的真实价格
- `maybeRunSimulationOrders` 改为 `async`，调用处加 `await`
- 温度必须相等才下单（`bucket.kind === "exact" && bucket.value === targetTempC`）

#### 2. `WEATHER_TEMPERATURE_OFFSET_OPTIONS` 扩大范围

`lib/weather-live-config.js` 的 `WEATHER_TEMPERATURE_OFFSET_OPTIONS` 从 `[0]` 改为 `[-5,-4,-3,-2,-1,0,1,2,3,4,5]`，让抓取时 `candidateMarkets` 包含 ±5°C 所有温度市场（供 Strategy A 使用）。

#### 3. 实盘明细表加"下单温度"列

`app/components/weather-paginated-tables.js` 表头新增"下单温度"列（在"温差"和"收益"之间），显示 `targetTempC`，空行 colSpan 从 6 改为 7。

#### 4. 清理所有历史收益数据

| 文件 | 清理内容 |
|------|---------|
| `records.json` | 所有历史收益字段（pnlUsd/payoutUsd/resolvedOutcome/resolvedAt） |
| `sim-orders.json` | 所有历史收益字段（accountingPnlUsd/resolvedOutcome/resolvedAt） |

保留：预报温度、实际温度、温差、市场数据等下单依据。

### 今天（2026-06-17）温差下单结果

| 城市 | 预报 | 昨天温差 | 下单温度 | 真实 No 价格 |
|------|------|---------|---------|-------------|
| 北京 | 32° | -2° | 30° | 0.71 |
| 成都 | 25° | 0° | 25° | 0.70 |
| 重庆 | 27° | 0° | 27° | 0.90 |
| 广州 | 29° | +1° | 30° | 0.735 |
| 上海 | 30° | -2° | 28° | 0.705 |
| 武汉 | 33° | +1° | 34° | 0.735 |

跳过：
- 深圳（目标 24°，价格 0.9995 无效）
- 台北（目标 38°，无匹配市场）
- 香港（目标 26°，价格 0.987 无效）
- 亚洲 5 城（东京/首尔/新加坡/吉隆坡/马尼拉）：无昨天温差数据

### 改动文件

| 文件 | 改动 |
|------|------|
| `scripts/weather_sync.js` | 新增 `fetchTargetTempMarket`；Strategy B 改用真实价格；`maybeRunSimulationOrders` 改 async |
| `lib/weather-live-config.js` | `WEATHER_TEMPERATURE_OFFSET_OPTIONS` 扩大为 ±5°C |
| `app/components/weather-paginated-tables.js` | 新增"下单温度"列 |

### 注意事项

- `weather_sync` 服务重启后会自动用新逻辑跑温差下单（每 5 分钟一次）
- 国外城市需要积累昨天的温差数据后才会开始模拟下单

## 全球城市扩展 + 下单时间清单（2026-06-18 迭代）

### 背景

将天气监控城市从 26 个扩展到 52 个，覆盖 Polymarket 所有最高温市场城市。新增南美、非洲、大洋洲 Tab。

### 新增城市（26 个）

| 区域 | 城市 |
|------|------|
| 国内 | 青岛 |
| 亚洲 | 釜山、卡拉奇、勒克瑙、吉达、特拉维夫、安卡拉、伊斯坦布尔 |
| 欧洲 | 米兰、慕尼黑、华沙、莫斯科、阿姆斯特丹 |
| 北美 | 华盛顿、亚特兰大、奥斯汀、达拉斯、休斯顿、丹佛、西雅图、墨西哥城、巴拿马城 |
| 南美 | 布宜诺斯艾利斯、圣保罗 |
| 非洲 | 开普敦 |
| 大洋洲 | 惠灵顿 |

### 各城市下单时间参考

weather_sync 服务每 5 分钟循环一次，自动检查市场是否可用。下单时间规则：
- **国内和亚洲城市**：北京时间 00:10 统一下单
- **其他城市**：当地凌晨 00:10 换算成北京时间下单

| 区域 | 时区 | 下单时间（北京时间） | 说明 |
|------|------|---------------------|------|
| 国内 10 城 | UTC+8 | 00:10 | 当天 0 点后市场即可用 |
| 东京/首尔/釜山 | UTC+9 | 00:10 | 统一北京时间 00:10 |
| 新加坡/吉隆坡/马尼拉 | UTC+8 | 00:10 | 同中国时区 |
| 卡拉奇 | UTC+5 | 03:10 | 当地 00:10 = 北京 03:10 |
| 勒克瑙 | UTC+5:30 | 02:40 | 当地 00:10 = 北京 02:40 |
| 吉达/特拉维夫/安卡拉/伊斯坦布尔 | UTC+3 | 05:10 | 当地 00:10 = 北京 05:10 |
| 莫斯科 | UTC+3 | 05:10 | 同上 |
| 开普敦 | UTC+2 | 06:10 | 当地 00:10 = 北京 06:10 |
| 赫尔辛基/华沙/柏林/阿姆斯特丹 | UTC+1/UTC+2 | 07:10-08:10 | 夏令时变化 |
| 巴黎/米兰/伦敦 | UTC+0/UTC+1 | 07:10-08:10 | 夏令时变化 |
| 圣保罗/布宜诺斯艾利斯 | UTC-3 | 11:10 | 当地 00:10 = 北京 11:10 |
| 华盛顿/纽约/亚特兰大/迈阿密 | UTC-4(夏令时) | 12:10 | 当地 00:10 = 北京 12:10 |
| 芝加哥/奥斯汀/达拉斯/休斯顿 | UTC-5(夏令时) | 13:10 | 当地 00:10 = 北京 13:10 |
| 丹佛 | UTC-6(夏令时) | 14:10 | 当地 00:10 = 北京 14:10 |
| 西雅图/洛杉矶/旧金山 | UTC-7(夏令时) | 15:10 | 当地 00:10 = 北京 15:10 |
| 墨西哥城 | UTC-6 | 14:10 | 当地 00:10 = 北京 14:10 |
| 巴拿马城 | UTC-5 | 13:10 | 当地 00:10 = 北京 13:10 |
| 惠灵顿 | UTC+12 | 20:10 | 当地 00:10 = 北京前一天 20:10 |

**注意**：
- 以上为建议时间，实际 weather_sync 服务每 5 分钟自动检查，到时间后自动下单
- 夏令时期间欧美城市时差会变化（3 月-11 月），代码中动态计算
- 如果电脑关机或服务未运行，重启后会自动补下单和补结算
- 页面上每个城市下方标注了下单时间（北京时间）供参考

### 改动文件

| 文件 | 改动 |
|------|------|
| `lib/weather-data.js` | 新增 26 个城市配置（含青岛），总数 52 个 |
| `app/components/weather-paginated-tables.js` | tab 标签改为城市数量；新增南美/非洲/大洋洲 Tab；修复 null°C bug；缩窄列宽 |
| `app/components/weather-review-city-strips.js` | 新增南美/非洲/大洋洲 Tab；"> +3°C" 改为"人工下单参考" |
| `app/components/weather-section.js` | 删除 Simulation 区块；过滤无数据日期 |
| `lib/weather-trading-data.js` | 新增繁简转换函数，台北 CWA 数据转简体 |

### 其他修复

- 删除 Simulation 模拟策略收益对比区块（Strategy A / Strategy B）
- 修复 `Number(null)=0` 导致 null°C 显示的 bug
- tab 标签从记录数改为城市数量（如"国内9城"）
- 去掉无数据日期的分页（纽约等新城市历史数据为 0°/0°）
- 台北 CWA 天气描述繁体转简体
- 清理所有历史收益数据（06/17 之前）
- 删除所有 sim-0-offset 旧订单，只保留温差下单订单
- 真实价格从 gamma-api 获取，每次下单都会调一次 API

## 实盘明细页改用温差下单数据展示（2026-06-17 迭代）

### 背景

用户要求："实盘明细这个里面的下单 就用温差这个下单"。之前实盘明细页（`PaginatedRecordTables`）展示的是 `records.json` 中的 0-offset 数据（`targetTempC = forecastMaxTempC`），与实际温差下单逻辑不一致。

### 改动

`app/components/weather-section.js` 的 `buildAllDateRows` 函数改为：

1. 从 `snapshot.simOrders` 中筛选 `strategyId === "sim-follow-yesterday"` 的温差下单订单，构建 `${date}:${citySlug}` 索引
2. 对每个 record，如果有对应的温差下单订单，用订单的 `targetTempC`、`buyNoPrice`、`marketSlug`、`marketTitle`、`marketQuestion`、`marketBucketKind`、`marketBucketValue`、`temperatureOffsetC`、`prevDateDeltaC` 覆盖 record 的对应字段
3. 收益（`impliedPnlUsd`）通过 `computeRecordPnl(merged)` 基于覆盖后的数据自动计算
4. 没有温差下单订单的城市（如国外城市无昨天温差数据）清空下单字段（显示 "--"），不展示 0-offset 数据

### 效果

实盘明细表的"买 No"、"下单温度"、"收益"列现在展示的是温差下单的真实数据，与 `sim-orders.json` 中的 `sim-follow-yesterday` 订单一致。

### 改动文件

| 文件 | 改动 |
|------|------|
| `app/components/weather-section.js` | `buildAllDateRows` 从 simOrders 找温差下单数据覆盖 record 的下单字段；无订单时清空字段 |

## 预收益列 + 结算优化 + 国际城市扩展（2026-06-17 迭代）

### 背景

用户要求：
1. 实盘明细表加"预收益"列（在温差和收益之间）
2. 结算后标记常量，不再重复检测
3. 扩展更多国家的城市，分 tab 展示，温差和模拟下单都做

### 改动

#### 1. 预收益列

`app/components/weather-section.js` 的 `buildAllDateRows` 新增 `expectedPnlUsd` 计算：
- 预收益 = stakeUsd / buyNoPrice - stakeUsd（如果 No 赢了能赚多少）
- 没有下单时为 null，页面显示 "--"

`app/components/weather-paginated-tables.js` 表头新增"预收益"列（在"温差"和"收益"之间），colSpan 从 7 改为 8。

#### 2. 结算优化

`scripts/weather_sync.js` 的结算循环改为：
- 先用 `allOrders.filter(o => o.status === "pending")` 过滤出 pending 订单
- 只遍历 pending 订单进行结算检测
- 已结算（status === "resolved"）的订单完全不再遍历

#### 3. 国际城市扩展

`lib/weather-data.js` 新增 12 个城市配置：

| 区域 | 城市 | 结算站 |
|------|------|--------|
| 欧洲 | 伦敦、巴黎、柏林、罗马、马德里、赫尔辛基 | EGLC、LFPB、EDDB、LIRF、LEMD、EFHK |
| 北美 | 纽约、洛杉矶、芝加哥、多伦多、迈阿密、旧金山 | KNYC、KLAX、KMDW、CYYZ、KMIA、KSFO |

所有新城市使用 Open-Meteo 获取天气预报（与亚洲5城相同方式），gamma-api 获取真实 No 价格，温差下单逻辑自动适用。

`app/components/weather-review-city-strips.js` 的 `REGION_TABS` 配置：欧洲和北美从"敬请期待"改为正常显示。

### 数据源说明

- **预报数据**：Open-Meteo API（全球覆盖，无需 API Key，支持 16 天预报）
  - URL 格式：`https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&daily=temperature_2m_max,temperature_2m_min&timezone=auto`
  - 自动选择最高分辨率的区域模型（欧洲用 DWD/Météo-France/UK Met Office，北美用 NCEP GFS/HRRR）
- **结算数据**：Polymarket 使用 Wunderground 机场站 METAR 观测数据，本项目暂用 Open-Meteo ERA5 再分析数据作参考

### 改动文件

| 文件 | 改动 |
|------|------|
| `app/components/weather-section.js` | 新增 `expectedPnlUsd` 计算；无温差订单时清空下单字段 |
| `app/components/weather-paginated-tables.js` | 新增"预收益"列，colSpan 改为 8 |
| `scripts/weather_sync.js` | 结算循环改为只遍历 pending 订单 |
| `lib/weather-data.js` | 新增 12 个欧洲/北美城市配置 |
| `app/components/weather-review-city-strips.js` | 欧洲和北美 Tab 从"敬请期待"改为正常显示 |
