from datetime import datetime
import io
import traceback

from azure_utils import (
    AZURE_CONTAINER_MATCHOFF_OUTPUT,
    export_and_store,
    get_export_metadata_row,
    get_matchoff_run,
    get_sas_download_url,
    list_export_metadata,
    list_matchoff_metadata,
    list_source_date_folders,
    list_source_files,
    run_matchoff,
)
from crypto_utils import decrypt_data, encrypt_data
from flask import Blueprint, jsonify, request, send_file
from FRI import fetch_and_decrypt_all, fri_auth, fri_count, fri_data
from jobs import clean_old_jobs, get_job, start_job
from MNRL import (
    mnrl_auth,
    mnrl_count,
    mnrl_count_reactivated,
    mnrl_data,
    mnrl_data_reactivated_excel,
)

routes = Blueprint("routes", __name__)

FRI_COLUMNS = ["fri", "lsa_id", "mobile_no", "status", "tsp_id"]
MNRL_NORMAL_COLUMNS = [
    "date_of_disconnection",
    "disconnectionreason_id",
    "lsa_id",
    "mobile_no",
    "tsp_id",
]
MNRL_REACT_COLUMNS = ["date_of_reactivation", "mobile_no", "reactivation_id"]

_VALID_CONTAINERS = {"fri-exports", "mnrl-exports"}


# VALIDATION HELPERS
def _validate_date(value: str) -> str:
    """Parses YYYY-MM-DD and returns the normalised string."""
    if not value:
        raise ValueError("date is required")
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise ValueError("Invalid date format. Expected YYYY-MM-DD")


def _validate_module(value: str) -> str:
    allowed = ("FRI", "MNRL")
    if not value or value.upper() not in allowed:
        raise ValueError(f"type must be one of: {', '.join(allowed)}")
    return value.upper()


def _validate_data_type(value: str) -> str:
    allowed = ("Normal", "Reactivated")
    if not value or value not in allowed:
        raise ValueError(f"data_type must be one of: {', '.join(allowed)}")
    return value


def _validate_container(value: str) -> str:
    if not value or value not in _VALID_CONTAINERS:
        raise ValueError(f"container must be one of: {', '.join(_VALID_CONTAINERS)}")
    return value


# BACKGROUND EXPORT HELPERS
def _do_fri_export(date: str, client_id, batch_size: int) -> dict:
    total = fri_count(key_id="FRI", count_date=date).get("count", 0)
    if total == 0:
        raise ValueError("No records found for this date")

    records = fetch_and_decrypt_all(
        key_id="FRI",
        total_count=total,
        date=date,
        client_id=client_id,
        BATCH_SIZE=batch_size,
    )
    if not records:
        raise ValueError("No data retrieved")

    return export_and_store(
        module="FRI",
        records=records,
        columns=FRI_COLUMNS,
        file_name=f"fri_data_{date}_{len(records)}_records.xlsx",
        export_date=date,
    )


def _do_mnrl_export(
    date: str,
    data_type: str,
    bank_id,
    batch_size: int,
    max_workers: int,
) -> dict:
    if data_type == "Normal":
        total = mnrl_count(key_id="DIU", count_date=date).get("count", 0)
        if total == 0:
            raise ValueError("No records found for this date")

        records = mnrl_data(
            key_id="DIU",
            date=date,
            total_count=total,
            BATCH_SIZE=batch_size,
            Bank_Id=bank_id,
            max_workers=max_workers,
        )
        columns = MNRL_NORMAL_COLUMNS
        file_name = f"mnrl_normal_{date}_{len(records)}_records.xlsx"
    else:  # Reactivated
        total = mnrl_count_reactivated(key_id="DIU", count_date=date).get("count", 0)
        if total == 0:
            raise ValueError("No reactivated records found for this date")

        records = mnrl_data_reactivated_excel(
            key_id="DIU",
            total_count=total,
            date=date,
            BATCH_SIZE=batch_size,
            Bank_Id=bank_id,
            max_workers=max_workers,
        )
        columns = MNRL_REACT_COLUMNS
        file_name = f"mnrl_reactivated_{date}_{len(records)}_records.xlsx"

    if not records:
        raise ValueError("No data retrieved")

    return export_and_store(
        module="MNRL",
        records=records,
        columns=columns,
        file_name=file_name,
        export_date=date,
        data_type=data_type,
    )


def _do_matchoff(
    source_container: str,
    date_folder: str,
    file_name: str,
    mob_col: str,
) -> dict:
    """Thin wrapper all logic in azure_utils."""
    return run_matchoff(
        source_container=source_container,
        date_folder=date_folder,
        file_name=file_name,
        mob_col=mob_col,
    )


# ROUTES
@routes.route("/health", methods=["GET"])
def health():
    return {"status": "API is working"}, 200


# Encrypt / Decrypt
@routes.route("/encrypt", methods=["POST"])
def encrypt():
    try:
        key_id = request.headers.get("X-PUBLIC-KEY-ID")
        if not key_id:
            return {"error": "X-PUBLIC-KEY-ID header required"}, 400
        result = encrypt_data(request.json, key_id)
        return jsonify(result), 200
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/decrypt", methods=["POST"])
def decrypt():
    try:
        result = decrypt_data(request.json)
        return jsonify(result), 200
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


# FRI
@routes.route("/fri/auth", methods=["POST"])
def auth():
    try:
        return {"token": fri_auth(key_id="FRI")}, 200
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/fri/count", methods=["POST"])
def route_fri_count():
    req = request.get_json(silent=True) or {}
    date = req.get("date")
    try:
        valid_date = _validate_date(date)
        result = fri_count(key_id="FRI", count_date=valid_date)
        return jsonify({"count": result.get("count", 0)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/fri/data/test", methods=["POST"])
def data_test():
    try:
        req = request.json or {}
        for field in ("date", "offset", "count", "client_id"):
            if req.get(field) is None:
                return {"error": f"{field} is required"}, 400
        response = fri_data(
            key_id="FRI",
            date=req["date"],
            offset=req["offset"],
            count=req["count"],
            client_id=req["client_id"],
        )
        return response, 200
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/fri/data", methods=["POST"])
def data():
    try:
        req = request.json or {}
        date = _validate_date(req.get("date"))
        count_res = fri_count(key_id="FRI", count_date=date)
        total_count = count_res.get("count", 0)
        if total_count == 0:
            return {"error": "No records found for this date", "count": 0}, 404

        response = fetch_and_decrypt_all(
            key_id="FRI",
            total_count=total_count,
            date=date,
            client_id=req.get("client_id"),
            BATCH_SIZE=req.get("batch_size", 3000),
        )
        return {"data": response, "total_records": len(response)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/fri/data/excel", methods=["POST"])
def data_excel():
    try:
        req = request.json or {}
        date = _validate_date(req.get("date"))
        count_res = fri_count(key_id="FRI", count_date=date)
        total_count = count_res.get("count", 0)
        if total_count == 0:
            return {"error": "No records found for this date", "count": 0}, 404

        response = fetch_and_decrypt_all(
            key_id="FRI",
            total_count=total_count,
            date=date,
            client_id=req.get("client_id"),
            BATCH_SIZE=req.get("batch_size", 3000),
        )

        if not response:
            return {"error": "No data retrieved", "count": 0}, 404

        output = io.BytesIO()
        # save_to_excel(response, output, FRI_COLUMNS)
        output.seek(0)
        filename = f"fri_data_{date}_{len(response)}_records.xlsx"
        return send_file(
            output,
            mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            as_attachment=True,
            download_name=filename,
        )
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/fri/export-and-save", methods=["POST"])
def route_fri_export():
    """Start a background FRI export. Returns job_id immediately (202)."""
    req = request.get_json(silent=True) or {}
    try:
        date = _validate_date(req.get("date"))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = start_job(
            _do_fri_export,
            date,
            req.get("client_id"),
            req.get("batch_size", 3000),
        )
        return jsonify({"job_id": job_id, "status": "pending"}), 202
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# MNRL
@routes.route("/mnrl/auth", methods=["POST"])
def auth_mnrl():
    try:
        return {"token": mnrl_auth(key_id="DIU")}, 200
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/mnrl/count", methods=["POST"])
def route_mnrl_count():
    req = request.get_json(silent=True) or {}
    date = req.get("date")
    try:
        valid_date = _validate_date(date)
        result = mnrl_count(key_id="DIU", count_date=valid_date)
        return jsonify({"count": result.get("count", 0)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/mnrl/count/reactivated", methods=["POST"])
def route_mnrl_count_reactivated():
    req = request.get_json(silent=True) or {}
    date = req.get("date")
    try:
        valid_date = _validate_date(date)
        result = mnrl_count_reactivated(key_id="DIU", count_date=valid_date)
        return jsonify({"count": result.get("count", 0)})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/mnrl/data", methods=["POST"])
def data_mnrl():
    try:
        req = request.json or {}
        date = _validate_date(req.get("date"))
        count_res = mnrl_count(key_id="DIU", count_date=date)
        total_count = count_res.get("count", 0)
        if total_count == 0:
            return {"error": "No records found for this date", "count": 0}, 404

        response = mnrl_data(
            key_id="DIU",
            date=date,
            total_count=total_count,
            Bank_Id=req.get("BankId"),
            BATCH_SIZE=req.get("batch_size", 3000),
            max_workers=req.get("max_workers", 5),
        )
        return {"data": response, "total_records": len(response)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/mnrl/data/reactivated", methods=["POST"])
def data_mnrl_reactivated():
    try:
        req = request.json or {}
        date = _validate_date(req.get("date"))
        count_res = mnrl_count_reactivated(key_id="DIU", count_date=date)
        total_count = count_res.get("count", 0)
        if total_count == 0:
            return {"error": "No records found for this date", "count": 0}, 404

        response = mnrl_data_reactivated_excel(
            key_id="DIU",
            total_count=total_count,
            date=date,
            BATCH_SIZE=req.get("batch_size", 3000),
            Bank_Id=req.get("BankId"),
            max_workers=req.get("max_workers", 5),
        )
        return {"data": response, "total_records": len(response)}, 200
    except ValueError as e:
        return {"error": str(e)}, 400
    except Exception as e:
        print(traceback.format_exc())
        return {"error": str(e)}, 500


@routes.route("/mnrl/export-and-save", methods=["POST"])
def route_mnrl_export():
    """Start a background MNRL export. Returns job_id immediately (202)."""
    req = request.get_json(silent=True) or {}
    date = req.get("date")
    data_type = req.get("data_type", "Normal")

    try:
        valid_date = _validate_date(date)
        valid_data_type = _validate_data_type(data_type)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = start_job(
            _do_mnrl_export,
            valid_date,
            valid_data_type,
            req.get("BankId"),
            req.get("batch_size", 3000),
            req.get("max_workers", 5),
        )
        return jsonify({"job_id": job_id, "status": "pending"}), 202
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# Job status (shared by all export modules)
@routes.route("/export/status/<job_id>", methods=["GET"])
def route_export_status(job_id):
    """GET /export/status/<job_id>"""
    job = get_job(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404

    response = {"job_id": job_id, "status": job["status"]}
    if job["status"] == "done":
        response["result"] = job["result"]
    elif job["status"] == "failed":
        last_line = (job.get("error") or "Unknown error").strip().splitlines()[-1]
        response["error"] = last_line
        print(f"[JOB FAILED] {job_id}:\n{job.get('error')}")

    return jsonify(response), 200


# Archive / Download
@routes.route("/files/list", methods=["GET"])
def route_files_list():
    """GET /files/list?type=FRI"""
    try:
        module = _validate_module(request.args.get("type", "FRI"))
        return jsonify(list_export_metadata(module))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/files/download-url/<file_id>", methods=["GET"])
def route_files_download_url(file_id):
    """GET /files/download-url/<uuid>?type=FRI"""
    try:
        module = _validate_module(request.args.get("type", "FRI"))
        row = get_export_metadata_row(file_id, module)
        url = get_sas_download_url(row["container"], row["blob_name"], expiry_hours=1)
        return jsonify({"url": url, "file_name": row["file_name"]})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


# Matchoff
@routes.route("/matchoff/folders", methods=["GET"])
def route_matchoff_folders():
    """GET /matchoff/folders?container=mnrl-exports"""
    container = request.args.get("container", "").strip()
    try:
        valid_container = _validate_container(container)
        folders = list_source_date_folders(valid_container)
        return jsonify({"folders": folders})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/matchoff/files", methods=["GET"])
def route_matchoff_files():
    """GET /matchoff/files?container=mnrl-exports&date=2025-03-10"""
    container = request.args.get("container", "").strip()
    date = request.args.get("date", "").strip()
    try:
        valid_container = _validate_container(container)
        if not date:
            raise ValueError("date query param is required")
        files = list_source_files(valid_container, date)
        return jsonify({"files": files})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/matchoff/start", methods=["POST"])
def route_matchoff_start():
    """POST /matchoff/start"""
    req = request.get_json(silent=True) or {}
    container = req.get("container", "").strip()
    date = req.get("date", "").strip()
    file_name = req.get("file_name", "").strip()
    mob_col = req.get("mob_col", "mob_num").strip() or "mob_num"

    try:
        valid_container = _validate_container(container)
        if not date:
            raise ValueError("date is required")
        if not file_name:
            raise ValueError("file_name is required")
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        job_id = start_job(_do_matchoff, valid_container, date, file_name, mob_col)
        return jsonify({"job_id": job_id, "status": "pending"}), 202
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/matchoff/history", methods=["GET"])
def route_matchoff_history():
    """GET /matchoff/history"""
    try:
        return jsonify(list_matchoff_metadata())
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


@routes.route("/matchoff/download-url/<run_id>", methods=["GET"])
def route_matchoff_download_url(run_id):
    """GET /matchoff/download-url/<uuid> - 24-hour SAS URL."""
    try:
        run = get_matchoff_run(run_id)
        url = get_sas_download_url(
            run["output_container"], run["output_blob_path"], expiry_hours=24
        )
        file_name = run["output_blob_path"].rsplit("/", 1)[-1]
        return jsonify({"url": url, "file_name": file_name})
    except ValueError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500