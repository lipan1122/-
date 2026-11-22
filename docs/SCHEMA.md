# PMS 数据库结构（SQLite，data/pms.db）

所有表都有 `hotel_id`（多租户预留，当前恒为 1）。日期格式 `YYYY-MM-DD`，时间格式 ISO 字符串。

## rooms 房间
| 字段 | 说明 |
| --- | --- |
| id | 主键 |
| room_no | 房号，如 301 |
| floor | 楼层 |
| room_type_id | → room_types.id |
| status | `VC` 空净 / `VD` 空脏 / `OC` 在住净 / `OD` 在住脏 / `OOO` 维修 / `LOCK` 锁房 |
| feature | 备注（如"空调维修"） |
| sort | 排序 |

## room_types 房型
id, code, name, bed_type, area, max_occupancy, base_price, sort

## stays 在住/入住单
| 字段 | 说明 |
| --- | --- |
| id | 主键 |
| stay_no | 入住单号，如 SI1001 |
| booking_id | 来源预订 id，可空 |
| room_id | → rooms.id |
| guest_id | → guests.id |
| guest_name / mobile | 客人姓名、手机 |
| check_in_time | 入住时间（ISO） |
| expect_check_out | 预计离店日期 YYYY-MM-DD |
| actual_check_out | 实际离店（退房时写入） |
| nights | 入住晚数 |
| rate | 房价/晚 |
| deposit | 押金 |
| guest_count | 入住人数 |
| status | `INHOUSE` 在住 / `CHECKED_OUT` 已退房 |
| channel_id | → channels.id |
| remark | 备注 |

## bookings 预订
| 字段 | 说明 |
| --- | --- |
| id | 主键 |
| booking_no | 预订号 BK3001 |
| guest_id / guest_name / mobile | 客人 |
| room_type_id | 房型 |
| room_id | 已排房则填，可空 |
| channel_id / company_id | 渠道 / 协议单位 |
| check_in_date / check_out_date | 入住、离店日期 |
| nights / room_count / guest_count | 晚数、房间数、人数 |
| rate / deposit | 房价、定金 |
| status | `PENDING` 待排房 / `CONFIRMED` 已确认 / `CHECKED_IN` 已入住 / `CANCELLED` 已取消 / `NOSHOW` 未到 |
| guarantee / remark | 担保方式、备注 |

## folios 账务单
一条在住记录对应一个 folio。字段：id, folio_no, stay_id, guest_name, room_no, total_amount 合计, paid_amount 已收, balance 应收余额（正数=欠费）, status（`OPEN` / `SETTLED`）, created_at, settled_at

## folio_items 账务明细
id, folio_id, item_type（`ROOM` 房费 / `FOOD` 餐饮 / `OTHER` 其他 / `DEPOSIT` 押金 / `ADJUST` 调整）, description, qty, price, amount, biz_date 营业日期, created_at, created_by

## payments 收款流水
id, folio_id, stay_id, pay_no, method（现金/微信/支付宝/银行卡/挂账）, amount, biz_date, remark, created_at

## guests 客史
id, name, gender, id_type, id_no, mobile, company, vip_level, blacklist, note, created_at

## channels 客源渠道
id, name（散客/携程/美团/去哪儿/艺龙/协议单位/会员直订）, commission

## companies 协议单位
id, name, contact, phone, discount, credit_limit

## housekeeping 客房任务
id, room_id, task_type（打扫/查房/维修）, status（`PENDING` / `DONE`）, assignee, note, created_at, done_at

## night_audits 夜审记录
id, biz_date, status（`RUNNING`/`DONE`）, rooms_sold, revenue, occupancy, operator, created_at

## room_logs 房态变更日志
id, room_id, from_status, to_status, reason, operator, created_at

## settings 系统参数
id, key, value（如 check_in_time=14:00, check_out_time=12:00）
