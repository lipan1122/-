# allotment 口径变更说明（2026-11-22）

> 起因：酒店确认 `rate_calendar.allotment` 的业务含义。
> 影响：库存计算、渠道推送、房态页显示、测试断言。

---

## 一、确认结果

**`rate_calendar.allotment` = 当天剩余可卖数量**

不是：
- ❌ 渠道总放量上限
- ❌ 总房量
- ❌ 物理房量

就是「今天这个房型还剩几间能卖」—— 已经是在住 / 维修 / 锁房 / 预订之后的结果。

---

## 二、旧口径错在哪

```ts
// 第八~九轮的实现
可售 = min(物理上限, allotment) − 在住 − 预订
```

**allotment 本来就是扣完的结果，却又从里面扣了一次在住/预订** —— 相当于扣了两次。

### 举例

场景：总房 10 间、在住 3 间、预订 2 间、运营设 allotment = 5（"今天还剩 5 间"）

| | 计算 | 结果 |
| --- | --- | --- |
| 旧口径 | `min(10, 5) − 3 − 2` | **0** ← 明明还能卖 5 间却显示 0 |
| 新口径 | `min(10 − 0 − 3 − 2, 5)` | **5** ← 正确 |

更极端的场景：总房 10、在住 8、allotment = 2

| | 计算 | 结果 |
| --- | --- | --- |
| 旧口径 | `min(10, 2) − 8` | 0（负数被夹） |
| 新口径 | `min(10 − 8, 2)` | **2** ← 正确（物理剩 2、运营说剩 2） |

---

## 三、新口径

```
物理可售 = 总房 − OOO（维修）− LOCK（锁房）− 在住 − 预订
可售     = 配了 allotment ? min(物理可售, allotment) : 物理可售
```

**为什么还要取 min**：运营设的「剩余量」不可能突破物理事实。
如果已经住满（物理可售 = 0），运营误把 allotment 设成 5，可售仍然是 0 —— 防止超卖。

**相关字段**：

| 字段 | 含义 |
| --- | --- |
| `allotmentHold` | `物理可售 − 可售` —— allotment 把可售压低了多少，**仅用于页面解释** |
| `oversold` | `max(0, −物理可售)` —— 卖超了多少，**不受 allotment 影响**（allotment=0 不算超售） |

---

## 四、改动的文件

| 文件 | 改动 |
| --- | --- |
| `src/lib/room-stock.ts` | 计算逻辑 + 注释（房态页/远期房态/房型预测的口径源） |
| `src/lib/channels/stock-trigger.ts` | 推给渠道的房量同口径 + 补 LOCK 扣减 + 读 `rate_calendar.allotment` |
| `src/app/(main)/rooms/page.tsx` | 页面口径说明文字 |
| `tests: scripts/test-allotment-semantics.mjs` | 13 断言重写（含 6 条源码防漂移断言） |

### `stock-trigger.ts` 顺带修的两个旧缺陷

1. **只扣 OOO，没扣 LOCK** → 锁房被当成可卖推给渠道（**超卖**）
2. **完全没读 `rate_calendar.allotment`** → 运营在「设置 → 房量」手工限售 5 间，渠道那边还按物理剩余卖，**限售形同虚设**

⚠️ 这里**不能** `Math.max(0, ...)`：物理可售可能是负数（卖超了），
负数是「还能再卖超几间」的信息，下游 `toChannelAllotment(oversell)` 要用它决定关房还是继续放量。
房态页（`room-stock.ts`）才需要夹到 0，因为页面不显示负库存。

---

## 五、验证

| 测试 | 结果 |
| --- | --- |
| `test-allotment-semantics.mjs` | **13 / 0**（含 6 条源码断言：`min(physicalSellable, allotment)` 存在、旧写法 `cap - inhouse - booked` 不存在、注释写明语义、LOCK 已扣、`rate_calendar` 已读） |
| `test-channel-sync.mjs` | **69 / 0** |
| `test-room-availability.mjs` | **12 / 0** |
| `test-night-audit-occupancy.mjs` | **18 / 0** |
| `test-occupancy-tenant-isolation.mjs` | **27 / 0** |
| tsc / eslint | 0 错误 / 0 error |

**真库数字**：46 间房、21 间在住、可售 **25**（`rate_calendar` 里有 3 条 allotment 不在今天，所以数字不变，符合预期）。

---

## 六、对 OTA 联调的影响

之前「不能开始 OTA 联调」有**两个**阻断项：

1. ~~allotment 语义未确认~~ → **已确认，已改口径**
2. 无真实渠道凭据 → **仍缺**

所以现在**只剩一个阻断项**：拿到至少一个渠道的 `appKey` / `appSecret` / `storeId` / 接口授权。

---

## 七、这轮踩的坑（值得记住）

改完提交后，`room-stock.ts` 的改动**被并行进行的《微信小程序专项》覆盖了**（它的 `git checkout` 回退了文件）。

**教训**：并行开发时改共享文件后，**必须立即 grep 关键标识符验证改动还在**，
而不是假设 `git commit` 成功就万事大吉 —— commit 只证明「我那一刻写进去了」，
不证明「它还在」。

发现方式：`grep -c physicalSellable src/lib/room-stock.ts` → **0**（应该是 2+）。
