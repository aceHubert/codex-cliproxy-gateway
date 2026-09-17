import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  getGatewayLogTail,
  getRequestLog,
  listRequestLogs,
  type RequestLogFile,
  type UiStatus,
} from "./api.ts";
import { Header } from "./Header.tsx";
import { TextView } from "./TextView.tsx";
import { navigate } from "./hash-router.ts";
import { useI18n } from "./i18n.tsx";

type LogTab = "gateway" | "requests";

/** 分栏钳制：预览与文件表各自的最小宽度（px）。 */
const PREVIEW_MIN_WIDTH = 240;
const TABLE_MIN_WIDTH = 460;
const SPLITTER_WIDTH = 6;

/** 请求日志目录分页：默认每页条数与可选项（服务端上限 500）。 */
const REQUEST_LOG_PAGE_SIZE = 100;
const REQUEST_LOG_PAGE_SIZES = [50, 100, 200];

function formatTime(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSize(size: number): string {
  if (size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 尾部文本 → 行数组（去掉末尾空行，空文本返回空数组以触发占位文案）。 */
function toLines(text: string | undefined): string[] {
  if (!text) return [];
  const trimmed = text.replace(/\n$/, "");
  return trimmed === "" ? [] : trimmed.split("\n");
}

/** 网关日志行样式：错误摘要红、配置审计绿。 */
function gatewayLineClass(line: string): string {
  if (line.includes("!!!")) return "log-line line-err";
  if (line.includes("=== config changed")) return "log-line line-audit";
  return "log-line";
}

/** 请求日志预览行样式：分节标题高亮。 */
function previewLineClass(line: string): string | undefined {
  return line.startsWith("---") ? "preview-section-title" : undefined;
}

export function LogsPage({ status, onAuthExpired }: { status: UiStatus; onAuthExpired: () => void }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<LogTab>("gateway");
  const [gatewayLog, setGatewayLog] = useState<{ text: string; truncated: boolean } | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [files, setFiles] = useState<RequestLogFile[] | null>(null);
  const [totalFiles, setTotalFiles] = useState(0);
  const [logging, setLogging] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(REQUEST_LOG_PAGE_SIZE);
  const [selected, setSelected] = useState<{ name: string; text: string; truncated: boolean } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 默认选中第一条用：loadFilesPage 的闭包里不能读过期的 selected state。 */
  const selectedNameRef = useRef<string | null>(null);
  const [gatewayFindOpen, setGatewayFindOpen] = useState(false);
  const [requestFindOpen, setRequestFindOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const requestsViewRef = useRef<HTMLDivElement>(null);
  const gatewayWrapRef = useRef<HTMLDivElement>(null);
  const requestWrapRef = useRef<HTMLDivElement>(null);

  /** 页内 API 错误统一处理：令牌失效（401）上抛复用全局 TokenPrompt，其余落页内横幅。 */
  const handlePageApiError = useCallback((cause: unknown): void => {
    if (cause instanceof ApiError && cause.status === 401) {
      onAuthExpired();
      return;
    }
    setLoadError(cause instanceof Error ? cause.message : String(cause));
  }, [onAuthExpired]);

  const refreshGateway = useCallback((): void => {
    void getGatewayLogTail()
      .then((next) => {
        setGatewayLog(next);
        setLoadError(null);
      })
      .catch(handlePageApiError);
  }, [handlePageApiError]);
  /** 拉取请求日志目录的指定页（mtime 倒序）；页码越界时收敛到最后一页并触发重取。
   * 尚未选中任何文件时默认预览第一条（最新）。 */
  const loadFilesPage = useCallback((targetPage: number, size: number): void => {
    const offset = (targetPage - 1) * size;
    void listRequestLogs(offset, size)
      .then((next) => {
        setFiles(next.files);
        setTotalFiles(next.total);
        setLogging(next.logging);
        setLoadError(null);
        const maxPage = Math.max(1, Math.ceil(next.total / size));
        if (targetPage > maxPage) setPage(maxPage);
        if (selectedNameRef.current === null && next.files.length > 0) {
          const first = next.files[0];
          selectedNameRef.current = first.name;
          void getRequestLog(first.name).then(setSelected).catch(handlePageApiError);
        }
      })
      .catch(handlePageApiError);
  }, [handlePageApiError]);

  useEffect(() => {
    if (tab === "gateway") refreshGateway();
  }, [tab, refreshGateway]);

  useEffect(() => {
    if (tab === "requests") loadFilesPage(page, pageSize);
  }, [tab, page, pageSize, loadFilesPage]);

  useEffect(() => {
    if (tab !== "gateway" || !autoRefresh) return;
    const timer = window.setInterval(refreshGateway, 2000);
    return () => window.clearInterval(timer);
  }, [tab, autoRefresh, refreshGateway]);

  /**
   * 捕获层兜底：日志视图打开期间一律拦截 Cmd/Ctrl+F——浏览器原生「全网页查找」
   * 绝不触发；焦点不在文本视图内时路由到当前 tab 的查找框。焦点在文本内时由
   * TextView 组件处理（冒泡路径，见 TextView onKeyDown）。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || (event.key !== "f" && event.key !== "F")) return;
      event.preventDefault();
      const active = document.activeElement;
      if (gatewayWrapRef.current?.contains(active) || requestWrapRef.current?.contains(active)) return;
      if (tab === "gateway") setGatewayFindOpen(true);
      else setRequestFindOpen(true);
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [tab]);

  /** Esc 分层：有打开的查找框先关查找框（TextView 内部已处理冒泡前的 Esc）；否则退回配置页。 */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (gatewayFindOpen || requestFindOpen) {
        setGatewayFindOpen(false);
        setRequestFindOpen(false);
        return;
      }
      navigate("/");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gatewayFindOpen, requestFindOpen]);

  const openFile = (name: string): void => {
    selectedNameRef.current = name;
    void getRequestLog(name).then(setSelected).catch((cause: unknown) => {
      setSelected(null);
      handlePageApiError(cause);
    });
  };

  const gatewayLines = useMemo(() => toLines(gatewayLog?.text), [gatewayLog]);
  const previewLines = useMemo(() => toLines(selected?.text), [selected]);

  /** 分栏拖拽：Pointer Events + 指针捕获，实时调整预览宽度并钳制最小值。 */
  const onSplitterPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 指针捕获失败（如合成事件/非活动指针）不阻断拖拽，move 仍会冒泡到本元素。
    }
    draggingRef.current = true;
    setDragging(true);
    event.preventDefault();
  };
  const onSplitterPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    // ref 同步置位：pointerdown 后同帧到达的 move 也要生效，不等 React 状态提交。
    if (!draggingRef.current) return;
    const view = requestsViewRef.current;
    if (!view) return;
    const rect = view.getBoundingClientRect();
    if (rect.width === 0) return;
    const width = rect.right - event.clientX - SPLITTER_WIDTH / 2;
    setPreviewWidth(Math.min(Math.max(width, PREVIEW_MIN_WIDTH), rect.width - TABLE_MIN_WIDTH));
  };
  const onSplitterPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 指针可能已释放。
    }
  };

  const isWs = (name: string): boolean => name.includes("-ws-");
  const maxPage = Math.max(1, Math.ceil(totalFiles / pageSize));

  return (
    <div className="page logs-page">
      <Header status={status} />
      <div className="logs-toolbar">
        <div className="drawer-tabs">
          <button
            className={`drawer-tab-btn${tab === "gateway" ? " active" : ""}`}
            onClick={() => setTab("gateway")}
          >{t("tabGateway")}</button>
          <button
            className={`drawer-tab-btn${tab === "requests" ? " active" : ""}`}
            onClick={() => setTab("requests")}
          >{t("tabRequests")}</button>
        </div>

        {tab === "gateway" ? (
          <div className="drawer-toolbar">
            <button
              className="btn btn-secondary"
              style={{ padding: "4px 8px", fontSize: 11 }}
              onClick={refreshGateway}
              title={t("refreshTail")}
            >
              <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
            </button>
            <label className="auto-refresh-label">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
              />
              <span>{t("autoRefresh")}</span>
            </label>
            {gatewayLog?.truncated && <span className="truncated-note">{t("logTruncated")}</span>}
          </div>
        ) : (
          <button
            className="btn btn-secondary"
            style={{ padding: "4px 8px", fontSize: 11 }}
            onClick={() => loadFilesPage(page, pageSize)}
            title={t("refreshListTitle")}
          >
            <svg style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            <span>{t("refreshList")}</span>
          </button>
        )}
      </div>

      {loadError && (
        <div className="restart-banner error">
          <span>{t("loadFailed")}: {loadError}</span>
        </div>
      )}

      {tab === "gateway" ? (
        <div ref={gatewayWrapRef} className="logs-fill">
          <TextView
            lines={gatewayLines}
            className="terminal-view"
            lineClass={gatewayLineClass}
            emptyLabel={t("emptyLog")}
            autoScrollBottom
            open={gatewayFindOpen}
            onOpenChange={setGatewayFindOpen}
          />
        </div>
      ) : (
        <div ref={requestsViewRef} className="requests-view">
          <div className="file-table-container">
            {!logging && <div className="requests-empty">{t("loggingOffHint")}</div>}
            {logging && files && files.length === 0 && <div className="requests-empty">{t("requestsEmpty")}</div>}
            {files && files.length > 0 && (
              <table className="file-table">
                <thead>
                  <tr>
                    <th>{t("thFilename")}</th>
                    <th>Type</th>
                    <th>{t("thSize")}</th>
                    <th>{t("thUpdated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file) => (
                    <tr
                      key={file.name}
                      className={selected?.name === file.name ? "selected" : ""}
                      onClick={() => openFile(file.name)}
                    >
                      <td style={{ fontFamily: "var(--font-mono)", color: "var(--fg-primary)" }}>{file.name}</td>
                      <td>
                        <span className={`pill-badge ${isWs(file.name) ? "pill-purple" : "pill-cyan"}`}>
                          {isWs(file.name) ? "WS" : "HTTP"}
                        </span>
                      </td>
                      <td style={{ fontFamily: "var(--font-mono)" }}>{formatSize(file.size)}</td>
                      <td style={{ fontSize: 11 }}>{formatTime(file.mtimeMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {files !== null && totalFiles > 0 && (
              <div className="table-pager">
                <button
                  type="button"
                  className="btn btn-secondary pager-btn"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >{t("pagerPrev")}</button>
                <span className="pager-status">
                  {t("pagerStatus")
                    .replaceAll("{page}", String(page))
                    .replaceAll("{pages}", String(maxPage))
                    .replaceAll("{total}", String(totalFiles))}
                </span>
                <select
                  className="pager-size"
                  value={pageSize}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    setPage(1);
                  }}
                >
                  {REQUEST_LOG_PAGE_SIZES.map((size) => (
                    <option key={size} value={size}>{size} / {t("perPage")}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn-secondary pager-btn"
                  disabled={page >= maxPage}
                  onClick={() => setPage((current) => Math.min(maxPage, current + 1))}
                >{t("pagerNext")}</button>
              </div>
            )}
          </div>

          {logging && (
            <>
              <div
                className={`pane-splitter${dragging ? " dragging" : ""}`}
                title={t("splitterTitle")}
                onPointerDown={onSplitterPointerDown}
                onPointerMove={onSplitterPointerMove}
                onPointerUp={onSplitterPointerUp}
                onPointerCancel={onSplitterPointerUp}
              />

              <div
                ref={requestWrapRef}
                className="file-preview-pane"
                style={previewWidth === null ? undefined : { width: previewWidth }}
              >
                <div className="preview-header">
                  <span style={{ fontFamily: "var(--font-mono)", color: "var(--fg-primary)" }}>
                    {selected?.name ?? t("selectFile")}
                  </span>
                  {selected?.truncated && <span style={{ color: "#fbbf24" }}>{t("previewTruncated")}</span>}
                </div>
                <div className="preview-fill">
                  <TextView
                    lines={previewLines}
                    className="preview-body"
                    lineClass={previewLineClass}
                    emptyLabel={t("selectFile")}
                    open={requestFindOpen}
                    onOpenChange={setRequestFindOpen}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
