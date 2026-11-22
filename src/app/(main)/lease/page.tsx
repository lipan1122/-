import { all, get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import ConfirmForm from "@/components/ConfirmForm";
import { fmtMoney, nowIso, todayStr } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "items", label: "租赁物品管理" },
  { key: "records", label: "租赁记录" },
] as const;

/** 失败 / 成功回跳：文案带在 query 上，页面顶部渲染横幅 */
function backLease(key: "err" | "msg", message: string): never {
  redirect(`/lease?${key}=${encodeURIComponent(message)}`);
}

async function saveItemAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(formData.get("id") ?? 0);
  const name = String(formData.get("name") ?? "").trim();
  const price = Number(formData.get("price") ?? 0);
  const stock = Number(formData.get("stock") ?? 0);
  if (!name) return;
  if (id > 0) {
    run(`UPDATE lease_items SET name = ?, price = ?, stock = ? WHERE id = ? AND hotel_id = ?`, [
      name, price, stock, id, user.hotelId,
    ]);
  } else {
    run(
      `INSERT INTO lease_items (hotel_id, name, price, stock, status, created_at) VALUES (?,?,?,?,?,?)`,
      [user.hotelId, name, price, stock, "ON", nowIso()]
    );
  }
  revalidatePath("/lease");
}

/**
 * 删除租赁物品（整改清单 P1-31：不可逆物理删除）
 *
 * 原来按 id 直接物理删除、一把梭：物品被删掉后，
 * lease_records 里的历史记录仍指向一个不存在的 item_id，对账时无从追溯。
 * 现在：二次确认 + 原因必填（页面 ConfirmForm），服务端再做引用检查
 * —— 只要产生过租赁记录就不允许删除；删除成功写 op_logs 留痕。
 */
async function deleteItemAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(formData.get("id") ?? 0);
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id) backLease("err", "租赁物品不存在，请刷新后重试");

  const item = get<{ name: string }>(`SELECT name FROM lease_items WHERE id = ? AND hotel_id = ?`, [
    id,
    user.hotelId,
  ]);
  if (!item) backLease("err", "租赁物品不存在，请刷新后重试");
  if (!reason) backLease("err", "删除租赁物品必须填写原因");

  /* 引用检查：租赁记录（合同明细）——只要存在就不能删，避免历史记录指向空物品 */
  const records =
    get<{ c: number; leased: number }>(
      `SELECT COUNT(*) AS c,
              SUM(CASE WHEN status = 'LEASED' THEN 1 ELSE 0 END) AS leased
         FROM lease_records WHERE hotel_id = ? AND item_id = ?`,
      [user.hotelId, id]
    ) ?? { c: 0, leased: 0 };
  if (records.c > 0) {
    backLease(
      "err",
      `「${item.name}」有 ${records.c} 条租赁记录（未归还 ${Number(records.leased ?? 0)} 条），不能删除；请先归还后再处理`
    );
  }

  run(`DELETE FROM lease_items WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);

  /* 整改清单 P1-34：物理删除必须留痕（失败不影响主流程） */
  try {
    run(`INSERT INTO op_logs (hotel_id, operator, action, detail, created_at) VALUES (?,?,?,?,?)`, [
      user.hotelId,
      user.realName || user.username,
      "删除租赁物品",
      `「${item.name}」（ID ${id}）· 原因：${reason}`,
      nowIso(),
    ]);
  } catch {
    /* op_logs 不存在（极老库）→ 跳过审计 */
  }

  revalidatePath("/lease");
  backLease("msg", `租赁物品「${item.name}」已删除`);
}

async function leaseOutAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const itemId = Number(formData.get("item_id") ?? 0);
  const roomNo = String(formData.get("room_no") ?? "").trim();
  const qty = Math.max(1, Math.trunc(Number(formData.get("qty") ?? 1)));
  if (!itemId || !roomNo) return;
  const item = get<{ name: string; price: number; stock: number }>(
    `SELECT name, price, stock FROM lease_items WHERE id = ? AND hotel_id = ?`,
    [itemId, user.hotelId]
  );
  if (!item || item.stock < qty) return;
  run(`UPDATE lease_items SET stock = stock - ? WHERE id = ? AND hotel_id = ?`, [qty, itemId, user.hotelId]);
  run(
    `INSERT INTO lease_records (hotel_id, item_id, item_name, room_no, qty, amount, status, leased_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [user.hotelId, itemId, item.name, roomNo, qty, Number(item.price) * qty, "LEASED", todayStr(), nowIso()]
  );
  revalidatePath("/lease");
}

async function returnAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(formData.get("id") ?? 0);
  if (!id) return;
  const rec = get<{ item_id: number; qty: number }>(
    `SELECT item_id, qty FROM lease_records WHERE id = ? AND hotel_id = ? AND status = 'LEASED'`,
    [id, user.hotelId]
  );
  if (!rec) return;
  run(`UPDATE lease_records SET status = 'RETURNED', returned_at = ? WHERE id = ? AND hotel_id = ?`, [
    todayStr(),
    id,
    user.hotelId,
  ]);
  run(`UPDATE lease_items SET stock = stock + ? WHERE id = ? AND hotel_id = ?`, [rec.qty, rec.item_id, user.hotelId]);
  revalidatePath("/lease");
}

type Search = { tab?: string; err?: string; msg?: string };

export default async function LeasePage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const tab = sp.tab === "records" ? "records" : "items";
  const err = sp.err ?? "";
  const msg = sp.msg ?? "";

  run(`CREATE TABLE IF NOT EXISTS lease_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    stock INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ON',
    created_at TEXT
  )`);
  run(`CREATE TABLE IF NOT EXISTS lease_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    item_id INTEGER,
    item_name TEXT,
    room_no TEXT,
    qty INTEGER DEFAULT 1,
    amount REAL DEFAULT 0,
    status TEXT DEFAULT 'LEASED',
    leased_at TEXT,
    returned_at TEXT,
    created_at TEXT
  )`);

  const items = all<{ id: number; name: string; price: number; stock: number }>(
    `SELECT id, name, price, stock FROM lease_items WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );

  const records = all<{
    id: number;
    item_name: string | null;
    room_no: string | null;
    qty: number | null;
    amount: number | null;
    status: string | null;
    leased_at: string | null;
    returned_at: string | null;
  }>(
    `SELECT id, item_name, room_no, qty, amount, status, leased_at, returned_at
     FROM lease_records WHERE hotel_id = ? ORDER BY id DESC LIMIT 200`,
    [hotelId]
  );

  const rooms = all<{ room_no: string }>(
    `SELECT r.room_no FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE' ORDER BY r.room_no`,
    [hotelId]
  );

  return (
    <div className="space-y-3 p-4">
      <h1 className="text-[16px] font-semibold text-[#222]">物品租赁</h1>

      {/* 操作结果提示（删除被拒绝的原因必须让人看见，不能静默失败） */}
      {err && (
        <div className="rounded-[3px] border border-[#f3c6c6] bg-[#fdf3f3] px-3 py-2 text-[12px] text-[#c0392b]">
          {err}
        </div>
      )}
      {msg && (
        <div className="rounded-[3px] border border-[#cfe8d5] bg-[#f1f9f3] px-3 py-2 text-[12px] text-[#1e8e3e]">
          {msg}
        </div>
      )}

      <div className="flex gap-2">
        {TABS.map((t) => (
          <a
            key={t.key}
            href={`/lease?tab=${t.key}`}
            className={`rounded-[2px] px-3 py-1 text-[12px] ${
              tab === t.key ? "bg-[#3bd943] text-white" : "border border-[#e5e5e5] bg-white text-[#555]"
            }`}
          >
            {t.label}
          </a>
        ))}
      </div>

      {tab === "items" ? (
        <>
          <details className="rounded-[3px] border border-[#e5e5e5] bg-white">
            <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-[#2a9d5c] [&::-webkit-details-marker]:hidden">
              + 新增租赁物品
            </summary>
            <form action={saveItemAction} className="grid gap-2 border-t border-[#f0f0f0] p-3 md:grid-cols-4">
              <div>
                <label className="label">物品名称 *</label>
                <input name="name" required className="input h-7 w-full text-[12px]" />
              </div>
              <div>
                <label className="label">租金</label>
                <input name="price" type="number" defaultValue={0} className="input h-7 w-full text-[12px]" />
              </div>
              <div>
                <label className="label">库存</label>
                <input name="stock" type="number" defaultValue={1} className="input h-7 w-full text-[12px]" />
              </div>
              <div className="flex items-end">
                <button className="btn-primary h-7 w-full text-[12px]">保存</button>
              </div>
            </form>
          </details>

          <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
            <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[#fafafa]">
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">物品名称</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">租金</th>
                  <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">库存</th>
                  <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-10 text-center text-[12px] text-[#999]">
                      暂无租赁物品
                    </td>
                  </tr>
                )}
                {items.map((it) => (
                  <tr key={it.id} className="border-t border-[#f5f5f5]">
                    <td className="px-3 py-2 text-[12px] text-[#222]">{it.name}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(it.price)}</td>
                    <td className="px-3 py-2 text-right text-[12px] tabular-nums">{it.stock}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <form action={leaseOutAction} className="flex items-center gap-1">
                          <input type="hidden" name="item_id" value={it.id} />
                          <select name="room_no" className="input h-6 w-[90px] text-[11.5px]" required>
                            <option value="">房号</option>
                            {rooms.map((r) => (
                              <option key={r.room_no} value={r.room_no}>
                                {r.room_no}
                              </option>
                            ))}
                          </select>
                          <input name="qty" type="number" defaultValue={1} min={1} className="input h-6 w-[52px] text-[11.5px]" />
                          <button className="rounded-[2px] bg-[#32c141] px-2 py-0.5 text-[11.5px] text-white">
                            借出
                          </button>
                        </form>
                        <ConfirmForm
                          action={deleteItemAction}
                          message={`确认删除租赁物品「${it.name}」？`}
                          detail="删除后无法恢复；只要该物品产生过租赁记录，服务端会拒绝删除。"
                          requireReason="删除原因"
                          confirmLabel="删除"
                        >
                          <input type="hidden" name="id" value={it.id} />
                          <button className="text-[11.5px] text-[#999] hover:text-[#e53935]">删除</button>
                        </ConfirmForm>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-[3px] border border-[#e5e5e5] bg-white">
          <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-[#fafafa]">
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">物品</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">房号</th>
                <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">数量</th>
                <th className="px-3 py-2 text-right text-[12px] font-medium text-[#555]">金额</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">状态</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">借出日期</th>
                <th className="px-3 py-2 text-left text-[12px] font-medium text-[#555]">操作</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-[12px] text-[#999]">
                    暂无租赁记录
                  </td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.id} className="border-t border-[#f5f5f5]">
                  <td className="px-3 py-2 text-[12px] text-[#222]">{r.item_name ?? "—"}</td>
                  <td className="px-3 py-2 text-[12px] text-[#555]">{r.room_no ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-[12px] tabular-nums">{r.qty ?? 0}</td>
                  <td className="px-3 py-2 text-right text-[12px] tabular-nums">{fmtMoney(r.amount)}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-[2px] px-1.5 py-0.5 text-[11px] ${
                        r.status === "RETURNED" ? "bg-[#f5f5f5] text-[#999]" : "bg-[#eef9f0] text-[#2a9d5c]"
                      }`}
                    >
                      {r.status === "RETURNED" ? "已归还" : "租用中"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-[12px] tabular-nums text-[#666]">{r.leased_at ?? "—"}</td>
                  <td className="px-3 py-2">
                    {r.status !== "RETURNED" ? (
                      <form action={returnAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-[11.5px] text-[#2a9d5c] hover:underline">归还</button>
                      </form>
                    ) : (
                      <span className="text-[11.5px] text-[#bbb]">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
