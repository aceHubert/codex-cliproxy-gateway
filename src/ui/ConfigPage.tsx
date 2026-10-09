import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  applyUpstreamModels,
  getUiConfig,
  getUiStatus,
  postUiConfig,
  restartCodexAppServers,
  type UiConfig,
  type UiConfigChanges,
  type UiStatus,
} from "./api.ts";
import { Header } from "./Header.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { useI18n, type I18nKey } from "./i18n.tsx";
import type { ExcludedModelGroup } from "./api.ts";
import { joinExcludedLines, splitExcludedLines } from "./excluded-models-field.ts";
import { isValidRequestLogCount, LOG_SIZE_UNITS, parseLogSizeField, splitLogSize, type LogSizeUnit } from "./log-size-field.ts";

/** 分组 key → 文案键的静态映射（i18n 键是字面量联合类型，模板字符串无法直接索引）。 */
const EXCLUDED_GROUP_LABELS: Record<string, I18nKey> = {
  zcode: "excludedGroup_zcode",
  codebuddy: "excludedGroup_codebuddy",
  workbuddy: "excludedGroup_workbuddy",
  qoder: "excludedGroup_qoder",
  agy: "excludedGroup_agy",
};

/** 表单态：数值/大小字段保持字符串，与服务端 CLI 解析规则一致。
 * CodeBuddy 账号不在表单内：UI 只读展示实时解析标签，切换走 CLI。 */
interface FormState {
  zcode: boolean;
  codebuddy: boolean;
  qoder: boolean;
  agy: boolean;
  opencodeZen: boolean;
  requestLogging: boolean;
  maxRequestLogs: string;
  maxGatewayLogBytes: string;
  maxGatewayLogUnit: LogSizeUnit;
  /** 当前勾选的上游模型；与 config.editable.selectedModels 按集合比较。 */
  selectedModels: string[];
  /** 排除模型分组 key → 多行文本（每行一个模型名，不带前缀；保存时服务端补全）。 */
  excludedEntries: Record<string, string>;
}

type SavePhase = "idle" | "confirm" | "saving" | "restarting" | "failed";

interface CodexNotice {
  kind: "ok" | "warn" | "error";
  text: string;
}

function sameSelection(left: string[], right: string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

/** 排除分组条目 ↔ 多行文本的统一比较：两侧都归一为「行数组」后再拼接。 */
function excludedEntriesChanged(
  formEntries: Record<string, string>,
  groups: ExcludedModelGroup[],
  savedEntries: Record<string, string[]>,
): boolean {
  return groups.some((group) =>
    splitExcludedLines(formEntries[group.key] ?? "").join("\n") !== (savedEntries[group.key] ?? []).join("\n"));
}

function CopyButton({ text, title }: { text: string; title: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-icon-btn"
      title={title}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <span style={{ fontSize: 11 }}>{t("copied")}</span> : (
        <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  );
}

function ReadonlyRow({
  label, keyname, children,
}: { label: string; keyname: string; children: React.ReactNode }) {
  return (
    <div className="field-row">
      <div className="field-label-group">
        <span className="field-label">{label}</span>
        <span className="field-keyname">{keyname}</span>
      </div>
      <div className="field-control-area">{children}</div>
    </div>
  );
}

/** 排除模型的单分组输入框：只填模型名，前缀由网关在保存时补全。 */
function ExcludedGroupInput({
  label, value, disabled, onChange,
}: { label: string; value: string; disabled: boolean; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return (
    <label className="excluded-group">
      <span className="excluded-group-label">{label}</span>
      <textarea
        className="input-textarea"
        rows={2}
        spellCheck={false}
        placeholder={t("excludedGroupPlaceholder")}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ConfigPage({
  status, onStatusChange, onAuthExpired,
}: {
  status: UiStatus;
  onStatusChange: (status: UiStatus) => void;
  onAuthExpired: () => void;
}) {
  const { t } = useI18n();
  const [config, setConfig] = useState<UiConfig | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [phase, setPhase] = useState<SavePhase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [codexNotice, setCodexNotice] = useState<CodexNotice | null>(null);

  const loadConfig = useCallback((): void => {
    setLoadError(null);
    void getUiConfig().then((next) => {
      const logSize = splitLogSize(next.editable.maxGatewayLogBytes ?? 0);
      const excludedEntries: Record<string, string> = {};
      for (const group of next.editable.excludedGroups) {
        excludedEntries[group.key] = joinExcludedLines(next.editable.excludedEntries[group.key]);
      }
      setConfig(next);
      setForm({
        zcode: next.editable.zcode,
        codebuddy: next.editable.codebuddy,
        qoder: next.editable.qoder,
        agy: next.editable.agy,
        // 兼容未带该字段的后端（升级窗口期）：缺省视为关闭。
        opencodeZen: next.editable.opencodeZen === true,
        requestLogging: next.editable.requestLogging,
        maxRequestLogs: String(next.editable.maxRequestLogs ?? 0),
        maxGatewayLogBytes: logSize.value,
        maxGatewayLogUnit: logSize.unit,
        selectedModels: next.editable.selectedModels,
        excludedEntries,
      });
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthExpired();
        return;
      }
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [onAuthExpired]);
  useEffect(loadConfig, [loadConfig]);

  const modelsDirty = Boolean(config && form
    && !sameSelection(form.selectedModels, config.editable.selectedModels));
  const logSize = form ? parseLogSizeField(form.maxGatewayLogBytes, form.maxGatewayLogUnit) : null;
  const invalidLogSize = form !== null && logSize === null;
  const invalidRequestLogCount = form !== null && !isValidRequestLogCount(form.maxRequestLogs);
  const genericDirty = useMemo(() => {
    if (!config || !form) return false;
    return form.zcode !== config.editable.zcode
      || form.codebuddy !== config.editable.codebuddy
      || form.qoder !== config.editable.qoder
      || form.agy !== config.editable.agy
      || form.opencodeZen !== (config.editable.opencodeZen === true)
      || form.requestLogging !== config.editable.requestLogging
      || form.maxRequestLogs !== String(config.editable.maxRequestLogs ?? 0)
      || parseLogSizeField(form.maxGatewayLogBytes, form.maxGatewayLogUnit)?.bytes !== (config.editable.maxGatewayLogBytes ?? 0)
      || excludedEntriesChanged(form.excludedEntries, config.editable.excludedGroups, config.editable.excludedEntries);
  }, [config, form]);
  const dirty = modelsDirty || genericDirty;
  const upstreamOnly = config?.readonly.upstreamOnly === true;
  // 开关按本机配置探测结果显示：未检测到本地配置时隐藏，避免展示永远无法生效的入口；
  // 开关已开启时（例如用户删掉了本机配置）仍显示，便于在 UI 里关回。
  const showZcode = Boolean(config && (config.detected.zcode || config.editable.zcode));
  const showCodebuddy = Boolean(config && (config.detected.codebuddy || config.editable.codebuddy));
  const showQoder = Boolean(config && (config.detected.qoder || config.editable.qoder));
  const showAgy = Boolean(config && (config.detected.agy || config.editable.agy));
  // 兼容旧后端返回结构：仅接受数组形式的生效来源，避免升级窗口期内渲染报错。
  const qoderSources = Array.isArray(config?.detected.qoderSources) ? config.detected.qoderSources : [];
  /** 各兼容端下按前缀分组的排除模型输入框；条目只填模型名，前缀由网关保存时补全。 */
  const excludedDisabled = phase === "saving" || phase === "restarting" || phase === "confirm";
  const renderExcludedGroups = (endpoint: ExcludedModelGroup["endpoint"]): React.ReactNode => {
    if (!config || !form) return null;
    const groups = config.editable.excludedGroups.filter((group) => group.endpoint === endpoint);
    if (groups.length === 0) return null;
    return (
      <div className="excluded-groups">
        {groups.map((group) => {
          const labelKey = EXCLUDED_GROUP_LABELS[group.key];
          return (
            <ExcludedGroupInput
              key={group.key}
              label={labelKey ? t(labelKey) : group.key}
              value={form.excludedEntries[group.key] ?? ""}
              disabled={excludedDisabled}
              onChange={(value) => setForm((current) => current
                ? { ...current, excludedEntries: { ...current.excludedEntries, [group.key]: value } }
                : current)}
            />
          );
        })}
        <p className="field-desc">{t("descExcludedGroup")}</p>
      </div>
    );
  };

  /** 网关重启完成后恢复：刷新配置与状态并提示已生效。 */
  useEffect(() => {
    if (phase !== "restarting") return;
    const timer = window.setInterval(() => {
      void getUiStatus()
        .then((next) => {
          onStatusChange(next);
          setPhase("idle");
          loadConfig();
        })
        .catch((cause: unknown) => {
          // 重启窗口期内 healthz 失败是预期行为，继续轮询；令牌失效例外，须回到输入框。
          if (cause instanceof ApiError && cause.status === 401) onAuthExpired();
        });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase, loadConfig, onStatusChange, onAuthExpired]);

  /**
   * 保存序列：先重建模型目录并写入 selectedModels（模型选择走专用端点，目录文件与
   * 配置必须一起变更），再写其余配置（可能触发网关重启，由轮询恢复），最后按用户在
   * 弹窗里的选择决定是否停止 Codex app-server（Codex 重新拉起后加载新目录）。
   */
  const save = (restartCodex = false): void => {
    if (!config || !form || !logSize || invalidRequestLogCount) return;
    const formSnapshot = form;
    setPhase("saving");
    setSaveError(null);
    setCodexNotice(null);
    const run = async (): Promise<"restarting" | "done"> => {
      if (!sameSelection(formSnapshot.selectedModels, config.editable.selectedModels)) {
        const result = await applyUpstreamModels(formSnapshot.selectedModels);
        setCodexNotice({
          kind: result.upstreamOnly ? "warn" : "ok",
          text: result.upstreamOnly ? t("modelsSavedUpstreamOnly") : t("modelsSavedDynamic"),
        });
        if (restartCodex) {
          setCodexNotice({ kind: "warn", text: t("codexRestarting") });
          const stop = await restartCodexAppServers();
          setCodexNotice({
            kind: stop.results.some(({ status }) => status !== "stopped") ? "error" : "ok",
            text: stop.results.length === 0
              ? t("codexRestartNone")
              : stop.results.every(({ status }) => status === "stopped")
              ? t("codexRestartDone")
              : t("codexRestartFailed"),
          });
        }
      }
      const changes: UiConfigChanges = {};
      if (formSnapshot.zcode !== config.editable.zcode) changes.zcode = formSnapshot.zcode;
      if (formSnapshot.codebuddy !== config.editable.codebuddy) changes.codebuddy = formSnapshot.codebuddy;
      if (formSnapshot.qoder !== config.editable.qoder) changes.qoder = formSnapshot.qoder;
      if (formSnapshot.agy !== config.editable.agy) changes.agy = formSnapshot.agy;
      if (formSnapshot.opencodeZen !== (config.editable.opencodeZen === true)) {
        changes.opencodeZen = formSnapshot.opencodeZen;
      }
      if (formSnapshot.requestLogging !== config.editable.requestLogging) {
        changes.requestLogging = formSnapshot.requestLogging;
      }
      if (formSnapshot.maxRequestLogs !== String(config.editable.maxRequestLogs ?? 0)) {
        changes.maxRequestLogs = formSnapshot.maxRequestLogs.trim();
      }
      if (logSize.bytes !== (config.editable.maxGatewayLogBytes ?? 0)) {
        changes.maxGatewayLogBytes = logSize.payload;
      }
      if (excludedEntriesChanged(formSnapshot.excludedEntries, config.editable.excludedGroups, config.editable.excludedEntries)) {
        // 整体提交所有分组（含当前未渲染的端，保证隐藏组的存量条目不丢）；前缀由服务端补全。
        const groups: Record<string, string[]> = {};
        for (const group of config.editable.excludedGroups) {
          groups[group.key] = splitExcludedLines(formSnapshot.excludedEntries[group.key] ?? "");
        }
        changes.excludedModelGroups = groups;
      }
      if (Object.keys(changes).length === 0) return "done";
      const result = await postUiConfig(changes);
      return result.restarting ? "restarting" : "done";
    };
    void run().then((outcome) => {
      if (outcome === "restarting") setPhase("restarting");
      else {
        setPhase("idle");
        loadConfig();
      }
    }).catch((cause: unknown) => {
      if (cause instanceof ApiError && cause.status === 401) {
        onAuthExpired();
        return;
      }
      setSaveError(cause instanceof Error ? cause.message : String(cause));
      setPhase("failed");
    });
  };

  const restartBanner = phase === "restarting" || phase === "saving";

  return (
    <div className="page">
      <Header status={status}>
        <button
          className={`btn btn-save${dirty && phase === "idle" ? " dirty" : ""}`}
          disabled={!dirty || invalidLogSize || invalidRequestLogCount || (phase !== "idle" && phase !== "failed")}
          onClick={() => setPhase("confirm")}
        >
          <span>{phase === "saving" ? t("saving") : t("saveBtn")}</span>
        </button>
      </Header>
      {restartBanner && (
        <div className="restart-banner">
          <span className="status-dot" />
          {phase === "saving" ? t("saving") : t("savedRestarting")}
        </div>
      )}
      {codexNotice && (
        <div className={`restart-banner${codexNotice.kind === "error" ? " error" : ""}`}>
          <span className="status-dot" />
          {codexNotice.text}
        </div>
      )}
      {phase === "failed" && saveError && (
        <div className="restart-banner error">
          {t("saveFailed")}: {saveError}
        </div>
      )}
      {loadError && (
        <div className="restart-banner error">
          <span>{t("loadFailed")}: {loadError}</span>
          <button
            className="btn btn-secondary"
            style={{ padding: "4px 10px", fontSize: 11 }}
            onClick={loadConfig}
          >
            {t("retry")}
          </button>
        </div>
      )}
      <main className="content-container">
        <section className="card">
          <div className="card-header">
            <div className="card-title-group">
              <h2 className="card-title">{t("card1Title")}</h2>
              <span className="card-badge badge-editable">{t("badgeEditable")}</span>
            </div>
          </div>
          <div className="card-body">
            {config && form && (
              <>
                <div className="field-row">
                  <div className="field-label-group">
                    <span className="field-label">{t("labelReqLogging")}</span>
                    <span className="field-keyname">requestLogging</span>
                  </div>
                  <div className="field-control-area">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={form.requestLogging}
                        onChange={(event) =>
                          setForm({ ...form, requestLogging: event.target.checked })}
                      />
                      <span className="slider" />
                    </label>
                    <p className="field-desc">{t("descReqLogging")}</p>
                    {form.requestLogging && (
                      <div className="log-dir-line">
                        <code>{config.editable.logDir}</code>
                        <span className="field-desc">{t("pathNote")}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-label-group">
                    <span className="field-label">{t("labelMaxReqLogs")}</span>
                    <span className="field-keyname">maxRequestLogs</span>
                  </div>
                  <div className="field-control-area">
                    <input
                      type="number"
                      className="input-number"
                      min={0}
                      max={1000}
                      step={10}
                      required
                      aria-label={t("labelMaxReqLogs")}
                      aria-invalid={invalidRequestLogCount}
                      aria-describedby={invalidRequestLogCount ? "request-log-count-error" : undefined}
                      value={form.maxRequestLogs}
                      onChange={(event) => setForm({ ...form, maxRequestLogs: event.target.value })}
                    />
                    <p className="field-desc">{t("descMaxReqLogs")}</p>
                    {invalidRequestLogCount && <p id="request-log-count-error" className="field-desc error-text" role="alert">{t("requestLogCountInvalid")}</p>}
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-label-group">
                    <span className="field-label">{t("labelMaxGwBytes")}</span>
                    <span className="field-keyname">maxGatewayLogBytes</span>
                  </div>
                  <div className="field-control-area">
                    <div className="log-size-control">
                      <input
                        type="number"
                        className="input-number"
                        min={0}
                        max={1024}
                        step="any"
                        required
                        aria-label={t("labelMaxGwBytes")}
                        aria-invalid={invalidLogSize}
                        aria-describedby={invalidLogSize ? "log-size-error" : undefined}
                        value={form.maxGatewayLogBytes}
                        onChange={(event) => setForm({ ...form, maxGatewayLogBytes: event.target.value })}
                      />
                      <select
                        className="input-text"
                        aria-label={t("logSizeUnit")}
                        value={form.maxGatewayLogUnit}
                        onChange={(event) => setForm({ ...form, maxGatewayLogUnit: event.target.value as LogSizeUnit })}
                      >
                        {LOG_SIZE_UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                      </select>
                    </div>
                    <p className="field-desc">{t("descMaxGwBytes")}</p>
                    {invalidLogSize && <p id="log-size-error" className="field-desc error-text" role="alert">{t("logSizeInvalid")}</p>}
                  </div>
                </div>
                <div className="field-row">
                  <div className="field-label-group">
                    <span className="field-label">{t("labelModelSelect")}</span>
                    <span className="field-keyname">selectedModels</span>
                  </div>
                  <div className="field-control-area">
                    <ModelPicker
                      selectedModels={form.selectedModels}
                      onChange={(selectedModels) => setForm((current) =>
                        current ? { ...current, selectedModels } : current)}
                      onAuthExpired={onAuthExpired}
                      disabled={phase === "saving" || phase === "restarting" || phase === "confirm"}
                    />
                  </div>
                </div>
                {showZcode && (
                  <div className="field-row">
                    <div className="field-label-group">
                      <span className="field-label">{t("labelZcode")}</span>
                      <span className="field-keyname">zcode</span>
                    </div>
                    <div className="field-control-area">
                      {/* upstream-only 模式下网关按禁用处理 zcode 入口（zcodeEnabled）：
                          开关值保留但不生效，UI 同步禁用，避免误以为已生效。 */}
                      <label className={`switch${upstreamOnly ? " disabled" : ""}`}>
                        <input
                          type="checkbox"
                          checked={form.zcode}
                          disabled={upstreamOnly}
                          onChange={(event) => setForm({ ...form, zcode: event.target.checked })}
                        />
                        <span className="slider" />
                      </label>
                      <p className="field-desc">{t("descZcode")}</p>
                      {upstreamOnly && (
                        <p className="field-desc zcode-disabled-hint">{t("zcodeDisabledHint")}</p>
                      )}
                      {!config.detected.zcode && (
                        <p className="field-desc zcode-disabled-hint">{t("zcodeMissingHint")}</p>
                      )}
                      {renderExcludedGroups("zcode")}
                    </div>
                  </div>
                )}
                {showCodebuddy && (
                  <div className="field-row">
                    <div className="field-label-group">
                      <span className="field-label">{t("labelCodebuddy")}</span>
                      <span className="field-keyname">codebuddy</span>
                    </div>
                    <div className="field-control-area">
                      {/* upstream-only 模式下网关按禁用处理 codebuddy 入口（codebuddyEnabled）：
                          开关值保留但不生效，UI 同步禁用，避免误以为已生效。 */}
                      <div className="field-switch-row">
                        <label className={`switch${upstreamOnly ? " disabled" : ""}`}>
                          <input
                            type="checkbox"
                            checked={form.codebuddy}
                            disabled={upstreamOnly}
                            onChange={(event) => setForm({ ...form, codebuddy: event.target.checked })}
                          />
                          <span className="slider" />
                        </label>
                        {/* 账号选择只在 CLI（codebuddy --switch）：这里只读显示后端实时
                            解析的实际命中账号，无交互态、不进 changes、不写配置。 */}
                        <span className="account-readonly" aria-label={t("labelCodebuddyAccount")}>
                          {config.detected.codebuddyAccountLabel ?? t("codebuddyAccountNone")}
                        </span>
                      </div>
                      <p className="field-desc">{t("descCodebuddy")}</p>
                      <p className="field-desc">{t("descCodebuddyAccount")}</p>
                      {upstreamOnly && (
                        <p className="field-desc zcode-disabled-hint">{t("codebuddyDisabledHint")}</p>
                      )}
                      {!config.detected.codebuddy && (
                        <p className="field-desc zcode-disabled-hint">{t("codebuddyMissingHint")}</p>
                      )}
                      {renderExcludedGroups("codebuddy")}
                    </div>
                  </div>
                )}
                {showQoder && (
                  <div className="field-row">
                    <div className="field-label-group">
                      <span className="field-label">{t("labelQoder")}</span>
                      <span className="field-keyname">qoder</span>
                    </div>
                    <div className="field-control-area">
                      {/* 统一开关目前接入国际版；纯上游模式下保留配置值并禁用入口。 */}
                      <div className="field-switch-row">
                        <label className={`switch${upstreamOnly ? " disabled" : ""}`}>
                          <input
                            type="checkbox"
                            checked={form.qoder}
                            disabled={upstreamOnly}
                            onChange={(event) => setForm({ ...form, qoder: event.target.checked })}
                          />
                          <span className="slider" />
                        </label>
                        {/* 只展示当前实际生效的来源（CLI 优先、桌面回退），不允许修改。 */}
                        <div className="qoder-source-options" role="group" aria-label={t("labelQoderSources")}>
                          {qoderSources.map((label) => (
                            <label key={label} className="qoder-source-option">
                              <input
                                type="checkbox"
                                checked
                                readOnly
                                onClick={(event) => event.preventDefault()}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <p className="field-desc">{t("descQoder")}</p>
                      <p className="field-desc">{t("descQoderSources")}</p>
                      {upstreamOnly && (
                        <p className="field-desc zcode-disabled-hint">{t("qoderDisabledHint")}</p>
                      )}
                      {!config.detected.qoder && (
                        <p className="field-desc zcode-disabled-hint">{t("qoderMissingHint")}</p>
                      )}
                      {renderExcludedGroups("qoder")}
                    </div>
                  </div>
                )}
                {showAgy && (
                  <div className="field-row">
                    <div className="field-label-group">
                      <span className="field-label">{t("labelAgy")}</span>
                      <span className="field-keyname">agy</span>
                    </div>
                    <div className="field-control-area">
                      {/* upstream-only 模式下网关按禁用处理 agy 入口（agyEnabled）：
                          开关值保留但不生效，UI 同步禁用，避免误以为已生效。 */}
                      <label className={`switch${upstreamOnly ? " disabled" : ""}`}>
                        <input
                          type="checkbox"
                          checked={form.agy}
                          disabled={upstreamOnly}
                          onChange={(event) => setForm({ ...form, agy: event.target.checked })}
                        />
                        <span className="slider" />
                      </label>
                      <p className="field-desc">{t("descAgy")}</p>
                      {upstreamOnly && (
                        <p className="field-desc zcode-disabled-hint">{t("agyDisabledHint")}</p>
                      )}
                      {!config.detected.agy && (
                        <p className="field-desc zcode-disabled-hint">{t("agyMissingHint")}</p>
                      )}
                      {renderExcludedGroups("agy")}
                    </div>
                  </div>
                )}
                {/* OpenCode Zen 无本机凭据依赖（公共鉴权 Bearer public），开关无条件显示；
                    官方门禁策略调整导致 403 时靠错误信息指引，不在此做可用性探测。 */}
                <div className="field-row">
                  <div className="field-label-group">
                    <span className="field-label">{t("labelOpencodeZen")}</span>
                    <span className="field-keyname">opencodeZen</span>
                  </div>
                  <div className="field-control-area">
                    {/* upstream-only 模式下网关按禁用处理 zen 入口（zenEnabled）：
                        开关值保留但不生效，UI 同步禁用，避免误以为已生效。 */}
                    <label className={`switch${upstreamOnly ? " disabled" : ""}`}>
                      <input
                        type="checkbox"
                        checked={form.opencodeZen}
                        disabled={upstreamOnly}
                        onChange={(event) => setForm({ ...form, opencodeZen: event.target.checked })}
                      />
                      <span className="slider" />
                    </label>
                    <p className="field-desc">{t("descOpencodeZen")}</p>
                    <p className="field-desc">{t("descOpencodeZenAuth")}</p>
                      {upstreamOnly && (
                        <p className="field-desc zcode-disabled-hint">{t("opencodeZenDisabledHint")}</p>
                      )}
                  </div>
                </div>
                {/* 排除输入框常驻：端行因「未检测且未启用」隐藏时，该端的分组输入框
                    仍要保留——规则可以预先添加，端启用后即生效；不与任何目录/内容状态联动。 */}
                {(["zcode", "codebuddy", "qoder", "agy"] as const)
                  .filter((endpoint) => !(endpoint === "zcode" ? showZcode
                    : endpoint === "codebuddy" ? showCodebuddy
                    : endpoint === "qoder" ? showQoder
                    : showAgy))
                  .map((endpoint) => (
                    <div className="field-row" key={endpoint}>
                      <div className="field-label-group">
                        <span className="field-label">{t("labelExcludedModels")}</span>
                        <span className="field-keyname">{endpoint}</span>
                      </div>
                      <div className="field-control-area">
                        {renderExcludedGroups(endpoint)}
                      </div>
                    </div>
                  ))}
              </>
            )}
          </div>
        </section>

        {config && (
          <section className="card">
            <div className="card-header">
              <div className="card-title-group">
                <h2 className="card-title">{t("card2Title")}</h2>
                <span className="card-badge badge-readonly">{t("badgeReadonly")}</span>
              </div>
            </div>
            <div className="card-note-bar">
              <svg style={{ width: 14, height: 14, color: "#f59e0b", flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>{t("card2Note")}</span>
            </div>
            <div className="card-body">
              <ReadonlyRow label={t("labelCodexConfig")} keyname={t("keynameCodexConfig")}>
                <div className="readonly-box">
                  <span className={`pill-badge ${config.readonly.codexConfigManaged ? "pill-green" : "pill-amber"}`}>
                    {config.readonly.codexConfigManaged ? t("badgeCodexManaged") : t("badgeCodexManual")}
                  </span>
                  <span className="codex-config-desc">
                    {config.readonly.codexConfigManaged ? t("descCodexManaged") : t("descCodexManual")}
                  </span>
                </div>
              </ReadonlyRow>

              {config.readonly.manualCodexConfig && (
                <div className="manual-codex-block">
                  <div className="manual-codex-title">{t("manualConfigTitle")}</div>
                  <div className="manual-codex-keys">
                    {config.readonly.manualCodexConfig.keys.map((row) => (
                      <div key={row.key} className="manual-codex-key">
                        <code className="manual-codex-keyname">{row.key}</code>
                        <div className="manual-codex-expected">
                          <span>= {row.expected}</span>
                          <CopyButton text={`${row.key} = "${row.expected}"`} title={t("copyPath")} />
                        </div>
                        <span className={`pill-badge ${
                          row.matches ? "pill-green" : row.current === null ? "pill-red" : "pill-amber"
                        }`}>
                          {row.matches
                            ? `✓ ${t("manualKeyOk")}`
                            : row.current === null
                              ? `✗ ${t("manualKeyMissing")}`
                              : `⚠ ${t("manualKeyMismatch")}`}
                        </span>
                        {row.current !== null && !row.matches && (
                          <span className="manual-codex-current">
                            {t("manualKeyCurrent")}: <code>{row.current}</code>
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {config.readonly.manualCodexConfig.staticCatalogActive
                    && !config.readonly.manualCodexConfig.keys.some(
                      (row) => row.key === "model_catalog_json" && row.matches,
                    ) && (
                      <p className="field-desc zcode-disabled-hint">{t("manualStaticNote")}</p>
                  )}
                  {config.readonly.manualCodexConfig.removeModelCatalogJson && (
                    <p className="field-desc zcode-disabled-hint">{t("manualRemoveCatalogKey")}</p>
                  )}
                  <p className="field-desc manual-codex-footnote">{t("manualConfigFootnote")}</p>
                </div>
              )}
              <ReadonlyRow label={t("labelRouterMode")} keyname="routerMode">
                <div className="readonly-box">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`pill-badge ${upstreamOnly ? "pill-purple" : "pill-green"}`}>
                      {upstreamOnly ? t("badgePureUpstream") : t("badgeDynamicRouting")}
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>
                    {upstreamOnly ? t("descPureUpstream") : t("descUpstreamOnly")}
                  </span>
                </div>
              </ReadonlyRow>
              <ReadonlyRow label={t("labelUpstreamUrl")} keyname="upstreamBaseUrl">
                <div className="readonly-box">
                  <span>{config.readonly.upstreamBaseUrl}</span>
                  <CopyButton text={config.readonly.upstreamBaseUrl} title="Copy URL" />
                </div>
              </ReadonlyRow>
              <ReadonlyRow label={t("labelUpstreamType")} keyname="upstreamType">
                <div className="readonly-box">
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ color: "var(--fg-primary)", fontWeight: 600 }}>{config.readonly.upstreamType}</span>
                    <span className="pill-badge pill-cyan">active</span>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{t("hintOtherType")}</span>
                </div>
              </ReadonlyRow>
              <ReadonlyRow label={t("labelHostPort")} keyname="host / port">
                <div className="readonly-box">
                  <span>{config.readonly.host} : {config.readonly.port}</span>
                  <span className="pill-badge pill-purple">{t("badgeLoopback")}</span>
                </div>
              </ReadonlyRow>
              <ReadonlyRow label={t("labelPrefix")} keyname="prefix">
                <div className="readonly-box">
                  <code style={{ color: "var(--accent)", fontWeight: 600 }}>{config.readonly.prefix}</code>
                  <span style={{ fontSize: 11, color: "var(--fg-muted)" }}>{t("descPrefix")}</span>
                </div>
              </ReadonlyRow>
              <ReadonlyRow label={t("labelCatalogPath")} keyname="catalogPath">
                <div className="readonly-box">
                  <span style={{ fontSize: 11.5 }}>{config.readonly.catalogPath}</span>
                  <CopyButton text={config.readonly.catalogPath} title="Copy Path" />
                </div>
              </ReadonlyRow>
            </div>
          </section>
        )}
      </main>

      {phase === "confirm" && config && form && (
        <div className="modal-overlay active" onClick={() => setPhase("idle")}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-title">
              <svg style={{ width: 18, height: 18, color: "#f59e0b" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <span>{modelsDirty ? t("modalTitleModels") : t("modalTitle")}</span>
            </div>
            <p className="modal-body">
              {[
                modelsDirty
                  ? upstreamOnly ? t("modalBodyModelsUpstreamOnly") : t("modalBodyModelsDynamic")
                  : null,
                genericDirty ? t("modalBody") : null,
              ].filter(Boolean).join(" ") || t("modalBody")}
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setPhase("idle")}>{t("cancel")}</button>
              {modelsDirty && upstreamOnly && (
                <button className="btn btn-secondary" onClick={() => save(false)}>{t("modalSkipRestart")}</button>
              )}
              <button
                className="btn btn-save dirty"
                onClick={() => save(modelsDirty && upstreamOnly)}
              >
                {modelsDirty && upstreamOnly ? t("modalRestartCodex") : t("confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
