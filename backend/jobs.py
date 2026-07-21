from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import os
import traceback
import uuid

import psycopg2.extras
import psycopg2.pool

#
# CONFIG
#
PG_DSN = os.environ["AZURE_POSTGRES_DSN"]
MAX_WORKERS = int(os.environ.get("JOB_MAX_WORKERS", "4"))
JOB_TTL_HOURS = int(os.environ.get("JOB_TTL_HOURS", "24"))

#
# CONNECTION POOL
#
_pool: psycopg2.pool.ThreadedConnectionPool | None = None


def _get_pool() -> psycopg2.pool.ThreadedConnectionPool:
    global _pool
    if _pool is None or _pool.closed:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=2,
            maxconn=MAX_WORKERS + 4,
            dsn=PG_DSN,
        )
    return _pool


def _acquire():
    return _get_pool().getconn()


def _release(conn):
    try:
        _get_pool().putconn(conn)
    except Exception:
        pass


_executor = ThreadPoolExecutor(
    max_workers=MAX_WORKERS,
    thread_name_prefix="export-worker",
)


#
# DB HELPERS
#
def _insert_job(job_id: str) -> None:
    """Create a new job row with status='pending'."""
    conn = _acquire()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs (id, status, started_at, updated_at) "
                "VALUES (%s, 'pending', NOW(), NOW())",
                (job_id,),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _release(conn)


def _update_job(job_id: str, **fields) -> None:
    """Update arbitrary columns on a job row.

    Supported keyword args: status, result (dict), error (str), finished_at.
    """
    if not fields:
        return

    set_parts = []
    values = []

    if "status" in fields:
        set_parts.append("status = %s")
        values.append(fields["status"])

    if "result" in fields:
        set_parts.append("result = %s::jsonb")
        values.append(json.dumps(fields["result"], default=str))

    if "error" in fields:
        set_parts.append("error = %s")
        values.append(fields["error"])

    if "finished_at" in fields:
        set_parts.append("finished_at = %s")
        values.append(fields["finished_at"])

    # updated_at is handled by the DB trigger automatically
    values.append(job_id)
    sql = f"UPDATE jobs SET {', '.join(set_parts)} WHERE id = %s"

    conn = _acquire()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, values)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _release(conn)


def _select_job(job_id: str) -> dict | None:
    """Fetch a single job row as a plain dict, or None if not found."""
    conn = _acquire()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                "SELECT id, status, result, error, started_at, finished_at, updated_at "
                "FROM jobs WHERE id = %s",
                (job_id,),
            )
            row = cur.fetchone()
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _release(conn)

    if not row:
        return None

    d = dict(row)

    # Serialise timestamps to ISO strings (same shape as old in-memory dict)
    d["started_at"] = d["started_at"].isoformat() if d["started_at"] else None
    d["finished_at"] = d["finished_at"].isoformat() if d["finished_at"] else None
    d["updated_at"] = d["updated_at"].isoformat() if d["updated_at"] else None

    return d


#
# BACKGROUND RUNNER
#
def _run(job_id: str, fn, *args, **kwargs) -> None:
    """Executed inside a worker thread. Writes state to DB at each transition."""
    _update_job(job_id, status="running")
    try:
        result = fn(*args, **kwargs)
        _update_job(
            job_id,
            status="done",
            result=result,
            finished_at=datetime.now(timezone.utc),
        )
    except Exception:
        tb = traceback.format_exc()
        last_line = tb.strip().splitlines()[-1]
        print(f"[JOB FAILED] {job_id}:\n{tb}")
        _update_job(
            job_id,
            status="failed",
            error=last_line,
            finished_at=datetime.now(timezone.utc),
        )


#
# PUBLIC API
#
def start_job(fn, *args, **kwargs) -> str:
    job_id = str(uuid.uuid4())
    _insert_job(job_id)
    _executor.submit(_run, job_id, fn, *args, **kwargs)
    return job_id


def get_job(job_id: str) -> dict | None:
    """Return current job state as a dict, or None if not found."""
    return _select_job(job_id)


def clean_old_jobs(hours: int = JOB_TTL_HOURS) -> int:
    """Delete done/failed jobs older than `hours`.

    Returns the number of rows deleted.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    conn = _acquire()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM jobs WHERE status IN ('done', 'failed') AND finished_at < %s",
                (cutoff,),
            )
            removed = cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _release(conn)

    print(f"[jobs] Cleaned {removed} old job(s) older than {hours}h")
    return removed