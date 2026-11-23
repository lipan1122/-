"""
把 VPS 上的数据库备份拉回本机（异地备份）

── 为什么需要这个 ──

VPS 只有**一块盘**（`/dev/vda2`），`backup-db.mjs` 生成的备份和在用的
`data/pms.db` 在同一个分区上。整机挂掉 / 磁盘损坏 / 误删 `/opt/pms`
的时候，数据和备份会一起丢。

这个脚本通过 SFTP 把 VPS 上最新的备份拉到本机（D 盘，不同物理机），
再保留最近 N 份。本机计划任务每天跑一次即可。

── 用法 ──

    python vps-get-backup.py                # 拉最新一份
    python vps-get-backup.py --all          # 拉全部（首次同步用）
    python vps-get-backup.py --keep 20      # 本机保留 20 份（默认 10）
    python vps-get-backup.py --list         # 只列出远程有哪些，不下载

凭据从环境变量读：
    VPS_HOST / VPS_USER / VPS_PASS
    （可选）PMS_BACKUP_LOCAL_DIR  默认 D:\\dsh-home\\downloads\\pms酒管系统\\backups
"""
import os
import posixpath
import re
import sys
from pathlib import Path

import paramiko

# Windows 控制台默认 GBK，中文/emoji 会 UnicodeEncodeError；强制 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

HOST = os.environ.get("VPS_HOST", "106.52.92.24")
USER = os.environ.get("VPS_USER", "ubuntu")
PASS = os.environ["VPS_PASS"]

# VPS 上的备份目录（和 /opt/pms/data 分开，防误删整个项目目录时连备份一起没）
REMOTE_DIRS = [
    "/opt/pms/data/backup",
    os.environ.get("PMS_BACKUP_REMOTE_DIR", "/home/ubuntu/pms-backups"),
]

LOCAL_DIR = Path(
    os.environ.get(
        "PMS_BACKUP_LOCAL_DIR",
        r"D:\dsh-home\downloads\pms酒管系统\backups",
    )
)

args = sys.argv[1:]
LIST_ONLY = "--list" in args
PULL_ALL = "--all" in args
KEEP = 10
if "--keep" in args:
    try:
        KEEP = int(args[args.index("--keep") + 1])
    except (IndexError, ValueError):
        print("--keep 需要一个数字")
        sys.exit(1)

# 只认这几种命名（backup-db.mjs 生成的 pms.<时间戳>.db 优先，其余历史快照也一并同步）
PATTERNS = [
    re.compile(r"^pms\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.db$"),
    re.compile(r"^pms\.db\.bak-post-deploy-\d+\.db$"),
    re.compile(r"^pms\.db\.bak-deposit-\d+\.db$"),
]


def is_backup(name: str) -> bool:
    return any(p.match(name) for p in PATTERNS)


def main() -> int:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(hostname=HOST, username=USER, password=PASS, timeout=15)
    sftp = client.open_sftp()

    remote_files = []  # [(dir, name, size, mtime)]
    for d in REMOTE_DIRS:
        try:
            for attr in sftp.listdir_attr(d):
                if is_backup(attr.filename):
                    remote_files.append((d, attr.filename, int(attr.st_size or 0), int(attr.st_mtime or 0)))
        except IOError:
            print(f"  （远程目录不存在，跳过）：{d}")

    if not remote_files:
        print("远程没有匹配的备份文件")
        sftp.close()
        client.close()
        return 1

    # 按修改时间倒序（最新在最前）
    remote_files.sort(key=lambda x: x[3], reverse=True)

    print(f"远程共有 {len(remote_files)} 份备份（列前 15）：")
    for d, name, size, mtime in remote_files[:15]:
        import datetime

        ts = datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S")
        print(f"  {ts}  {size/1024/1024:6.2f} MB  {posixpath.join(d, name)}")

    if LIST_ONLY:
        sftp.close()
        client.close()
        return 0

    LOCAL_DIR.mkdir(parents=True, exist_ok=True)

    targets = remote_files if PULL_ALL else remote_files[:1]
    pulled = 0
    for d, name, size, _ in targets:
        local_path = LOCAL_DIR / name
        if local_path.exists() and local_path.stat().st_size == size:
            print(f"  已存在且大小一致，跳过：{name}")
            continue
        remote_path = posixpath.join(d, name)
        print(f"  拉取 {remote_path} → {local_path}  ({size/1024/1024:.2f} MB) ...", end="", flush=True)
        sftp.get(remote_path, str(local_path))
        print(" ok")
        pulled += 1

    # 本机保留最近 KEEP 份（只清 pms.<时间戳>.db 这一种，历史快照不动）
    pattern = re.compile(r"^pms\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})\.db$")
    local_backups = []
    for f in LOCAL_DIR.iterdir():
        m = pattern.match(f.name)
        if m:
            local_backups.append((m.group(1), f))
    local_backups.sort(reverse=True)
    removed = 0
    for _ts, f in local_backups[KEEP:]:
        try:
            f.unlink()
            removed += 1
        except OSError:
            pass

    sftp.close()
    client.close()

    print(f"\n✅ 本次拉取 {pulled} 份，本机清掉 {removed} 份（保留最近 {KEEP} 份）")
    print(f"   本机目录：{LOCAL_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
