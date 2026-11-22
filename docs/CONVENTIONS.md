# 工程约定

## 技术栈
Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS v4 + node:sqlite。全部中文界面。

## 目录
- `src/app/(main)/xxx/page.tsx` 页面（服务端组件，直接查库）
- `src/app/(main)/xxx/actions.ts` server actions（文件首行 `"use server"`，只导出 async 函数）
- `src/components/` 客户端组件
- `src/lib/db.ts`、`utils.ts`、`session.ts` 基础设施

## 数据库访问（src/lib/db.ts）

```ts
import { all, get, run, tx } from "@/lib/db";
const rows = all<Row>(`SELECT ... WHERE hotel_id = ?`, [hotelId]);
const one = get<Row>(`SELECT ... WHERE id = ?`, [id]);   // 可能 undefined
run(`INSERT ...`, [a, b]);
```

## 会话（src/lib/session.ts）

```ts
import { requireUser } from "@/lib/session";
const user = await requireUser(); // { id, username, realName, role, hotelId, hotelName }
```

## 工具（src/lib/utils.ts）

```ts
import { ROOM_STATUS, BOOKING_STATUS, fmtMoney, todayStr, addDays, nightsBetween, nowIso } from "@/lib/utils";
```

## 页面骨架

```tsx
export const dynamic = "force-dynamic";

export default async function XxxPage() {
  const user = await requireUser();
  return (...)
}
```

## 可用 CSS 类（src/app/globals.css）
`card` 白卡片 · `btn-primary` 蓝色主按钮 · `btn-default` 描边按钮 · `btn-danger` 红色描边 · `input` 输入框 · `label` 表单标签 · `th` 表头单元格 · `td` 表格单元格
品牌色 `text-brand-600 bg-brand-50 border-brand-200` 等。

## 写操作
server action 内完成后调用 `revalidatePath("/对应路径")`。表单用 `<form action={actionFn}>` + hidden input。

## 视觉规范
- 页面标题 15-18px 加粗，正文 13px，辅助文字 11-12px 灰色 `text-gray-400/500`
- 表格：`<table className="w-full"><thead><tr><th className="th">…</th></tr></thead>`，行 hover `hover:bg-gray-50`
- 房态颜色：空净白/空脏 #4b4b4b/住净 #3a76c4/住脏 #8b2fd6/维修 #c99a2e
- 金额一律 `fmtMoney()`
- 空数据要有空状态提示，不要留白
