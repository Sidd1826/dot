from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import gc
import json
import math
import os
from threading import Lock, Semaphore
import time

from crypto_utils import decrypt_data, encrypt_data
import requests
from requests.adapters import HTTPAdapter
import urllib3
from urllib3.util.retry import Retry

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ENV
BankId = os.getenv("BankId")
BASE_URL = os.getenv("MNRL_BASE_URL")
REACTIVATED_URL = os.getenv("MNRL_REACTIVATED_URL")

# Max concurrent batch fetches prevents upstream overload
_MAX_CONCURRENT_FETCHES = int(os.getenv("MNRL_MAX_CONCURRENT", "5"))

_token_cache: dict = {"token": None, "expires_at": None}
_token_lock = Lock()

# SESSION (singleton with retry + pool)
_session = None
_session_lock = Lock()


def _get_session() -> requests.Session:
    global _session
    if _session is not None:
        return _session

    with _session_lock:
        if _session is not None:
            return _session

        session = requests.Session()
        retry = Retry(
            total=3,
            backoff_factor=1,
            status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["POST", "GET"],
        )
        adapter = HTTPAdapter(
            max_retries=retry,
            pool_connections=20,
            pool_maxsize=20,
        )
        session.mount("http://", adapter)
        session.mount("https://", adapter)
        _session = session
        return _session


# AUTH
def mnrl_auth(key_id: str, force_refresh: bool = False) -> str:
    """Authenticate with the MNRL API and return a cached token (thread-safe)."""
    with _token_lock:
        if (
            not force_refresh
            and _token_cache["token"]
            and _token_cache["expires_at"]
            and datetime.now() < _token_cache["expires_at"]
        ):
            return _token_cache["token"]

    print("[MNRL] Fetching new authentication token...")
    email = os.getenv("MNRL_EMAIL")
    password = os.getenv("MNRL_PASSWORD")

    if not email or not password:
        raise ValueError(
            "MNRL_EMAIL and MNRL_PASSWORD environment variables must be set"
        )

    encrypted = encrypt_data({"email": email, "password": password}, key_id)

    try:
        resp = _get_session().post(
            f"{BASE_URL}/auth",
            json=encrypted,
            headers={"Content-Type": "application/json"},
            timeout=30,
            verify=False,
        )
        resp.raise_for_status()
    except Exception as e:
        raise RuntimeError(f"MNRL auth failed: {e}") from e

    token = resp.json().get("token")
    if not token:
        raise ValueError(f"No token in auth response: {resp.text[:200]}")

    with _token_lock:
        _token_cache["token"] = token
        _token_cache["expires_at"] = datetime.now() + timedelta(minutes=120)

    print("[MNRL] Authentication successful")
    return token


def _invalidate_token():
    with _token_lock:
        _token_cache["token"] = None
        _token_cache["expires_at"] = None


# COUNT
def _count_request(
    url: str,
    key_id: str,
    count_date: str,
    label: str = "MNRL",
    max_retries: int = 3,
) -> dict:
    """Generic count helper shared by normal and reactivated routes."""
    session = _get_session()
    for attempt in range(max_retries):
        try:
            token = mnrl_auth(key_id, force_refresh=(attempt > 0))
            resp = session.post(
                url,
                json={"date": count_date},
                headers={
                    "Content-Type": "application/json",
                    "Authorization": token,
                },
                timeout=30,
                verify=False,
            )

            if resp.status_code == 401 and attempt < max_retries - 1:
                _invalidate_token()
                time.sleep(1)
                continue

            if resp.status_code == 429 and attempt < max_retries - 1:
                wait = int(resp.headers.get("Retry-After", 10))
                print(f"[{label}] Rate limited waiting {wait}s")
                time.sleep(wait)
                continue

            resp.raise_for_status()
            result = resp.json()
            print(f"[{label}] Count: {result.get('count', 0):,} records")
            return result

        except requests.exceptions.ConnectionError:
            if attempt < max_retries - 1:
                wait = min(2**attempt, 30)
                print(f"[{label}] Connection error retrying in {wait}s")
                time.sleep(wait)
            else:
                raise

    raise ValueError(f"[{label}] Failed to get count after {max_retries} attempts")


def mnrl_count(key_id: str, count_date: str, max_retries: int = 3) -> dict:
    return _count_request(
        url=f"{BASE_URL}/count",
        key_id=key_id,
        count_date=count_date,
        label="MNRL",
        max_retries=max_retries,
    )


def mnrl_count_reactivated(
    key_id: str, count_date: str, max_retries: int = 3
) -> dict:
    return _count_request(
        url=f"{REACTIVATED_URL}/count",
        key_id=key_id,
        count_date=count_date,
        label="MNRL-Reactivated",
        max_retries=max_retries,
    )


# BATCH FETCH
def _fetch_batch(
    key_id: str,
    url: str,
    body: dict,
    label: str,
    max_retries: int = 3,
) -> list[dict] | None:
    """POST to `url`, decrypt, parse, and return a list of record dicts.

    Returns None on failure (caller decides whether to retry or skip).
    """
    session = _get_session()
    for attempt in range(max_retries):
        try:
            token = mnrl_auth(key_id)
            resp = session.post(
                url,
                json=body,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": token,
                },
                timeout=45,
                verify=False,
            )

            if resp.status_code == 401 and attempt < max_retries - 1:
                _invalidate_token()
                time.sleep(1)
                continue

            if resp.status_code == 429 and attempt < max_retries - 1:
                wait = int(resp.headers.get("Retry-After", 10))
                time.sleep(wait)
                continue

            resp.raise_for_status()
            encrypted_payload = resp.json()
            break

        except requests.exceptions.ConnectionError:
            if attempt < max_retries - 1:
                time.sleep(min(2**attempt, 4))
                continue
            return None
        except Exception as e:
            print(f"[{label}] HTTP error: {e}")
            if attempt < max_retries - 1:
                time.sleep(1)
                continue
            return None

    # Decrypt
    try:
        decrypted = decrypt_data(encrypted_payload)
        del encrypted_payload  # free memory immediately
    except Exception as e:
        print(f"[{label}] Decrypt error: {e}")
        return None

    # Parse
    try:
        if isinstance(decrypted, str):
            parsed = json.loads(decrypted)
            if isinstance(parsed, dict) and "data" in parsed:
                records = parsed["data"]
            elif isinstance(parsed, list):
                records = parsed
            else:
                records = []
        elif isinstance(decrypted, list):
            records = decrypted
        elif isinstance(decrypted, dict) and "data" in decrypted:
            records = decrypted["data"]
        else:
            records = []
    except (json.JSONDecodeError, Exception) as e:
        print(f"[{label}] Parse error: {e}")
        return None

    return records if records else None


# PARALLEL BATCH FETCH
def _parallel_fetch(
    key_id: str,
    total_count: int,
    build_body: callable,  # (offset, batch_size) -> dict
    api_url: str,
    label: str,
    batch_size: int = 3000,
    max_workers: int = 5,
) -> list:
    num_batches = math.ceil(total_count / batch_size)
    all_data = []
    failed_batches = []
    data_lock = Lock()
    semaphore = Semaphore(_MAX_CONCURRENT_FETCHES)

    print(f"\n{'-'*60}")
    print(f"[{label}] PARALLEL fetch started")
    print(
        f"  Total: {total_count:,} | batch: {batch_size} | "
        f"batches: {num_batches} | workers: {max_workers}"
    )
    print(f"{'-'*60}\n")

    def fetch_one(batch_idx: int):
        offset = batch_idx * batch_size
        size = min(batch_size, total_count - offset)
        with semaphore:
            return _fetch_batch(
                key_id=key_id,
                url=api_url,
                body=build_body(offset, size),
                label=f"[{label}][{batch_idx+1}/{num_batches}]",
            )

    start = time.time()

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(fetch_one, i): i for i in range(num_batches)}
        done = 0

        for future in as_completed(futures):
            batch_idx = futures[future]
            done += 1
            try:
                records = future.result()
                if records:
                    with data_lock:
                        all_data.extend(records)
                    print(
                        f"[{label}] Progress: {done}/{num_batches} "
                        f"({len(all_data):,}/{total_count:,} records)"
                    )
                else:
                    failed_batches.append(batch_idx + 1)
                    print(f"[{label}] ▲ Batch {batch_idx+1} empty/failed")
            except Exception as e:
                failed_batches.append(batch_idx + 1)
                print(f"[{label}] X Batch {batch_idx+1} exception: {e}")

    elapsed = time.time() - start
    print(
        f"\n[{label}] Done in {elapsed:.1f}s "
        f"({len(all_data):,}/{total_count:,} records fetched)"
    )

    if failed_batches:
        print(f"[{label}] ▲ Failed batches: {failed_batches}")
    print()

    return all_data


# PUBLIC FETCH FUNCTIONS
def mnrl_data(
    key_id: str,
    total_count: int,
    date: str,
    BATCH_SIZE: int = 3000,
    Bank_Id: str = None,
    max_workers: int = 5,
) -> list:
    """Fetch and decrypt all MNRL Normal data in parallel batches."""
    if Bank_Id is None:
        Bank_Id = BankId

    def build_body(offset, count):
        return {
            "date": date,
            "BankId": Bank_Id,
            "offset": offset,
            "count": count,
        }

    return _parallel_fetch(
        key_id=key_id,
        total_count=total_count,
        build_body=build_body,
        api_url=f"{BASE_URL}/mnrldata",
        label="MNRL-Normal",
        batch_size=BATCH_SIZE,
        max_workers=max_workers,
    )


def mnrl_data_reactivated_excel(
    key_id: str,
    total_count: int,
    date: str,
    BATCH_SIZE: int = 2000,
    Bank_Id: str = None,
    max_workers: int = 5,
) -> list:
    """Fetch and decrypt all MNRL Reactivated data in parallel batches."""
    if Bank_Id is None:
        Bank_Id = BankId

    def build_body(offset, count):
        return {
            "date": date,
            "BankId": Bank_Id,
            "offset": offset,
            "count": count,
        }

    return _parallel_fetch(
        key_id=key_id,
        total_count=total_count,
        build_body=build_body,
        api_url=f"{REACTIVATED_URL}/reactivated",
        label="MNRL-Reactivated",
        batch_size=BATCH_SIZE,
        max_workers=max_workers,
    )


# Keep backwards-compatible name used in some older call sites
mnrl_data_baseline = mnrl_data