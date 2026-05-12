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
