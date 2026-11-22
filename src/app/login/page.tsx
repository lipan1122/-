import DemoLoginFill, { type DemoAccount } from "@/components/DemoLoginFill";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const sp = await searchParams;
  const hasError = sp.error === "1";
  /* 整改 P2-4：同名账号在多店重复时，登录接口回跳 ?error=dup，提示补充酒店标识 */
  const dupError = sp.error === "dup";

  /*
   * 整改清单 P1-37：这里原来跑了一条**没有 hotel_id 条件**的聚合查询，
   * 把全平台（所有门店合计）的房间数 / 在住数 / 订单数渲染在登录页上：
   *
   *   SELECT (SELECT COUNT(*) FROM rooms) AS rooms,
   *          (SELECT COUNT(*) FROM stays WHERE status = 'INHOUSE') AS inhouse,
   *          (SELECT COUNT(*) FROM bookings) AS orders
   *
   * /login 是匿名页（src/middleware.ts 的 matcher 排除了 login），
   * 任何未登录访客打开登录页就能看到全平台房量、在住与历史订单规模 ——
   * 单店部署时只是「泄露经营底数」，一旦多店部署就是跨租户数据泄露。
   * scripts/scan-tenant-isolation.mjs 报的 25 处待复核里，这是唯一一处真漏洞。
   *
   * 处理：整段查询与 rooms / inhouse / occupancy 三个变量一起删除，
   * 左侧宣传区改为不含任何真实数据的静态文案。
   * 需要展示经营数据的话，去登录后的 /dashboard（按 user.hotelId 查询）。
   */

  /*
   * 演示账号一键填入（上线前安全加固的可控版本）
   *
   * 上线前审计指出「登录页明文展示 admin/admin123」是高危问题，已删。
   * 但演示/自测时手输 4 个账号很麻烦，所以加这个「点一下填入」，
   * 由环境变量 PMS_DEMO_LOGIN 控制：
   *   · "0"      → 完全不渲染（生产环境用这个）
   *   · 其他/未设 → 渲染（本地演示、培训、验收用）
   *
   * 账号口令只在这里出现一次（服务端），组件本身不写死，
   * 改演示账号时只改这一处。
   */
  const demoLoginEnabled = process.env.PMS_DEMO_LOGIN !== "0";
  const demoAccounts: DemoAccount[] = demoLoginEnabled
    ? [
        { label: "管理员", username: "admin", password: "admin123" },
        { label: "前台", username: "front", password: "123456" },
        { label: "收银", username: "cashier", password: "123456" },
        { label: "客房", username: "housekeeper", password: "123456" },
      ]
    : [];

  return (
    <div className="flex min-h-screen">
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-[#16233d] p-12 text-white lg:flex">
        <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-brand-600/30 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold">
              云
            </div>
            <div>
              <div className="text-lg font-semibold">云栖 PMS</div>
              <div className="text-xs text-gray-400">酒店管理系统 · Hotel Management</div>
            </div>
          </div>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-snug">
            从预订到结账，
            <br />
            一个页面管好整家酒店。
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-gray-400">
            实时房态、快速入住、账务清晰、夜审自动过账。为中小酒店前台量身设计，三分钟上手。
          </p>
          {/*
            整改清单 P1-37：这里原来是「间客房 / 间在住 / 出租率」三个跨租户聚合数字。
            现在换成不含任何真实数据的静态卖点 —— 登录页不需要、也不该展示经营数据。
          */}
          <div className="mt-8 grid grid-cols-3 gap-3 text-center">
            {[
              ["房态", "实时房态图"],
              ["账务", "押金到结清"],
              ["权限", "按岗位配置"],
            ].map(([title, desc]) => (
              <div key={title} className="rounded-lg border border-white/10 bg-white/5 px-3 py-3">
                <div className="text-sm font-semibold">{title}</div>
                <div className="mt-0.5 text-[11px] text-gray-400">{desc}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="relative text-[11px] text-gray-500">
          © 2026 云栖酒店科技 · 演示环境数据均为模拟
        </div>
      </div>

      <div className="flex w-full items-center justify-center bg-gray-50 px-6 lg:w-[440px]">
        <div className="w-full max-w-[340px]">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white">
                云
              </div>
              <span className="text-base font-semibold">云栖 PMS</span>
            </div>
          </div>
          <h2 className="text-xl font-semibold text-gray-900">登录工作台</h2>
          <p className="mt-1 text-[13px] text-gray-500">使用酒店分配的工号登录</p>

          <form action="/api/login" method="post" className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="username">账号</label>
              <input id="username" name="username" className="input py-2" placeholder="请输入账号" autoComplete="username" />
            </div>
            <div>
              <label className="label" htmlFor="password">密码</label>
              <input
                id="password"
                name="password"
                type="password"
                className="input py-2"
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </div>
            {/*
              整改 P2-4：多店部署时的可选酒店标识。
              单店留空即可，登录接口按 username 查到唯一一行就正常登录；
              留空且出现同名账号时接口会返回「账号在多店重复」，引导到这里填写。
              填 hotels.code（如 YQ）或酒店数字 ID 都行 —— 两者接口都认。
            */}
            <div>
              <label className="label" htmlFor="hotel_code">
                酒店标识（多店部署时填写，单店留空）
              </label>
              <input
                id="hotel_code"
                name="hotel_code"
                className="input py-2"
                placeholder="如 YQ 或 1，单店可留空"
                autoComplete="organization"
              />
            </div>
            {hasError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-600">
                账号或密码不正确
              </div>
            )}
            {dupError && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
                该账号在多店重复，请填写酒店标识后重新登录
              </div>
            )}
            <button type="submit" className="btn-primary w-full py-2">
              登 录
            </button>
          </form>

          {/* 一键填入演示账号（PMS_DEMO_LOGIN=0 时不渲染） */}
          {demoLoginEnabled && <DemoLoginFill accounts={demoAccounts} />}
        </div>
      </div>
    </div>
  );
}
