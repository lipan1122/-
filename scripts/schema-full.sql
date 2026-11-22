CREATE TABLE hotels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT, phone TEXT, logo TEXT,
  created_at TEXT
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  password TEXT NOT NULL,
  real_name TEXT,
  role TEXT NOT NULL DEFAULT 'frontdesk',
  status INTEGER DEFAULT 1, position_id INTEGER, last_login_at TEXT, mobile TEXT, password_hash TEXT, must_change_password INTEGER DEFAULT 0,
  UNIQUE(hotel_id, username)
);

CREATE TABLE room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  bed_type TEXT, area REAL,
  max_occupancy INTEGER DEFAULT 2,
  base_price REAL DEFAULT 0,
  sort INTEGER DEFAULT 0
  -- 第九轮《微信小程序专项》第二节 / 第 81 行：房型详情展示字段。
  -- 数据库原来没有这几列，小程序只能写死假图假设施；补列后 NULL = 酒店未配置，
  -- 接口返回 null 并标注「未配置」，不做任何编造。与 scripts/migrate-all.mjs
  -- 第 12.3 段的 addColumn 一一对应（老库靠迁移补齐，全新库建表就带）。
, images TEXT, facilities TEXT, breakfast_note TEXT, cancellation_policy TEXT, check_in_time TEXT, check_out_time TEXT, deposit_note TEXT
);

CREATE TABLE rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_no TEXT NOT NULL,
  floor INTEGER,
  room_type_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'VC',
  feature TEXT,
  sort INTEGER DEFAULT 0,
  UNIQUE(hotel_id, room_no)
);

CREATE TABLE rate_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_type_id INTEGER,
  name TEXT, price REAL,
  start_date TEXT, end_date TEXT,
  is_default INTEGER DEFAULT 0
);

CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT, commission REAL DEFAULT 0,
  channel_type TEXT DEFAULT 'direct',
  store_id TEXT, app_key TEXT, app_secret TEXT,
  enabled INTEGER DEFAULT 0,
  last_sync_at TEXT, auto_import INTEGER DEFAULT 0
, sort INTEGER DEFAULT 100, oversell INTEGER DEFAULT 0, sandbox INTEGER DEFAULT 1, endpoint TEXT, app_secret_enc TEXT, last_order_sync_at TEXT);

CREATE TABLE channel_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  channel_type TEXT NOT NULL,
  channel_order_no TEXT NOT NULL,
  room_type_id INTEGER, guest_name TEXT, mobile TEXT,
  check_in_date TEXT, check_out_date TEXT, nights INTEGER,
  room_count INTEGER DEFAULT 1, amount REAL DEFAULT 0,
  status TEXT DEFAULT 'NEW',
  booking_id INTEGER, raw TEXT,
  created_at TEXT, imported_at TEXT
);

CREATE TABLE channel_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  channel_type TEXT, action TEXT, status TEXT, message TEXT, created_at TEXT
, error_code TEXT, retry_count INTEGER DEFAULT 0, next_retry_at TEXT, request_no TEXT, channel_order_no TEXT, finished_at TEXT, duration_ms INTEGER, success_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, booking_id INTEGER, folio_id INTEGER);

CREATE TABLE guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  gender TEXT, id_type TEXT, id_no TEXT, mobile TEXT,
  company TEXT, vip_level INTEGER DEFAULT 0, blacklist INTEGER DEFAULT 0,
  note TEXT, created_at TEXT
, deleted INTEGER DEFAULT 0);

CREATE TABLE companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT, contact TEXT, phone TEXT,
  discount REAL DEFAULT 1.0, credit_limit REAL DEFAULT 0
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  booking_no TEXT NOT NULL,
  guest_id INTEGER, guest_name TEXT, mobile TEXT,
  room_type_id INTEGER, room_id INTEGER,
  channel_id INTEGER, company_id INTEGER,
  check_in_date TEXT NOT NULL, check_out_date TEXT NOT NULL,
  nights INTEGER, room_count INTEGER DEFAULT 1, guest_count INTEGER DEFAULT 1,
  rate REAL DEFAULT 0, deposit REAL DEFAULT 0,
  status TEXT DEFAULT 'PENDING',
  guarantee TEXT, remark TEXT,
  booking_type TEXT DEFAULT 'guest',
  team_name TEXT, member_card TEXT, member_type TEXT,
  arrival_time TEXT, rate_code TEXT, salesman TEXT,
  package_code TEXT, invoice_party TEXT DEFAULT '酒店',
  retain_time TEXT, pay_type TEXT DEFAULT '到店付款',
  breakfast INTEGER DEFAULT 0, channel_order_no TEXT,
  created_by INTEGER, created_at TEXT, updated_at TEXT
, total_price REAL
-- 小程序下单幂等键（整改清单第 109 行「request_id 幂等 / 网络超时重试不重复建单」）。
-- 同一 (hotel_id, mini_request_id) 只能建一张订单；NULL = 历史单 / 非小程序单，
-- 不参与部分唯一索引（见下方 idx_bookings_mini_request）。
, mini_request_id TEXT);

CREATE TABLE stays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  stay_no TEXT NOT NULL,
  booking_id INTEGER, room_id INTEGER NOT NULL,
  guest_id INTEGER, guest_name TEXT, mobile TEXT,
  check_in_time TEXT, expect_check_out TEXT, actual_check_out TEXT,
  nights INTEGER, rate REAL NOT NULL, deposit REAL DEFAULT 0,
  guest_count INTEGER DEFAULT 1,
  status TEXT DEFAULT 'INHOUSE',
  channel_id INTEGER, remark TEXT,
  team_name TEXT, member_card TEXT, member_type TEXT,
  rate_code TEXT, salesman TEXT, package_code TEXT,
  invoice_party TEXT DEFAULT '酒店', pay_type TEXT DEFAULT '到店付款',
  breakfast INTEGER DEFAULT 0,
  created_by INTEGER, created_at TEXT
, channel_order_no TEXT);

CREATE TABLE folios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_no TEXT NOT NULL,
  stay_id INTEGER, guest_name TEXT, room_no TEXT,
  total_amount REAL DEFAULT 0, paid_amount REAL DEFAULT 0, balance REAL DEFAULT 0,
  status TEXT DEFAULT 'OPEN',
  created_at TEXT, settled_at TEXT
);

CREATE TABLE folio_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_id INTEGER NOT NULL,
  item_type TEXT NOT NULL,
  description TEXT,
  qty REAL DEFAULT 1, price REAL DEFAULT 0, amount REAL DEFAULT 0,
  biz_date TEXT, created_at TEXT, created_by INTEGER
, request_id TEXT);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  folio_id INTEGER, stay_id INTEGER,
  pay_no TEXT, method TEXT, amount REAL,
  biz_date TEXT, remark TEXT, created_at TEXT
, request_id TEXT, refund_of INTEGER, operator TEXT
-- 收款性质（第九轮 P1-2）：押金不能再靠备注识别
-- ROOM_PAYMENT 房费收款 / DEPOSIT 押金收取 / DEPOSIT_REFUND 押金退款
-- ROOM_REFUND 房费退款 / OTHER_PAYMENT 其他收款；NULL = 旧数据待核对
, kind TEXT);

CREATE TABLE room_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_id INTEGER, from_status TEXT, to_status TEXT,
  reason TEXT, operator TEXT, created_at TEXT
);

CREATE TABLE housekeeping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_id INTEGER, task_type TEXT,
  status TEXT DEFAULT 'PENDING',
  assignee TEXT, note TEXT, created_at TEXT, done_at TEXT
, photos TEXT, room_status_snapshot TEXT);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  key TEXT NOT NULL, value TEXT
);

CREATE TABLE op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  operator TEXT, action TEXT, detail TEXT, created_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_json TEXT NOT NULL,
  created_at TEXT,
  expires_at TEXT
);

CREATE TABLE notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  author TEXT,
  level TEXT DEFAULT 'normal',
  created_at TEXT
);

CREATE TABLE lost_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  room_no TEXT, guest_name TEXT, mobile TEXT,
  found_at TEXT, keeper TEXT,
  status TEXT DEFAULT 'KEEPING',
  note TEXT, created_at TEXT
, claimed_at TEXT);

CREATE TABLE quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  room_type_id INTEGER,
  price REAL,
  start_date TEXT, end_date TEXT,
  note TEXT, created_at TEXT
);

CREATE TABLE dummy_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  name TEXT NOT NULL, code TEXT, category TEXT DEFAULT '其他',
  status INTEGER DEFAULT 1, note TEXT, created_at TEXT
);

CREATE TABLE meal_vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      type TEXT NOT NULL,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'UNUSED',
      used_at TEXT,
      created_at TEXT
    );

CREATE TABLE shop_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      barcode TEXT,
      price REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      category TEXT,
      status TEXT DEFAULT 'ON',
      created_at TEXT
    );

CREATE TABLE rate_calendar (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      room_type_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      updated_at TEXT, allotment INTEGER,
      UNIQUE (hotel_id, room_type_id, date)
    );

CREATE TABLE package_code (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      breakfast_count INTEGER NOT NULL DEFAULT 0,
      items TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT,
      UNIQUE (hotel_id, code)
    );

CREATE TABLE salesmen (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      commission_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );

CREATE TABLE roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT,
      UNIQUE (hotel_id, code)
    );

CREATE TABLE stay_companions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      mobile TEXT,
      id_no TEXT,
      created_at TEXT
    );

CREATE TABLE wake_up_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      wake_time TEXT NOT NULL,
      note TEXT,
      status TEXT DEFAULT 'PENDING',
      created_at TEXT
    );

CREATE TABLE sms_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      mobile TEXT,
      content TEXT NOT NULL,
      status TEXT DEFAULT 'SENT',
      created_at TEXT
    );

CREATE TABLE room_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      link_no TEXT NOT NULL,
      stay_id INTEGER NOT NULL,
      created_at TEXT
    );

CREATE TABLE member_wallet (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      amount REAL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'RECHARGE',
      note TEXT,
      created_at TEXT
    , member_id INTEGER, balance REAL DEFAULT 0, updated_at TEXT);

CREATE TABLE member_wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      guest_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      balance_after REAL NOT NULL,
      note TEXT,
      operator TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE rental_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      price REAL DEFAULT 0,
      deposit REAL DEFAULT 0,
      stock INTEGER DEFAULT 0,
      status TEXT DEFAULT 'ON',
      created_at TEXT
    );

CREATE TABLE rental_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      stay_id INTEGER,
      room_no TEXT,
      guest_name TEXT,
      qty INTEGER DEFAULT 1,
      deposit REAL DEFAULT 0,
      rent_at TEXT,
      return_at TEXT,
      status TEXT DEFAULT 'RENTED'
    );

CREATE TABLE id_verify_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT,
    id_no TEXT,
    result TEXT,
    operator TEXT,
    created_at TEXT
  );

CREATE TABLE sms_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scene TEXT NOT NULL DEFAULT 'CHECKIN',
  status TEXT NOT NULL DEFAULT 'ENABLED',
  created_at TEXT
);

CREATE TABLE sms_sends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  template_id INTEGER,
  mobile TEXT NOT NULL,
  guest_name TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'SENT',
  error TEXT,
  sent_at TEXT
);

CREATE TABLE ar_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        credit_limit REAL DEFAULT 0,
        balance REAL DEFAULT 0,
        status TEXT DEFAULT 'ON',
        contact TEXT,
        phone TEXT,
        created_at TEXT NOT NULL
      );

CREATE TABLE ar_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        ar_account_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_after REAL NOT NULL,
        note TEXT,
        operator TEXT,
        biz_date TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

CREATE TABLE ar_write_offs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        ar_account_id INTEGER NOT NULL,
        transaction_id INTEGER,
        -- 第九轮 P1-3：核销同时冲减协议单位逐笔台账，这里记录被冲减的 ar_ledgers.id
        ar_ledger_id INTEGER,
        amount REAL NOT NULL,
        note TEXT,
        operator TEXT,
        created_at TEXT NOT NULL
      );

CREATE TABLE score_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      ratio REAL NOT NULL DEFAULT 1,
      valid_from TEXT,
      valid_to TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      UNIQUE (hotel_id, code)
    );

CREATE TABLE score_goods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      stock INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      note TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE score_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      guest_id INTEGER NOT NULL,
      guest_name TEXT NOT NULL,
      type TEXT NOT NULL,
      points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      note TEXT,
      operator TEXT,
      created_at TEXT NOT NULL
    );

CREATE TABLE breakfast_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      stay_id INTEGER NOT NULL,
      room_no TEXT,
      guest_name TEXT,
      date TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      note TEXT,
      created_at TEXT
    );

CREATE TABLE cleaners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    , area TEXT, room_count INTEGER DEFAULT 0);

CREATE TABLE goods_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ON',
    created_at TEXT NOT NULL
  );

CREATE TABLE goods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    category_id INTEGER,
    name TEXT NOT NULL,
    barcode TEXT,
    unit TEXT NOT NULL DEFAULT '件',
    cost_price REAL NOT NULL DEFAULT 0,
    sell_price REAL NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    warn_stock INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ON',
    created_at TEXT NOT NULL
  );

CREATE TABLE goods_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    goods_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  );

CREATE TABLE debit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      price REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );

CREATE TABLE credit_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT '现金',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );

CREATE TABLE member_card_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      discount REAL NOT NULL DEFAULT 1,
      points_ratio REAL NOT NULL DEFAULT 1,
      min_recharge REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );

CREATE TABLE recharge_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      amount REAL NOT NULL DEFAULT 0,
      gift_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT
    );

CREATE TABLE floors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 99,
      created_at TEXT
    );

CREATE TABLE rate_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT '门市价',
      discount REAL NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT, sort INTEGER DEFAULT 99, package_code TEXT,
      UNIQUE (hotel_id, code)
    );

CREATE TABLE positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      permissions TEXT NOT NULL DEFAULT '[]',
      created_at TEXT
    );

CREATE TABLE dict_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      sort INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    );

CREATE TABLE lock_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_no TEXT NOT NULL,
    card_no TEXT NOT NULL,
    action TEXT NOT NULL,
    operator TEXT,
    created_at TEXT
  );

CREATE TABLE lock_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    card_no TEXT NOT NULL,
    room_no TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'VALID',
    valid_from TEXT,
    valid_to TEXT,
    created_at TEXT
  );

CREATE TABLE cancel_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  stay_id INTEGER,
  room_no TEXT,
  guest_name TEXT,
  reason TEXT,
  status TEXT DEFAULT 'PENDING',
  requested_by TEXT,
  approved_by TEXT,
  created_at TEXT,
  approved_at TEXT
);

CREATE TABLE hourly_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hotel_id INTEGER NOT NULL,
      room_type_id INTEGER NOT NULL,
      base_hours REAL NOT NULL DEFAULT 4,
      base_price REAL NOT NULL DEFAULT 0,
      overtime_rate REAL NOT NULL DEFAULT 0,
      full_day_rule TEXT NOT NULL DEFAULT '满 8 小时按全天房费收取',
      created_at TEXT,
      UNIQUE (hotel_id, room_type_id)
    );

CREATE TABLE cleaning_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    task_type TEXT NOT NULL DEFAULT '保洁',
    floor TEXT NOT NULL DEFAULT '所有楼层',
    room_type TEXT NOT NULL DEFAULT '所有房型',
    points INTEGER NOT NULL DEFAULT 0,
    work_items TEXT,
    restock_items TEXT,
    created_at TEXT
  );

CREATE TABLE lock_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    room_id INTEGER NOT NULL,
    lock_code TEXT,
    status TEXT NOT NULL DEFAULT 'BOUND',
    signal INTEGER,
    battery INTEGER,
    bound_at TEXT,
    UNIQUE (hotel_id, room_id)
  );

CREATE TABLE room_type_upgrades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    from_type_id INTEGER NOT NULL,
    to_type_id INTEGER NOT NULL,
    created_at TEXT,
    UNIQUE (hotel_id, from_type_id, to_type_id)
  );

CREATE TABLE shop_sales (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, item_name TEXT, qty INTEGER DEFAULT 1, amount REAL DEFAULT 0, method TEXT, room_no TEXT, created_at TEXT, request_id TEXT);

CREATE TABLE shop_stock_flows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    qty INTEGER NOT NULL,
    stock_after INTEGER NOT NULL,
    unit_price REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL DEFAULT 0,
    sale_id INTEGER,
    request_id TEXT,
    note TEXT,
    operator TEXT,
    created_at TEXT NOT NULL
  );

CREATE TABLE channel_room_types (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, channel_type TEXT, channel_room_name TEXT, room_type_id INTEGER, created_at TEXT);

CREATE TABLE channel_stores (id INTEGER PRIMARY KEY AUTOINCREMENT, hotel_id INTEGER NOT NULL, channel_type TEXT, channel_hotel_id TEXT, channel_hotel_name TEXT, version TEXT DEFAULT '1.0', order_sync INTEGER DEFAULT 1, status_sync INTEGER DEFAULT 1, price_sync INTEGER DEFAULT 0, created_at TEXT);

CREATE TABLE lease_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    stock INTEGER DEFAULT 0,
    status TEXT DEFAULT 'ON',
    created_at TEXT
  );

CREATE TABLE lease_records (
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
  );

CREATE TABLE "night_audits" (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hotel_id INTEGER NOT NULL,
    biz_date TEXT NOT NULL,
    status TEXT,
    rooms_sold INTEGER DEFAULT 0,
    revenue REAL DEFAULT 0,
    occupancy REAL DEFAULT 0,
    operator TEXT,
    created_at TEXT, revenue_room REAL DEFAULT 0, revenue_food REAL DEFAULT 0, revenue_other REAL DEFAULT 0, refund_total REAL DEFAULT 0, revenue_net REAL DEFAULT 0, hourly_rooms INTEGER DEFAULT 0,
    UNIQUE(hotel_id, biz_date)
  );

CREATE TABLE booking_rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL,
  room_type_id INTEGER,
  room_id INTEGER,
  guest_name TEXT,
  mobile TEXT,
  rate REAL DEFAULT 0,
  status TEXT DEFAULT 'PENDING',
  check_in_date TEXT,
  check_out_date TEXT,
  stay_id INTEGER,
  created_at TEXT
, guest_id INTEGER);

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  biz_date TEXT NOT NULL,
  shift_code TEXT NOT NULL,
  shift_name TEXT,
  start_at TEXT,
  end_at TEXT,
  operator TEXT,
  receiver TEXT,
  opening_cash REAL DEFAULT 0,
  cash_in REAL DEFAULT 0,
  cash_out REAL DEFAULT 0,
  expect_cash REAL DEFAULT 0,
  actual_cash REAL DEFAULT 0,
  diff REAL DEFAULT 0,
  pay_summary TEXT,
  note TEXT,
  status TEXT DEFAULT 'OPEN',
  created_at TEXT
);

CREATE TABLE room_anomalies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hotel_id INTEGER NOT NULL,
  room_id INTEGER,
  room_no TEXT,
  anomaly_type TEXT NOT NULL,
  detail TEXT,
  detected_at TEXT,
  resolved_at TEXT,
  resolved_by TEXT,
  note TEXT
);

CREATE TABLE member_wallet_ledger (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          member_id INTEGER NOT NULL,
          biz_type TEXT NOT NULL,
          amount REAL NOT NULL,
          balance_after REAL NOT NULL,
          ref_type TEXT,
          ref_id INTEGER,
          request_id TEXT,
          operator TEXT,
          remark TEXT,
          created_at TEXT
        );

CREATE TABLE ar_ledgers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          company_id INTEGER NOT NULL,
          folio_id INTEGER,
          folio_no TEXT,
          biz_date TEXT NOT NULL,
          amount REAL NOT NULL,
          settled_amount REAL DEFAULT 0,
          due_date TEXT,
          status TEXT DEFAULT 'OPEN',
          -- 第九轮 P1-3：明细类型。CHARGE 正常挂账/入账 / TRANSFER_IN 从其他 AR 账户转入
          -- （增加本单位应收）/ TRANSFER_OUT 调账转出的审计行（amount = settled，净额 0）
          kind TEXT DEFAULT 'CHARGE',
          operator TEXT,
          remark TEXT,
          created_at TEXT
        );

CREATE TABLE invoices (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          invoice_no TEXT NOT NULL,
          invoice_type TEXT DEFAULT 'NORMAL',
          title TEXT NOT NULL,
          tax_no TEXT,
          amount REAL NOT NULL,
          folio_id INTEGER,
          folio_no TEXT,
          stay_id INTEGER,
          guest_name TEXT,
          room_no TEXT,
          biz_date TEXT NOT NULL,
          operator TEXT,
          remark TEXT,
          red_of INTEGER,
          status TEXT DEFAULT 'ISSUED',
          created_at TEXT
        );

CREATE TABLE mini_program_config (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          app_id TEXT,
          app_secret TEXT,
          mch_id TEXT,
          mch_key TEXT,
          enabled INTEGER DEFAULT 0,
          updated_at TEXT,
          UNIQUE(hotel_id)
        );

CREATE TABLE mini_program_users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          openid TEXT NOT NULL,
          unionid TEXT,
          guest_id INTEGER,
          mobile TEXT,
          session_token TEXT,
          token_expires_at TEXT,
          created_at TEXT,
          updated_at TEXT
        , bind_attempts INTEGER DEFAULT 0, bind_locked_until TEXT);

CREATE TABLE channel_sync_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          reason TEXT,
          status TEXT DEFAULT 'PENDING',
          attempts INTEGER DEFAULT 0,
          created_at TEXT,
          done_at TEXT
        , next_attempt_at TEXT, last_error TEXT);

CREATE TABLE role_modules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        module TEXT NOT NULL,
        created_at TEXT
      );

CREATE TABLE role_permissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        permission TEXT NOT NULL,
        created_at TEXT
      );

CREATE TABLE permission_dict (
        permission TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        module TEXT,
        description TEXT
      );

CREATE TABLE login_attempts (
      login_key   TEXT PRIMARY KEY,
      fail_count  INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at  TEXT
    );

CREATE TABLE mini_program_bookings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          booking_id INTEGER NOT NULL,
          created_at TEXT,
          UNIQUE(hotel_id, booking_id)
        );

-- 小程序站内通知（第九轮 第三节 / 第 302 行「通知必须只发给对应 mini_user_id」）。
-- 收件人唯一键是 mini_user_id（mini_program_users.id，由服务端 token 解析）；
-- 刻意不存 mobile / guest_id —— 有手机号列就一定有人写出「按手机号群发」的 SQL。
-- read_at 为时间戳（NULL = 未读），既支持未读角标也保留首次阅读时间。
CREATE TABLE mini_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          read_at TEXT,
          created_at TEXT,
          ref_type TEXT,
          ref_id INTEGER
        );

CREATE TABLE mini_service_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hotel_id INTEGER NOT NULL,
          mini_user_id INTEGER NOT NULL,
          guest_id INTEGER,
          stay_id INTEGER,
          booking_id INTEGER,
          service_type TEXT NOT NULL,
          status TEXT DEFAULT 'PENDING',
          request_id TEXT,
          note TEXT,
          operator TEXT,
          created_at TEXT,
          updated_at TEXT,
          completed_at TEXT
        );

CREATE TABLE channel_rate_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT NOT NULL,
        rate_code TEXT NOT NULL,
        channel_rate_name TEXT,
        factor REAL DEFAULT 1,
        room_type_id INTEGER,
        created_at TEXT
      );

CREATE TABLE channel_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT NOT NULL,
        biz_date TEXT NOT NULL,
        order_no TEXT,
        gross_amount REAL DEFAULT 0,
        commission_amount REAL DEFAULT 0,
        net_amount REAL DEFAULT 0,
        source TEXT DEFAULT 'derived',
        raw TEXT,
        created_at TEXT
      );

CREATE TABLE channel_sync_dead_letter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hotel_id INTEGER NOT NULL,
        channel_type TEXT,
        action TEXT,
        log_id INTEGER,
        error_code TEXT,
        message TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT
      );

CREATE INDEX idx_ar_tx_account ON ar_transactions (hotel_id, ar_account_id, biz_date);

CREATE INDEX idx_ar_wo_account ON ar_write_offs (hotel_id, ar_account_id);

CREATE INDEX idx_score_records_guest ON score_records (hotel_id, guest_id);

CREATE INDEX idx_score_records_type ON score_records (hotel_id, type);

CREATE INDEX idx_goods_hotel ON goods (hotel_id, status);

CREATE INDEX idx_goods_flows_hotel ON goods_flows (hotel_id, goods_id, type);

CREATE UNIQUE INDEX idx_payments_request ON payments(hotel_id, request_id) WHERE request_id IS NOT NULL;

-- 押金报表 / 退款识别按 kind 查询（第九轮 P1-2：不再 LIKE 备注）
CREATE INDEX idx_payments_kind ON payments(hotel_id, kind, biz_date);

-- 核销记录反查被冲减的协议单位台账
CREATE INDEX idx_ar_wo_ledger ON ar_write_offs(hotel_id, ar_ledger_id) WHERE ar_ledger_id IS NOT NULL;

CREATE UNIQUE INDEX idx_channel_orders_key ON channel_orders(hotel_id, channel_type, channel_order_no);

CREATE INDEX idx_booking_rooms_booking ON booking_rooms(booking_id);

CREATE INDEX idx_booking_rooms_room ON booking_rooms(room_id);

CREATE UNIQUE INDEX idx_booking_rooms_occupied
  ON booking_rooms(room_id, check_in_date, check_out_date)
  WHERE room_id IS NOT NULL AND status IN ('CONFIRMED','CHECKED_IN');

CREATE INDEX idx_shifts_hotel_date ON shifts(hotel_id, biz_date);

CREATE UNIQUE INDEX idx_shifts_open ON shifts(hotel_id, operator) WHERE status = 'OPEN';

CREATE UNIQUE INDEX idx_companies_name ON companies(hotel_id, name);

CREATE INDEX idx_room_anomalies_open ON room_anomalies(hotel_id, resolved_at) WHERE resolved_at IS NULL;

CREATE INDEX idx_wallet_ledger_member ON member_wallet_ledger(hotel_id, member_id);

CREATE UNIQUE INDEX idx_wallet_ledger_request ON member_wallet_ledger(hotel_id, request_id) WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX idx_wallet_account_member ON member_wallet(hotel_id, member_id) WHERE member_id IS NOT NULL;

CREATE INDEX idx_ar_ledgers_company ON ar_ledgers(hotel_id, company_id, status);

CREATE INDEX idx_ar_ledgers_bizdate ON ar_ledgers(hotel_id, biz_date);

CREATE UNIQUE INDEX idx_guests_idno ON guests(hotel_id, id_no)
       WHERE id_no IS NOT NULL AND id_no <> '';

CREATE UNIQUE INDEX idx_guests_mobile ON guests(hotel_id, mobile)
       WHERE mobile IS NOT NULL AND mobile <> '';

CREATE INDEX idx_invoices_folio ON invoices(hotel_id, folio_id);

CREATE INDEX idx_invoices_bizdate ON invoices(hotel_id, biz_date);

CREATE UNIQUE INDEX idx_invoices_no ON invoices(hotel_id, invoice_no) WHERE invoice_no <> '';

-- 红冲幂等约束（第七轮整改清单一.3）：同一酒店、同一张原票只允许一张红冲票。
-- 与 scripts/migrate-all.mjs 的 addIndex("idx_invoices_red_of", ...) 及
-- src/lib/invoice.ts 的 ensureInvoiceSchema() 三处 DDL 必须完全一致。
-- 正常票 red_of 为 NULL，WHERE 让索引只覆盖红冲票（NULL 在唯一索引里本来也不冲突）。
CREATE UNIQUE INDEX idx_invoices_red_of ON invoices(hotel_id, red_of) WHERE red_of IS NOT NULL;

CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE UNIQUE INDEX idx_mini_users_openid ON mini_program_users(hotel_id, openid);

CREATE INDEX idx_mini_users_token ON mini_program_users(session_token);

CREATE UNIQUE INDEX idx_folio_items_request ON folio_items(hotel_id, request_id) WHERE request_id IS NOT NULL;

CREATE UNIQUE INDEX idx_shop_sales_request ON shop_sales(hotel_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_shop_stock_flows_item ON shop_stock_flows (hotel_id, item_id, type);

CREATE UNIQUE INDEX idx_shop_stock_flows_request ON shop_stock_flows(hotel_id, request_id, item_id, type) WHERE request_id IS NOT NULL;

CREATE INDEX idx_sync_logs_request ON channel_sync_logs(hotel_id, request_no);

CREATE INDEX idx_sync_logs_channel_order ON channel_sync_logs(hotel_id, channel_order_no);

CREATE INDEX idx_sync_queue_pending ON channel_sync_queue(hotel_id, status, id);

CREATE UNIQUE INDEX idx_role_modules_key ON role_modules(hotel_id, role, module);

CREATE UNIQUE INDEX idx_role_permissions_key ON role_permissions(hotel_id, role, permission);

CREATE INDEX idx_stays_room ON stays(hotel_id, room_id, status);

CREATE INDEX idx_stays_guest ON stays(hotel_id, guest_id);

CREATE INDEX idx_stays_status ON stays(hotel_id, status, expect_check_out);

CREATE INDEX idx_folios_stay ON folios(hotel_id, stay_id);

CREATE INDEX idx_folio_items_folio ON folio_items(hotel_id, folio_id);

CREATE INDEX idx_payments_stay ON payments(hotel_id, stay_id);

CREATE INDEX idx_payments_bizdate ON payments(hotel_id, biz_date);

CREATE INDEX idx_bookings_status ON bookings(hotel_id, status, check_in_date);

CREATE INDEX idx_bookings_checkin ON bookings(hotel_id, check_in_date);

CREATE INDEX idx_rooms_sort ON rooms(hotel_id, sort);

CREATE INDEX idx_housekeeping_status ON housekeeping(hotel_id, status, room_id);

CREATE INDEX idx_op_logs_time ON op_logs(hotel_id, id DESC);

CREATE INDEX idx_lock_devices_room ON lock_devices(hotel_id, room_id);

CREATE INDEX idx_rate_calendar_key ON rate_calendar(hotel_id, room_type_id, date);

CREATE UNIQUE INDEX idx_login_attempts_key ON login_attempts(login_key);

CREATE INDEX idx_mini_bookings_user ON mini_program_bookings(hotel_id, mini_user_id);

-- 小程序通知列表 / 未读角标固定按 (hotel_id, mini_user_id, read_at) 过滤。
-- 与 scripts/migrate-all.mjs 的 addIndex("idx_mini_notifications_user", ...) 完全一致。
CREATE INDEX idx_mini_notifications_user ON mini_notifications(hotel_id, mini_user_id, read_at);

-- 小程序服务请求（第九轮清单第六节）：客房服务 / 送物 / 维修 / 延迟退房 / 换房 / 唤早 / 续住申请
-- request_id 幂等的唯一约束：同一家店同一 request_id 只能落一行（部分唯一，历史 NULL 不进索引）
CREATE UNIQUE INDEX idx_mini_service_requests_req ON mini_service_requests(hotel_id, request_id) WHERE request_id IS NOT NULL;

CREATE INDEX idx_mini_service_requests_user ON mini_service_requests(hotel_id, mini_user_id, id);

CREATE INDEX idx_mini_service_requests_stay ON mini_service_requests(hotel_id, stay_id);

CREATE INDEX idx_mini_service_requests_status ON mini_service_requests(hotel_id, status, id);

CREATE INDEX idx_stays_channel_order ON stays(hotel_id, channel_order_no);

CREATE UNIQUE INDEX idx_channel_room_types_key ON channel_room_types(hotel_id, channel_type, channel_room_name);

CREATE UNIQUE INDEX idx_channel_rate_plans_key ON channel_rate_plans(hotel_id, channel_type, rate_code);

CREATE UNIQUE INDEX idx_channel_settlements_key
       ON channel_settlements(hotel_id, source, channel_type, biz_date, order_no)
       WHERE order_no IS NOT NULL;

CREATE INDEX idx_channel_settlements_date ON channel_settlements(hotel_id, biz_date);

CREATE INDEX idx_channel_dead_letter ON channel_sync_dead_letter(hotel_id, created_at);

CREATE UNIQUE INDEX idx_bookings_no ON bookings(hotel_id, booking_no);

CREATE UNIQUE INDEX idx_bookings_mini_request ON bookings(hotel_id, mini_request_id) WHERE mini_request_id IS NOT NULL;

/*
 * 单号「酒店内唯一」的三组索引
 *
 * 三张表的单号列原本是列级 UNIQUE（全局唯一），多店部署时 hotel 999 用
 * hotel 1 的单号会直接 UNIQUE constraint failed。已去掉列级约束，
 * 改用这三组组合唯一索引表达「同一酒店内不重复、跨店可重复」。
 *
 * 旧库升级走 scripts/rebuild-unique-constraints.mjs（需要重建表，
 * SQLite 不支持 DROP CONSTRAINT）；新库安装时靠这里建好。
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_stays_no ON stays(hotel_id, stay_no);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folios_no ON folios(hotel_id, folio_no);

CREATE INDEX idx_folio_items_bizdate ON folio_items(hotel_id, biz_date, item_type);

CREATE INDEX idx_rooms_status ON rooms(hotel_id, status);

CREATE INDEX idx_folios_balance ON folios(hotel_id, balance);