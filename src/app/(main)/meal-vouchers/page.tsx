import { all, get, run } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { todayStr } from "@/lib/utils";
import { BreakfastBoard } from "@/components/BreakfastBoard";

export const dynamic = "force-dynamic";

type Search = { room?: string };

export default async function MealVouchersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const hotelId = user.hotelId;
  const sp = await searchParams;
  const today = todayStr();
  void sp;

  run(`CREATE TABLE IF NOT EXISTS breakfast_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    stay_id INTEGER,
    room_no TEXT,
    guest_name TEXT,
    date TEXT,
    count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'PENDING',
    note TEXT,
    created_at TEXT
  )`);

  const rows = all<{ room_no: string; breakfast: number | null; guest_name: string | null; used: number | null }>(
    `SELECT r.room_no, s.breakfast, s.guest_name,
            (SELECT COUNT(*) FROM breakfast_records b
              WHERE b.hotel_id = s.hotel_id AND b.room_no = r.room_no AND b.date = ? AND b.status = 'USED') AS used
     FROM stays s JOIN rooms r ON r.id = s.room_id
     WHERE s.hotel_id = ? AND s.status = 'INHOUSE'
     ORDER BY r.room_no`,
    [today, hotelId]
  );

  const roomOptions = rows.map((r) => ({ roomNo: r.room_no, guestName: r.guest_name }));

  /** 核销今日早餐 */
  async function verifyBreakfast(roomNo: string) {
    "use server";
    const me = await requireUser();
    const stay = get<{ id: number; guest_name: string | null; breakfast: number | null }>(
      `SELECT s.id, s.guest_name, s.breakfast FROM stays s JOIN rooms r ON r.id = s.room_id
       WHERE s.hotel_id = ? AND r.room_no = ? AND s.status = 'INHOUSE' LIMIT 1`,
      [me.hotelId, roomNo]
    );
    const count = Math.max(0, Number(stay?.breakfast ?? 0));
    const existing = get<{ id: number }>(
      `SELECT id FROM breakfast_records WHERE hotel_id = ? AND room_no = ? AND date = ?`,
      [me.hotelId, roomNo, todayStr()]
    );
    if (existing) {
      run(`UPDATE breakfast_records SET status = 'USED', count = ?, stay_id = ? WHERE id = ? AND hotel_id = ?`, [
        count,
        stay?.id ?? null,
        existing.id,
        me.hotelId,
      ]);
    } else {
      run(
        `INSERT INTO breakfast_records (hotel_id, stay_id, room_no, guest_name, date, count, status, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [me.hotelId, stay?.id ?? null, roomNo, stay?.guest_name ?? null, todayStr(), count, "USED", new Date().toISOString()]
      );
    }
    revalidatePath("/meal-vouchers");
  }

  /** 购买早餐（给房间加份数） */
  async function buyBreakfast(roomNo: string, qty: number) {
    "use server";
    const me = await requireUser();
    const stay = get<{ id: number }>(
      `SELECT s.id FROM stays s JOIN rooms r ON r.id = s.room_id
       WHERE s.hotel_id = ? AND r.room_no = ? AND s.status = 'INHOUSE' LIMIT 1`,
      [me.hotelId, roomNo]
    );
    if (!stay) return;
    run(`UPDATE stays SET breakfast = COALESCE(breakfast, 0) + ? WHERE id = ? AND hotel_id = ?`, [
      qty,
      stay.id,
      me.hotelId,
    ]);
    revalidatePath("/meal-vouchers");
  }

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[16px] font-semibold text-[#222]">餐券核销</h1>
        <span className="text-[11.5px] text-[#888]">点击核销即时生效，无需刷新</span>
      </div>
      <BreakfastBoard
        rows={rows.map((r) => ({
          roomNo: r.room_no,
          guestName: r.guest_name,
          breakfast: Number(r.breakfast ?? 0),
          used: Number(r.used ?? 0),
        }))}
        rooms={roomOptions}
        verify={verifyBreakfast}
        buy={buyBreakfast}
      />
    </div>
  );
}
