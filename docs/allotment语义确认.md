# allotment 语义确认与实现（2026-11-22）

> 这份文档记录「`rate_calendar.allotment` 到底是什么」这个悬了三轮的问题的最终结论，
> 以及它落地到哪些文件、怎么验证。

---

## 一、结论

**`rate_calendar.allotment`（设置 → 房价日历「修改房量」）= 当天剩余可卖数量。**

不是「渠道总放量上限」，不是「总房量」。

**酒店 2026-11-22 确认。**

---

## 二、由结论推出的算式

```
物理可售 = 总房量 − 维修房(OOO) − 锁房(LOCK) − 在住 − 预订占用
今日可售 = allotment === null ? 物理可售 : min(物理可售, allotment)
```

**关键**：allotment 是「剩余」，所以**不再从它里面扣在住/预订**。

因为「今天还能卖 4 间」这句话，本身就已经是在扣掉在住和预订之后的结果。
再从里面扣一次占用，等于同一份占用被扣两次。

### 举例（6 间房、1 间在住）

| | 物理可售 | allotment | 旧算法（错） | 新算法（对） |
| --- | --- | --- | --- | --- |
| 场景 | 6 − 1 = **5** | 4（今天还能卖 4 间） | `min(6, 4) − 1 = **3**` ❌ | `min(5, 4) = **4**` ✅ |

旧算法把 allotment 当「总放量上限」：先和物理上限取小得 4，再扣 1 间在住 → 3。
**占用被扣了两次**，前台按 3 排房会少卖一间。

### 取 min 的原因

运营设的「剩余量」不能突破物理事实 —— 已经住满的房型不能被设成「还能卖 5 间」。
所以取两者较小值，而不是直接用 allotment。

---

## 三、与渠道侧的 `toChannelAllotment` 不是一回事

两个都叫 allotment，但语义完全不同，容易混：

| | `rate_calendar.allotment` | `toChannelAllotment()` |
| --- | --- | --- |
| 谁设的 | **酒店手工设**（设置 → 房价日历） | **PMS 计算**（`src/lib/channels/stock-trigger.ts`） |
| 含义 | 当天剩余可卖数量 | 推给渠道的数字 |
| 负值 | 不允许（`0` = 全部关房） | **允许**（`-N` = 还能超售 N 间） |
| 用途 | 限制 PMS 自己卖多少 | 告诉渠道还能卖多少 |

**渠道推送要同时考虑两者**：`stock-trigger.ts` 已经读了 `rate_calendar.allotment`，
把它作为上限收紧后再换算给渠道（限售必须传到渠道，否则运营限售 5 间而渠道还在按物理剩余卖）。

---

## 四、落地到哪些文件

| 文件 | 改动 |
| --- | --- |
| `src/lib/room-stock.ts` | 文件头注释与正文注释统一（原来一处写「只当上限」一处写「剩余可卖」，自相矛盾）；算式本身已是 `min(physicalSellable, allotment)` |
| `src/app/(main)/rooms/predict/page.tsx` | **旧语义残留修掉** —— 原来 `capacityOf = allotment ?? physical` 把「还剩 2 间」当成「总共 2 间房」，再减占用会算出负数可售 |
| `src/lib/channels/stock-trigger.ts` | 已读 `rate_calendar.allotment` 限制渠道推送（第九轮已做，本轮确认） |
| `scripts/test-allotment-semantics.mjs` | **重写**（见下） |

### 测试重写的原因

原测试是**抄一份算式到测试里**，而且抄成了旧语义（`min(物理上限, allotment) − 占用`）。

结果：**测试全绿，但和线上实现不一致** —— 这比没有测试更危险，因为它会让人以为验证过了。

现在改成**直接 import 生产函数**：

```js
globalThis.__pmsDb = conn;                    // 换库开关（db.ts 的 getDb 优先用它）
registerHooks({ resolve: /* 解析 @/ 别名 */ });
const { todayRoomTypeStock } = await import("../src/lib/room-stock.ts");
```

17 条断言，每条都是 `todayRoomTypeStock()` 的真实输出。

---

## 五、验证

```
node scripts/test-allotment-semantics.mjs          17 / 0
node scripts/test-room-stock-today.mjs             23 / 0
node scripts/test-room-stock-allotment.mjs         29 / 0
node scripts/test-room-stock-multiroom.mjs         22 / 0
node scripts/test-channel-sync.mjs                 69 / 0
node scripts/test-room-availability.mjs            12 / 0
全量测试                                           82 套全通过
tsc 0 / lint 0 / build 通过
```

### 关键断言

```
✅ allotment = NULL → 可售 = 6
✅ allotment = 2 → 可售 = 2（剩余可卖 2 间）
✅ allotment = 10 → 可售 = 6（不超物理可售）
✅ allotment = 0 → 可售 = 0（全部关房）
✅ 物理可售 5（6 − 1 在住）、allotment = 4 → 可售 = 4（不是 3，占用不重复扣）
✅ allotment 放大到 10 → 可售 = 5（按物理可售封顶）
✅ allotment 清空 → 可售 = 5（回到物理可售）
✅ 加 1 张已排房预订 → 物理可售 4
✅ 物理可售 4、allotment = 2 → 可售 = 2（取小，占用不二次扣）
✅ 1 在住 + 1 维修 → 可售 = 4（6−1−1）
✅ 再加 1 锁房 → 可售 = 3（6−1−1−1）
✅ 测试酒店的房间没有污染 hotel 1
✅ 测试酒店的 allotment 没有写进 hotel 1
```

### 真实数字

| 环境 | 总房 | 在住 | 今日可售 |
| --- | --- | --- | --- |
| 本地 | 46 | 21 | **25** |
| VPS | 46 | 21 | **25**（房态页实测 `今日可售 25 间`） |

---

## 六、OTA 联调的前置条件现在满足了吗

清单反复要求「allotment 语义确认前禁止真实 OTA 房量联调」。

| 条件 | 状态 |
| --- | --- |
| **allotment 语义已确认** | ✅ 本文档 |
| 房型映射完成 | 🟡 代码有，缺真实渠道数据核对 |
| 拿到至少一个渠道真实凭据 | ❌ 无 |
| 签名和端点完成官方文档核对 | ❌ 沙箱实现，未核对官方文档 |
| 最小真实订单链路通过 | ❌ 无凭据无法执行 |

**结论**：allotment 这个阻断项已解除，但**OTA 联调仍不能开始** —— 还差真实凭据和官方文档核对。

---

## 七、这轮的一个教训

**「测试抄一份实现」是危险的**。

原测试把算式抄到测试文件里，抄的时候抄成了旧语义，于是：
- 生产代码是新语义（`min(物理可售, allotment)`）
- 测试断言是旧语义（`min(物理上限, allotment) − 占用`）
- **测试全绿**，因为它验证的是自己抄的那份，不是生产代码

正确做法是**直接调用生产函数**（`globalThis.__pmsDb` + `registerHooks` 已在项目里用了很多次），
让测试和生产共享同一份实现，抄错的可能性就不存在了。

同类问题这轮还出现在别处（报表间夜抄了一份 `SUM(qty)`、渠道口径抄了一份），
共同特征都是「测试自己实现了一遍」。
