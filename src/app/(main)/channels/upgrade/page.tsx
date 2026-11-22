import Link from "next/link";
import { all, get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { nowIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** 渠道侧栏菜单（与去呼呼一致） */
const SIDE_MENU = [
  { label: "携程", href: "/channels", tone: "bg-[#e8f0ff] text-[#1a5fd0]", letter: "携" },
  { label: "飞猪", href: "/channels", tone: "bg-[#fff3e0] text-[#e07b1a]", letter: "飞" },
  { label: "美团民宿", href: "/channels", tone: "bg-[#fff7d6] text-[#b8860b]", letter: "民" },
  { label: "美团酒店", href: "/channels", tone: "bg-[#fff7d6] text-[#b8860b]", letter: "美" },
  { label: "抖音", href: "/channels", tone: "bg-[#f0f0f3] text-[#161823]", letter: "抖" },
  { label: "抖音预售券", href: "/channels", tone: "bg-[#f0f0f3] text-[#161823]", letter: "券" },
  { label: "房型升级设置", href: "/channels/upgrade", tone: "bg-[#eef9f0] text-[#0f8f6f]", letter: "升" },
];

async function saveUpgradeAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const hotelId = user.hotelId;
  const fromType = Number(formData.get("from_type"));
  const toType = Number(formData.get("to_type"));
  if (!fromType || !toType || fromType === toType) return;

  run(`CREATE TABLE IF NOT EXISTS room_type_upgrades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    from_type_id INTEGER NOT NULL,
    to_type_id INTEGER NOT NULL,
    created_at TEXT,
    UNIQUE (hotel_id, from_type_id, to_type_id)
  )`);
  run(
    `INSERT OR IGNORE INTO room_type_upgrades (hotel_id, from_type_id, to_type_id, created_at) VALUES (?,?,?,?)`,
    [hotelId, fromType, toType, nowIso()]
  );
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/channels/upgrade");
}

async function deleteUpgradeAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (!id) return;
  run(`DELETE FROM room_type_upgrades WHERE id = ? AND hotel_id = ?`, [id, user.hotelId]);
  const { revalidatePath } = await import("next/cache");
  revalidatePath("/channels/upgrade");
}

export default async function RoomTypeUpgradePage() {
  const user = await requireUser();
  const hotelId = user.hotelId;

  run(`CREATE TABLE IF NOT EXISTS room_type_upgrades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    from_type_id INTEGER NOT NULL,
    to_type_id INTEGER NOT NULL,
    created_at TEXT,
    UNIQUE (hotel_id, from_type_id, to_type_id)
  )`);

  const hotel = get<{ name: string }>(`SELECT name FROM hotels WHERE id = ?`, [hotelId]);
  const types = all<{ id: number; name: string; total: number }>(
    `SELECT rt.id, rt.name, COUNT(r.id) AS total
     FROM room_types rt
     LEFT JOIN rooms r ON r.room_type_id = rt.id AND r.hotel_id = rt.hotel_id
     WHERE rt.hotel_id = ?
     GROUP BY rt.id ORDER BY rt.sort`,
    [hotelId]
  );
  const upgrades = all<{ id: number; from_type_id: number; to_type_id: number }>(
    `SELECT id, from_type_id, to_type_id FROM room_type_upgrades WHERE hotel_id = ? ORDER BY id`,
    [hotelId]
  );
  const totalRooms = types.reduce((a, t) => a + Number(t.total), 0);

  const upgradesOf = (typeId: number) =>
    upgrades
      .filter((u) => u.from_type_id === typeId)
      .map((u) => ({ ...u, type: types.find((t) => t.id === u.to_type_id) }))
      .filter((u) => u.type);

  const maxFor = (typeId: number) => {
    const base = Number(types.find((t) => t.id === typeId)?.total ?? 0);
    const extra = upgradesOf(typeId).reduce((a, u) => a + Number(u.type?.total ?? 0), 0);
    return Math.min(totalRooms, base + extra);
  };

  return (
    <div className="flex">
      {/* 左侧渠道菜单 */}
      <aside className="w-[168px] shrink-0 border-r border-[#e8e8e8] bg-white py-2">
        <div className="px-3 py-2 text-[12px] text-[#888]">多渠道房态与房量</div>
        {SIDE_MENU.map((m) => {
          const active = m.href === "/channels/upgrade";
          return (
            <Link
              key={m.label}
              href={m.href}
              className={`flex h-[34px] items-center gap-2 border-l-[3px] pl-[13px] text-[13px] ${
                active
                  ? "border-[#0f8f6f] bg-[#eef9f0] font-medium text-[#0f8f6f]"
                  : "border-transparent text-[#555] hover:bg-[#f7f9f8]"
              }`}
            >
              <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] ${m.tone}`}>
                {m.letter}
              </span>
              {m.label}
              <span className="ml-auto pr-2 text-[10px] text-[#bbb]">▾</span>
            </Link>
          );
        })}
      </aside>

      <div className="min-w-0 flex-1 p-3">
        <div className="mb-3 text-[17px] font-semibold text-[#222]">{hotel?.name ?? "当前酒店"}</div>

        <div className="overflow-x-auto rounded-[3px] border border-[#e5e5e5] bg-white">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-[#fafafa]">
                <th className="w-[220px] border-b border-r border-[#eee] px-3 py-2 text-left text-[12px] font-medium text-[#555]">
                  本地房型名称
                </th>
                <th className="border-b border-r border-[#eee] px-3 py-2 text-left text-[12px] font-medium text-[#555]">
                  升级房型
                </th>
                <th className="w-[160px] border-b border-[#eee] px-3 py-2 text-right text-[12px] font-medium text-[#555]">
                  可设置房量最大值（间）
                </th>
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const list = upgradesOf(t.id);
                return (
                  <tr key={t.id} className="border-b border-[#f0f0f0]">
                    <td className="border-r border-[#f0f0f0] px-3 py-3 align-top text-[13px] text-[#222]">
                      {t.name}
                      <span className="ml-1 text-[11px] text-[#999]">（{t.total}间）</span>
                    </td>
                    <td className="border-r border-[#f0f0f0] px-3 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        {list.map((u) => (
                          <span
                            key={u.id}
                            className="inline-flex items-center gap-1 rounded-[2px] border border-[#e5e5e5] bg-[#f7f8f9] px-2 py-0.5 text-[12px] text-[#555]"
                          >
                            {u.type?.name}（{u.type?.total}间）
                            <form action={deleteUpgradeAction} className="inline">
                              <input type="hidden" name="id" value={u.id} />
                              <button className="text-[11px] text-[#e53935] hover:underline">删除</button>
                            </form>
                          </span>
                        ))}
                        <details className="relative inline-block">
                          <summary className="cursor-pointer list-none rounded-[2px] bg-[#3bd943] px-2 py-0.5 text-[12px] text-white hover:bg-[#33cd3b] [&::-webkit-details-marker]:hidden">
                            添加可升级房型
                          </summary>
                          <form
                            action={saveUpgradeAction}
                            className="absolute left-0 z-20 mt-1 flex w-[220px] flex-col gap-1.5 rounded border border-[#e5e5e5] bg-white p-2 shadow-lg"
                          >
                            <input type="hidden" name="from_type" value={t.id} />
                            <select name="to_type" className="input py-1 text-[12px]" required>
                              <option value="">选择升级房型</option>
                              {types
                                .filter((x) => x.id !== t.id)
                                .map((x) => (
                                  <option key={x.id} value={x.id}>
                                    {x.name}（{x.total}间）
                                  </option>
                                ))}
                            </select>
                            <button className="rounded-[2px] bg-[#3bd943] py-1 text-[12px] text-white">确认添加</button>
                          </form>
                        </details>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right text-[13px] tabular-nums text-[#333]">{maxFor(t.id)}</td>
                  </tr>
                );
              })}
              {types.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-3 py-12 text-center text-[12px] text-[#999]">
                    暂无房型数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-[11px] text-[#999]">
          可设置房量最大值 = 本地房型房量 + 所有升级房型房量（不超过全酒店总房量 {totalRooms} 间）；用于 OTA 超售时把客人升级到更大房型。
        </p>
      </div>
    </div>
  );
}
