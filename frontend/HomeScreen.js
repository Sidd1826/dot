import { useState, useEffect, useCallback, useRef } from "react";
import {
  Database, FileSpreadsheet, Download, RefreshCw,
  CheckCircle, AlertCircle, X, Calendar, Loader2,
  Cloud, HardDrive, Shield, Upload, BarChart3, Clock,
  GitMerge, ChevronDown, ArrowRight, Search,
} from "lucide-react";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const BASE_URL =
  process.env.REACT_APP_ENV === "UAT"
    ? process.env.REACT_APP_BASE_URL_UAT
    : process.env.REACT_APP_BASE_URL_DEV;

const PAGE_SIZE = 10;

// ─────────────────────────────────────────────
// RECORD-COUNT-BASED DYNAMIC POLLING CONFIG
//
// Instead of a fixed time threshold, the slow-phase duration is
// derived from the actual record count known before the export starts.
//
//   FAST_POLL_MS    — poll interval once in fast phase (3 s)
//   SLOW_POLL_MS    — poll interval during patient phase (20 s)
//   MS_PER_RECORD   — rough estimate: server ms per record (tune this)
//   FAST_THRESHOLD  — counts at or below this skip slow phase entirely
//
// Examples with defaults (MS_PER_RECORD = 1.2):
//    10 000 records →  12 s estimated → FAST from start  (< 30 k)
//    50 000 records →  60 s estimated → slow 60 s, then fast
//   1 00 000 records → 120 s estimated → slow 120 s, then fast
//   5 00 000 records → 600 s estimated → slow 600 s, then fast
// ─────────────────────────────────────────────
const POLL = {
  FAST_POLL_MS:   3_000,
  SLOW_POLL_MS:  20_000,
  MS_PER_RECORD:    1.2,   // ← tune to match your server throughput
  FAST_THRESHOLD: 30_000,  // ← records below this always use fast mode
};

/** Returns how long (ms) to stay in slow-poll mode for a given count. */
function slowPhaseDuration(count) {
  if (!count || count <= POLL.FAST_THRESHOLD) return 0;
  return Math.round(count * POLL.MS_PER_RECORD);
}

// ─────────────────────────────────────────────
// API SERVICE
// ─────────────────────────────────────────────
const api = {
  async post(path, body) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  async get(path) {
    const res = await fetch(`${BASE_URL}${path}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed: ${res.status}`);
    }
    return res.json();
  },

  fetchFRICount:             (date)            => api.post("/fri/count", { date }),
  fetchMNRLCount:            (date)            => api.post("/mnrl/count", { date }),
  fetchMNRLCountReactivated: (date)            => api.post("/mnrl/count/reactivated", { date }),
  startFRIExport:            (date)            => api.post("/fri/export-and-save", { date }),
  startMNRLExport:           (date, data_type) => api.post("/mnrl/export-and-save", { date, data_type }),
  pollJobStatus:             (jobId)           => api.get(`/export/status/${jobId}`),
  listFiles:                 (type)            => api.get(`/files/list?type=${type}`),
  getDownloadUrl:            (fileId, type)    => api.get(`/files/download-url/${fileId}?type=${type}`),
  fetchMatchoffFolders:      (c)               => api.get(`/matchoff/folders?container=${c}`),
  fetchMatchoffFiles:        (c, d)            => api.get(`/matchoff/files?container=${c}&date=${d}`),
  // mob_col is always fixed to "mob_num" — removed from user input
  startMatchoff:             (c, d, f)         => api.post("/matchoff/start", { container: c, date: d, file_name: f, mob_col: "mob_num" }),
  listMatchoffHistory:       ()                => api.get("/matchoff/history"),
  getMatchoffDownloadUrl:    (id)              => api.get(`/matchoff/download-url/${id}`),
};

// ─────────────────────────────────────────────
// DYNAMIC POLLING HOOK — record-count-aware
//
// Accepts `recordCount` (known before the job starts) and uses
// slowPhaseDuration() to decide how long to poll slowly before
// switching to fast polling.
//
//   recordCount ≤ FAST_THRESHOLD  →  poll every 3 s from the start
//   recordCount > FAST_THRESHOLD  →  poll every 20 s for the estimated
//                                    processing time, then every 3 s
//
// Uses setTimeout (not setInterval) so the interval changes freely
// between ticks with no stale-closure issues.
// ─────────────────────────────────────────────
function useJobPoller({ jobId, recordCount = 0, onDone, onFailed }) {
  const timerRef      = useRef(null);
  const startedAt     = useRef(null);
  const isFast        = useRef(false);
  const slowPhaseMs   = useRef(0);  // computed once when job starts

  useEffect(() => {
    if (!jobId) return;

    startedAt.current   = Date.now();
    isFast.current      = false;
    slowPhaseMs.current = slowPhaseDuration(recordCount);

    // Log the strategy so it's visible in DevTools (no-op in prod)
    if (slowPhaseMs.current === 0) {
      console.info(`[Poller] ${recordCount.toLocaleString()} records → fast mode throughout (3 s)`);
    } else {
      console.info(
        `[Poller] ${recordCount.toLocaleString()} records → slow (20 s) for ${Math.round(slowPhaseMs.current / 1000)} s, then fast (3 s)`
      );
    }

    const stop = () => { if (timerRef.current) clearTimeout(timerRef.current); };

    const scheduleNext = () => {
      const elapsed = Date.now() - startedAt.current;
      const goFast  = slowPhaseMs.current === 0 || elapsed >= slowPhaseMs.current;
      if (goFast && !isFast.current) {
        isFast.current = true;
        console.info("[Poller] → switched to fast mode (3 s) after", Math.round(elapsed / 1000), "s");
      }
      timerRef.current = setTimeout(tick, goFast ? POLL.FAST_POLL_MS : POLL.SLOW_POLL_MS);
    };

    const tick = async () => {
      try {
        const data = await api.pollJobStatus(jobId);
        if      (data.status === "done")   { stop(); onDone(data.result); }
        else if (data.status === "failed") { stop(); onFailed(data.error || "Export failed"); }
        else                               { scheduleNext(); }
      } catch (e) { stop(); onFailed(e.message); }
    };

    tick(); // immediate first check — catches tiny jobs instantly
    return stop;
  }, [jobId]); // eslint-disable-line
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
const fmt = (n) => (n != null ? Number(n).toLocaleString("en-IN") : "—");
const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const fmtDateTime = (d) =>
  new Date(d).toLocaleString("en-IN", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
const today = () => new Date().toISOString().split("T")[0];
const triggerBlobDownload = (url, filename) => {
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
};

// ─────────────────────────────────────────────
// SHARED UI
// ─────────────────────────────────────────────
const Alert = ({ type, message, onClose }) => {
  const cfg = {
    success: { bar: "#10b981", bg: "#f0fdf4", text: "#065f46", Icon: CheckCircle },
    error:   { bar: "#ef4444", bg: "#fef2f2", text: "#7f1d1d", Icon: AlertCircle },
    warning: { bar: "#f59e0b", bg: "#fffbeb", text: "#78350f", Icon: AlertCircle },
  }[type] || { bar: "#6b7280", bg: "#f9fafb", text: "#111827", Icon: AlertCircle };

  return (
    <div style={{ background: cfg.bg, borderLeft: `4px solid ${cfg.bar}` }}
      className="flex items-start gap-3 px-4 py-3 rounded-lg mt-3">
      <cfg.Icon size={18} style={{ color: cfg.bar, flexShrink: 0, marginTop: 2 }} />
      <p className="flex-1 text-sm font-medium" style={{ color: cfg.text }}>{message}</p>
      {onClose && (
        <button onClick={onClose} style={{ color: cfg.text, opacity: 0.6 }}
          className="hover:opacity-100 transition-opacity">
          <X size={16} />
        </button>
      )}
    </div>
  );
};

const ExportProgress = ({ label }) => (
  <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 border-l-4 border-blue-500 rounded-lg mt-3">
    <Loader2 size={18} className="animate-spin text-blue-600 shrink-0" />
    <div className="flex-1">
      <p className="text-sm font-semibold text-blue-800">{label}</p>
      <p className="text-xs text-blue-500 mt-0.5">Processing in background · checking every 3s…</p>
    </div>
    <Clock size={15} className="text-blue-400" />
  </div>
);

const DatePicker = ({ value, onChange, label }) => (
  <div className="flex flex-col gap-1.5">
    <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-widest">
      <Calendar size={13} /> {label}
    </label>
    <input
      type="date" value={value} max={today()}
      onChange={(e) => onChange(e.target.value)}
      className="px-4 py-3 rounded-xl border border-slate-200 bg-white text-slate-800 font-medium text-sm
        focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all shadow-sm"
    />
  </div>
);

const CountBadge = ({ label, count, color = "blue" }) => {
  const colors = {
    blue:   { from: "#2563eb", to: "#4f46e5" },
    teal:   { from: "#0d9488", to: "#0891b2" },
    violet: { from: "#7c3aed", to: "#6d28d9" },
  }[color];
  return (
    <div className="rounded-xl p-4 text-white flex flex-col justify-between"
      style={{ background: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }}>
      <p className="text-xs font-semibold uppercase tracking-widest opacity-80">{label}</p>
      <p className="text-3xl font-bold mt-1 tabular-nums">
        {count === null ? <span className="opacity-40 text-2xl">—</span> : fmt(count)}
      </p>
      <p className="text-xs opacity-60 mt-1">records</p>
    </div>
  );
};

const ExportBtn = ({ onClick, loading, disabled, label }) => (
  <button onClick={onClick} disabled={disabled || loading}
    className="w-full flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-xl
      font-semibold text-sm transition-all shadow-md hover:shadow-lg
      disabled:opacity-50 disabled:cursor-not-allowed"
    style={{
      background: disabled || loading ? "#94a3b8" : "linear-gradient(135deg, #2563eb, #4f46e5)",
      color: "white",
    }}>
    {loading
      ? <><Loader2 size={16} className="animate-spin" /> Starting export…</>
      : <><Upload size={16} /> {label}</>}
  </button>
);

// ─────────────────────────────────────────────
// SEARCHABLE DROPDOWN
// Shows a search box when > 6 options; scrollable list capped at 220px.
// ─────────────────────────────────────────────
const SearchableSelect = ({ label, value, onChange, options, placeholder, disabled, loading }) => {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef           = useRef(null);
  const inputRef          = useRef(null);

  // Normalise to { value, label }
  const normalised = options.map((o) =>
    typeof o === "string" ? { value: o, label: o } : { value: o.value ?? o, label: o.label ?? o.value ?? o }
  );

  const filtered = query
    ? normalised.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : normalised;

  const selectedLabel = normalised.find((o) => o.value === value)?.label ?? "";

  // Close on outside click
  useEffect(() => {
    const h = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setQuery("");
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const handleOpen = () => {
    if (disabled || loading) return;
    setOpen((o) => !o);
    setQuery("");
    setTimeout(() => inputRef.current?.focus(), 60);
  };

  const handleSelect = (val) => {
    onChange(val); setOpen(false); setQuery("");
  };

  const showSearch = normalised.length > 6;

  return (
    <div className="flex flex-col gap-1.5 relative" ref={wrapRef}>
      {label && (
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{label}</label>
      )}

      {/* Trigger button */}
      <button
        type="button"
        onClick={handleOpen}
        disabled={disabled || loading}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl
          border border-slate-200 bg-white text-sm font-medium shadow-sm transition-all
          focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
          disabled:opacity-50 disabled:cursor-not-allowed hover:border-slate-300"
      >
        <span className={selectedLabel ? "text-slate-800 truncate" : "text-slate-400"}>
          {loading ? "Loading…" : (selectedLabel || placeholder || "Select…")}
        </span>
        {loading
          ? <Loader2 size={14} className="animate-spin text-slate-400 shrink-0" />
          : <ChevronDown size={14} className={`text-slate-400 shrink-0 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
        }
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          className="absolute left-0 right-0 top-full mt-1.5 bg-white rounded-xl border border-slate-200 shadow-xl overflow-hidden z-50"
          style={{ minWidth: 200 }}
        >
          {/* Search input — only when > 6 options */}
          {showSearch && (
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-slate-100 bg-slate-50">
              <Search size={13} className="text-slate-400 shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="flex-1 text-sm text-slate-700 bg-transparent outline-none placeholder:text-slate-400"
              />
              {query && (
                <button onClick={() => setQuery("")} className="text-slate-400 hover:text-slate-600 shrink-0">
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          {/* Option list */}
          <ul className="overflow-y-auto" style={{ maxHeight: 220 }}>
            {filtered.length === 0 ? (
              <li className="px-4 py-3 text-sm text-slate-400 text-center">No results found</li>
            ) : (
              filtered.map((o) => (
                <li key={o.value}>
                  <button
                    type="button"
                    onClick={() => handleSelect(o.value)}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors
                      ${o.value === value
                        ? "bg-blue-50 text-blue-700 font-semibold"
                        : "text-slate-700 hover:bg-slate-50"}`}
                  >
                    {o.label}
                  </button>
                </li>
              ))
            )}
          </ul>

          {/* Footer: result count when actively filtering */}
          {showSearch && query && (
            <div className="px-4 py-1.5 bg-slate-50 border-t border-slate-100 text-xs text-slate-400">
              {filtered.length} of {normalised.length} shown
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────
// PAGINATED FILES TABLE  (10 rows + Load More)
// ─────────────────────────────────────────────
const FilesTable = ({ files, loading, onDownload, showDataType = false }) => {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [files]);

  if (loading) return (
    <div className="flex flex-col items-center py-16 gap-3">
      <Loader2 size={28} className="animate-spin text-blue-400" />
      <p className="text-sm text-slate-400">Loading archive…</p>
    </div>
  );
  if (!files.length) return (
    <div className="flex flex-col items-center py-16 gap-3">
      <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
        <Cloud size={24} className="text-slate-400" />
      </div>
      <p className="text-slate-600 font-medium text-sm">No files yet</p>
      <p className="text-slate-400 text-xs">Export data to create the first archive entry</p>
    </div>
  );

  const sorted  = [...files].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {["File Name", "Export Date", showDataType && "Data Type", "Records", "Uploaded At", ""]
                .filter(Boolean)
                .map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                    {h}
                  </th>
                ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((file) => (
              <tr key={file.id} className="hover:bg-blue-50/40 transition-colors">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet size={15} className="text-green-600 shrink-0" />
                    <span className="text-slate-700 font-medium truncate max-w-[200px]">{file.file_name}</span>
                  </div>
                </td>
                <td className="px-5 py-3.5 text-slate-500 whitespace-nowrap">{fmtDate(file.export_date)}</td>
                {showDataType && (
                  <td className="px-5 py-3.5">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                      file.data_type === "Reactivated"
                        ? "bg-violet-100 text-violet-700"
                        : "bg-teal-100 text-teal-700"
                    }`}>
                      {file.data_type === "Reactivated" ? "Reactivated" : "Normal"}
                    </span>
                  </td>
                )}
                <td className="px-5 py-3.5">
                  <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-semibold tabular-nums">
                    {fmt(file.record_count)}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-slate-400 text-xs whitespace-nowrap">{fmtDateTime(file.created_at)}</td>
                <td className="px-5 py-3.5">
                  <button onClick={() => onDownload(file)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-blue-600
                      bg-blue-50 hover:bg-blue-600 hover:text-white rounded-lg transition-all">
                    <Download size={13} /> Download
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between mt-3 px-1">
        <p className="text-xs text-slate-400">
          Showing <span className="font-semibold text-slate-600">{visible.length}</span> of{" "}
          <span className="font-semibold text-slate-600">{sorted.length}</span> files
        </p>
        {hasMore && (
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-blue-600
              bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-all">
            Load more
            <span className="ml-0.5 px-1.5 py-0.5 bg-blue-200 text-blue-700 rounded-full text-xs">
              {sorted.length - visibleCount} left
            </span>
          </button>
        )}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────
// PAGINATED HISTORY TABLE  (10 rows + Load More)
// ─────────────────────────────────────────────
const HistoryTable = ({ runs, loading, onDownload }) => {
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [runs]);

  if (loading) return (
    <div className="flex flex-col items-center py-14 gap-3">
      <Loader2 size={26} className="animate-spin text-indigo-400" />
      <p className="text-sm text-slate-400">Loading history…</p>
    </div>
  );
  if (!runs.length) return (
    <div className="flex flex-col items-center py-14 gap-3">
      <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center">
        <Cloud size={22} className="text-slate-400" />
      </div>
      <p className="text-slate-500 text-sm font-medium">No matchoff runs yet</p>
    </div>
  );

  const sorted  = [...runs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const visible = sorted.slice(0, visibleCount);
  const hasMore = visibleCount < sorted.length;

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {["Source", "Date", "File", "Input rows", "Matched", "Match %", "Run at", ""].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((run) => {
              const pct = run.input_row_count > 0
                ? Math.round((run.matched_count / run.input_row_count) * 100) : 0;
              return (
                <tr key={run.id} className="hover:bg-indigo-50/30 transition-colors">
                  <td className="px-4 py-3.5">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold whitespace-nowrap ${
                      run.source_container === "fri-exports"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-teal-100 text-teal-700"
                    }`}>
                      {run.source_container === "fri-exports" ? "FRI" : "MNRL"}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-slate-500 whitespace-nowrap text-xs font-mono">
                    {run.source_date_folder}
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-1.5">
                      <FileSpreadsheet size={13} className="text-green-600 shrink-0" />
                      <span className="text-slate-700 truncate max-w-[160px] text-xs" title={run.source_file_name}>
                        {run.source_file_name}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-xs font-semibold tabular-nums">
                      {fmt(run.input_row_count)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded-full text-xs font-semibold tabular-nums">
                      {fmt(run.matched_count)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <div className="w-14 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                        <div className="h-1.5 bg-indigo-500 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-slate-500 tabular-nums">{pct}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-slate-400 text-xs whitespace-nowrap">
                    {fmtDateTime(run.created_at)}
                  </td>
                  <td className="px-4 py-3.5">
                    <button onClick={() => onDownload(run)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs font-semibold
                        text-indigo-600 bg-indigo-50 hover:bg-indigo-600 hover:text-white
                        rounded-lg transition-all whitespace-nowrap">
                      <Download size={12} /> Download
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between mt-3 px-1">
        <p className="text-xs text-slate-400">
          Showing <span className="font-semibold text-slate-600">{visible.length}</span> of{" "}
          <span className="font-semibold text-slate-600">{sorted.length}</span> runs
        </p>
        {hasMore && (
          <button
            onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
            className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-indigo-600
              bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-all">
            Load more
            <span className="ml-0.5 px-1.5 py-0.5 bg-indigo-200 text-indigo-700 rounded-full text-xs">
              {sorted.length - visibleCount} left
            </span>
          </button>
        )}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────
// FRI MODULE
// ─────────────────────────────────────────────
const FRIModule = () => {
  const [date, setDate]             = useState(today());
  const [count, setCount]           = useState(null);
  const [recordCount, setRecordCount] = useState(0); // used by poller
  const [files, setFiles]           = useState([]);
  const [loadingFiles, setLF]       = useState(true);
  const [starting, setStarting]     = useState(false);
  const [jobId, setJobId]           = useState(null);
  const [alert, setAlert]           = useState(null);

  const showAlert = (type, message) => {
    setAlert({ type, message });
    if (type === "success") setTimeout(() => setAlert(null), 7000);
  };

  const loadFiles = useCallback(async () => {
    setLF(true);
    try { setFiles(await api.listFiles("FRI")); }
    catch (e) { showAlert("error", "Failed to load archive: " + e.message); }
    finally { setLF(false); }
  }, []);

  const handleDateChange = async (d) => {
    setDate(d); setCount(null);
    try { const r = await api.fetchFRICount(d); setCount(r.count); }
    catch { /* silent */ }
  };

  const handleExport = async () => {
    setStarting(true); setAlert(null);
    try {
      const r = await api.fetchFRICount(date);
      setCount(r.count);
      if (r.count === 0) { showAlert("warning", "No records for selected date."); return; }
      setRecordCount(r.count);           // ← tell poller how many records
      const job = await api.startFRIExport(date);
      setJobId(job.job_id);
    } catch (e) { showAlert("error", e.message); }
    finally { setStarting(false); }
  };

  useJobPoller({
    jobId,
    recordCount,                         // ← drives slow/fast phase duration
    onDone: async (result) => {
      setJobId(null); await loadFiles();
      showAlert("success", `✓ Exported ${fmt(result.record_count)} records → saved to Azure Blob`);
    },
    onFailed: (err) => { setJobId(null); showAlert("error", err); },
  });

  const handleDownload = async (file) => {
    try {
      const { url, file_name } = await api.getDownloadUrl(file.id, "FRI");
      triggerBlobDownload(url, file_name);
    } catch (e) { showAlert("error", "Download failed: " + e.message); }
  };

  useEffect(() => { loadFiles(); }, [loadFiles]);
  useEffect(() => { handleDateChange(date); }, []); // eslint-disable-line

  const isExporting = starting || !!jobId;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center">
            <Database size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">FRI Data Export</h2>
            <p className="text-xs text-slate-400">Azure Blob · PostgreSQL metadata · Background processing</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <DatePicker value={date} onChange={handleDateChange} label="Select Export Date" />
          <CountBadge label="FRI Records" count={count} color="blue" />
          <div className="rounded-xl border border-slate-200 p-4 flex flex-col gap-2 justify-center bg-slate-50">
            <div className="flex items-center gap-2 text-slate-400 text-xs font-medium"><Cloud size={14} /> Azure Blob Storage</div>
            <div className="flex items-center gap-2 text-slate-400 text-xs font-medium"><HardDrive size={14} /> PostgreSQL Metadata</div>
            <div className="flex items-center gap-2 text-slate-400 text-xs font-medium"><Shield size={14} /> SAS-Token Downloads</div>
          </div>
        </div>

        <ExportBtn onClick={handleExport} loading={starting}
          disabled={count === 0 || isExporting} label="Export FRI Data → Azure Blob" />

        {jobId && <ExportProgress label="Export in progress — building Excel & uploading to Blob…" />}
        {alert && <Alert type={alert.type} message={alert.message} onClose={() => setAlert(null)} />}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-blue-600" />
            <h3 className="font-bold text-slate-800">FRI Archive</h3>
            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 text-xs font-semibold rounded-full">{files.length} files</span>
          </div>
          <button onClick={loadFiles} disabled={loadingFiles}
            className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium px-3 py-1.5 hover:bg-blue-50 rounded-lg transition-colors">
            <RefreshCw size={13} className={loadingFiles ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
        <FilesTable files={files} loading={loadingFiles} onDownload={handleDownload} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// MNRL MODULE
// ─────────────────────────────────────────────
const MNRLModule = () => {
  const [date, setDate]               = useState(today());
  const [normalCount, setNC]          = useState(null);
  const [reactCount, setRC]           = useState(null);
  const [rcNormal, setRcNormal]       = useState(0); // poller record counts
  const [rcReact, setRcReact]         = useState(0);
  const [files, setFiles]             = useState([]);
  const [loadingFiles, setLF]         = useState(true);
  const [startingNormal, setSN]       = useState(false);
  const [startingReact, setSR]        = useState(false);
  const [jobNormal, setJobNormal]     = useState(null);
  const [jobReact, setJobReact]       = useState(null);
  const [alert, setAlert]             = useState(null);

  const showAlert = (type, message) => {
    setAlert({ type, message });
    if (type === "success") setTimeout(() => setAlert(null), 7000);
  };

  const loadFiles = useCallback(async () => {
    setLF(true);
    try { setFiles(await api.listFiles("MNRL")); }
    catch (e) { showAlert("error", "Failed to load archive: " + e.message); }
    finally { setLF(false); }
  }, []);

  const fetchCounts = async (d) => {
    const [n, r] = await Promise.allSettled([
      api.fetchMNRLCount(d),
      api.fetchMNRLCountReactivated(d),
    ]);
    setNC(n.status === "fulfilled" ? n.value.count : null);
    setRC(r.status === "fulfilled" ? r.value.count : null);
  };

  const handleDateChange = async (d) => {
    setDate(d); setNC(null); setRC(null);
    await fetchCounts(d);
  };

  const handleExportNormal = async () => {
    setSN(true); setAlert(null);
    try {
      if (normalCount === 0) { showAlert("warning", "No normal records for selected date."); return; }
      setRcNormal(normalCount ?? 0);     // ← tell poller
      const job = await api.startMNRLExport(date, "Normal");
      setJobNormal(job.job_id);
    } catch (e) { showAlert("error", e.message); }
    finally { setSN(false); }
  };

  const handleExportReactivated = async () => {
    setSR(true); setAlert(null);
    try {
      if (reactCount === 0) { showAlert("warning", "No reactivated records for selected date."); return; }
      setRcReact(reactCount ?? 0);       // ← tell poller
      const job = await api.startMNRLExport(date, "Reactivated");
      setJobReact(job.job_id);
    } catch (e) { showAlert("error", e.message); }
    finally { setSR(false); }
  };

  useJobPoller({
    jobId: jobNormal,
    recordCount: rcNormal,               // ← drives slow/fast phase
    onDone: async (result) => {
      setJobNormal(null); await loadFiles();
      showAlert("success", `✓ Exported ${fmt(result.record_count)} Normal records → Azure Blob`);
    },
    onFailed: (err) => { setJobNormal(null); showAlert("error", err); },
  });

  useJobPoller({
    jobId: jobReact,
    recordCount: rcReact,                // ← drives slow/fast phase
    onDone: async (result) => {
      setJobReact(null); await loadFiles();
      showAlert("success", `✓ Exported ${fmt(result.record_count)} Reactivated records → Azure Blob`);
    },
    onFailed: (err) => { setJobReact(null); showAlert("error", err); },
  });

  const handleDownload = async (file) => {
    try {
      const { url, file_name } = await api.getDownloadUrl(file.id, "MNRL");
      triggerBlobDownload(url, file_name);
    } catch (e) { showAlert("error", "Download failed: " + e.message); }
  };

  useEffect(() => { loadFiles(); }, [loadFiles]);
  useEffect(() => { fetchCounts(date); }, []); // eslint-disable-line

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-teal-600 flex items-center justify-center">
            <Database size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">MNRL Data Export</h2>
            <p className="text-xs text-slate-400">Normal & Reactivated · Azure Blob · Background processing</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <DatePicker value={date} onChange={handleDateChange} label="Select Export Date" />
          <CountBadge label="Normal Records"      count={normalCount} color="teal" />
          <CountBadge label="Reactivated Records" count={reactCount}  color="violet" />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
          <div>
            <ExportBtn onClick={handleExportNormal} loading={startingNormal}
              disabled={normalCount === 0 || !!jobNormal || !!jobReact}
              label="Export Normal → Azure Blob" />
            {jobNormal && <ExportProgress label="Normal export running…" />}
          </div>
          <div>
            <ExportBtn onClick={handleExportReactivated} loading={startingReact}
              disabled={reactCount === 0 || !!jobReact || !!jobNormal}
              label="Export Reactivated → Azure Blob" />
            {jobReact && <ExportProgress label="Reactivated export running…" />}
          </div>
        </div>

        {alert && <Alert type={alert.type} message={alert.message} onClose={() => setAlert(null)} />}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-teal-600" />
            <h3 className="font-bold text-slate-800">MNRL Archive</h3>
            <span className="px-2 py-0.5 bg-teal-100 text-teal-700 text-xs font-semibold rounded-full">{files.length} files</span>
          </div>
          <button onClick={loadFiles} disabled={loadingFiles}
            className="flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-800 font-medium px-3 py-1.5 hover:bg-teal-50 rounded-lg transition-colors">
            <RefreshCw size={13} className={loadingFiles ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
        <FilesTable files={files} loading={loadingFiles} onDownload={handleDownload} showDataType />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// MATCHOFF MODULE
// ─────────────────────────────────────────────
const MatchStatBar = ({ inputRows, matchedCount }) => {
  const pct = inputRows > 0 ? Math.round((matchedCount / inputRows) * 100) : 0;
  return (
    <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 mt-4">
      <div className="flex items-baseline justify-between mb-2">
        <span className="text-sm font-semibold text-indigo-700">Match result</span>
        <span className="text-sm text-indigo-500 tabular-nums">
          {fmt(matchedCount)} / {fmt(inputRows)} rows ({pct}%)
        </span>
      </div>
      <div className="h-2.5 bg-indigo-200 rounded-full overflow-hidden">
        <div className="h-2.5 bg-indigo-600 rounded-full transition-all duration-700"
          style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
};

const MatchoffModule = () => {
  const [container, setContainer]     = useState("mnrl-exports");
  const [folders, setFolders]         = useState([]);
  const [selDate, setSelDate]         = useState("");
  const [files, setFiles]             = useState([]);
  const [selFile, setSelFile]         = useState("");
  const [loadingFolders, setLF]       = useState(false);
  const [loadingFiles, setLFiles]     = useState(false);
  const [starting, setStarting]       = useState(false);
  const [jobId, setJobId]             = useState(null);
  const [lastResult, setLastResult]   = useState(null);
  const [runs, setRuns]               = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [alert, setAlert]             = useState(null);

  const showAlert = (type, message) => {
    setAlert({ type, message });
    if (type === "success") setTimeout(() => setAlert(null), 8000);
  };

  const loadFolders = useCallback(async (c) => {
    setLF(true); setFolders([]); setSelDate(""); setFiles([]); setSelFile("");
    try {
      const data = await api.fetchMatchoffFolders(c);
      const list = data.folders || [];
      setFolders(list);
      if (list.length) setSelDate(list[0]);
    } catch (e) { showAlert("error", "Failed to load date folders: " + e.message); }
    finally { setLF(false); }
  }, []);

  const loadFiles = useCallback(async (c, d) => {
    if (!d) return;
    setLFiles(true); setFiles([]); setSelFile("");
    try {
      const data = await api.fetchMatchoffFiles(c, d);
      const list = data.files || [];
      setFiles(list);
      if (list.length) setSelFile(list[0]);
    } catch (e) { showAlert("error", "Failed to load files: " + e.message); }
    finally { setLFiles(false); }
  }, []);

  const loadHistory = useCallback(async () => {
    setLoadingRuns(true);
    try { setRuns(await api.listMatchoffHistory()); }
    catch (e) { showAlert("error", "Failed to load history: " + e.message); }
    finally { setLoadingRuns(false); }
  }, []);

  const handleContainerChange = (c) => { setContainer(c); setLastResult(null); loadFolders(c); };
  const handleDateChange = (d) => { setSelDate(d); setLastResult(null); loadFiles(container, d); };

  const handleStart = async () => {
    if (!selFile) { showAlert("warning", "Please select a file."); return; }
    setStarting(true); setAlert(null); setLastResult(null);
    try {
      const job = await api.startMatchoff(container, selDate, selFile); // mob_col fixed internally
      setJobId(job.job_id);
    } catch (e) { showAlert("error", e.message); }
    finally { setStarting(false); }
  };

  useJobPoller({
    jobId,
    recordCount: 0, // Matchoff row count is unknown until server reads Excel → always fast
    onDone: async (result) => {
      setJobId(null); setLastResult(result); await loadHistory();
      showAlert("success", `Match-off complete — ${fmt(result.matched_count)} of ${fmt(result.input_row_count)} rows matched.`);
    },
    onFailed: (err) => { setJobId(null); showAlert("error", err); },
  });

  const handleDownloadLatest = () => {
    if (lastResult?.sas_url) triggerBlobDownload(lastResult.sas_url, lastResult.output_file);
  };

  const handleDownloadRun = async (run) => {
    try {
      const { url, file_name } = await api.getMatchoffDownloadUrl(run.id);
      triggerBlobDownload(url, file_name);
    } catch (e) { showAlert("error", "Download failed: " + e.message); }
  };

  useEffect(() => { loadFolders(container); loadHistory(); }, []); // eslint-disable-line
  useEffect(() => { if (selDate) loadFiles(container, selDate); }, [selDate]); // eslint-disable-line

  const isRunning = starting || !!jobId;
  const canRun    = !isRunning && !!selFile && !!selDate;

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center">
            <GitMerge size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-800">Mobile Number Match-off</h2>
            <p className="text-xs text-slate-400">
              Pick source Excel from Blob · Match mob_num vs Azure SQL finalmob_num · Get cust_id
            </p>
          </div>
        </div>

        {/* ── 3 cascade searchable dropdowns ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
          <SearchableSelect
            label="Source container"
            value={container}
            onChange={handleContainerChange}
            disabled={isRunning}
            options={[
              { value: "fri-exports",  label: "FRI Exports" },
              { value: "mnrl-exports", label: "MNRL Exports" },
            ]}
            placeholder="Select container"
          />
          <SearchableSelect
            label="Date folder"
            value={selDate}
            onChange={handleDateChange}
            disabled={isRunning}
            loading={loadingFolders}
            options={folders}
            placeholder="No folders found"
          />
          <SearchableSelect
            label="Excel file"
            value={selFile}
            onChange={(v) => { setSelFile(v); setLastResult(null); }}
            disabled={isRunning}
            loading={loadingFiles}
            options={files}
            placeholder="Select a date first"
          />
        </div>

        {/* Fixed mob_col info chip — read-only */}
        <div className="flex items-center gap-2 mb-5 p-3 bg-slate-50 rounded-xl border border-slate-200">
          <span className="text-xs text-slate-500 font-medium">Mobile number column:</span>
          <code className="px-2.5 py-1 bg-white border border-slate-200 text-slate-700 rounded-lg text-xs font-mono font-semibold shadow-sm">
            mob_num
          </code>
          <span className="text-xs text-slate-400 italic">· fixed, not editable</span>
        </div>

        {/* Flow summary strip */}
        {selFile && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400
            bg-slate-50 rounded-xl px-4 py-3 mb-5 border border-slate-100">
            <span className={`px-2 py-1 rounded font-semibold ${
              container === "fri-exports" ? "bg-blue-100 text-blue-700" : "bg-teal-100 text-teal-700"
            }`}>
              {container}/{selDate}/
            </span>
            <span className="px-2 py-1 bg-slate-200 text-slate-600 rounded font-mono truncate max-w-[200px]">
              {selFile}
            </span>
            <ArrowRight size={12} />
            <span className="px-2 py-1 bg-amber-100 text-amber-700 rounded font-semibold">Azure SQL match</span>
            <ArrowRight size={12} />
            <span className="px-2 py-1 bg-green-100 text-green-700 rounded font-semibold">
              matchoff-output/{selDate}/
            </span>
          </div>
        )}

        {/* Run button */}
        <button
          onClick={handleStart}
          disabled={!canRun}
          className="w-full flex items-center justify-center gap-2.5 px-5 py-3.5 rounded-xl
            font-semibold text-sm transition-all shadow-md hover:shadow-lg
            disabled:opacity-50 disabled:cursor-not-allowed"
          style={{
            background: canRun ? "linear-gradient(135deg, #4f46e5, #6d28d9)" : "#94a3b8",
            color: "white",
          }}
        >
          {starting
            ? <><Loader2 size={16} className="animate-spin" /> Starting…</>
            : isRunning
            ? <><Loader2 size={16} className="animate-spin" /> Running match-off…</>
            : <><GitMerge size={16} /> Run Match-off</>}
        </button>

        {/* Progress */}
        {jobId && (
          <div className="flex items-center gap-3 px-4 py-3 bg-indigo-50 border-l-4 border-indigo-500 rounded-lg mt-3">
            <Loader2 size={18} className="animate-spin text-indigo-600 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-indigo-800">
                Reading Excel from Blob → querying Azure SQL → building matched output…
              </p>
              <p className="text-xs text-indigo-400 mt-0.5">Running in background · checking every 3s…</p>
            </div>
            <Clock size={15} className="text-indigo-400" />
          </div>
        )}

        {/* Inline result after completion */}
        {lastResult && !jobId && (
          <div className="mt-2">
            <MatchStatBar inputRows={lastResult.input_row_count} matchedCount={lastResult.matched_count} />
            <button
              onClick={handleDownloadLatest}
              className="mt-3 w-full flex items-center justify-center gap-2 px-5 py-3 rounded-xl
                font-semibold text-sm bg-green-600 hover:bg-green-700 text-white transition-all shadow-md">
              <Download size={16} /> Download {lastResult.output_file}
            </button>
          </div>
        )}

        {alert && <Alert type={alert.type} message={alert.message} onClose={() => setAlert(null)} />}
      </div>

      {/* History */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2">
            <BarChart3 size={18} className="text-indigo-600" />
            <h3 className="font-bold text-slate-800">Matchoff History</h3>
            <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-xs font-semibold rounded-full">
              {runs.length} runs
            </span>
          </div>
          <button onClick={loadHistory} disabled={loadingRuns}
            className="flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800
              font-medium px-3 py-1.5 hover:bg-indigo-50 rounded-lg transition-colors">
            <RefreshCw size={13} className={loadingRuns ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
        <HistoryTable runs={runs} loading={loadingRuns} onDownload={handleDownloadRun} />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// HEADER + ROOT
// ─────────────────────────────────────────────
const Header = ({ active, setActive }) => (
  <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
    <div className="max-w-5xl mx-auto flex items-center justify-between h-16 px-6">
      <div className="flex items-center gap-3">
        <img src="/HSBC_MASTERBRAND_LOGO_RGB.png" alt="HSBC" style={{ height: 44 }} />
        <div className="h-7 w-px bg-slate-200" />
        <span className="text-sm font-semibold text-slate-600 tracking-wide">DOT Intelligence Platform</span>
      </div>
      <nav className="flex gap-1 bg-slate-100 rounded-xl p-1">
        {[
          { key: "FRI",      label: "FRI" },
          { key: "MNRL",     label: "MNRL" },
          { key: "MATCHOFF", label: "Match-off" },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setActive(key)}
            className={`px-5 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              active === key ? "bg-white shadow-sm text-blue-700" : "text-slate-500 hover:text-slate-700"
            }`}>
            {label}
          </button>
        ))}
      </nav>
    </div>
  </header>
);

export default function HomeScreen() {
  const [active, setActive] = useState("FRI");
  return (
    <div className="min-h-screen bg-slate-50">
      <Header active={active} setActive={setActive} />
      <main className="max-w-5xl mx-auto px-6 py-8">
        {active === "FRI"      && <FRIModule />}
        {active === "MNRL"     && <MNRLModule />}
        {active === "MATCHOFF" && <MatchoffModule />}
      </main>
    </div>
  );
}