import type { ReactNode } from "react";
import { navigate, useHashRoute } from "./hash-router.ts";
import { useI18n } from "./i18n.tsx";
import type { UiStatus } from "./api.ts";

/**
 * 常驻 Header：左侧品牌 + 端点状态，右侧「日志/返回」（hash 路由切换）、
 * 中英文切换、以及由页面注入的动作（配置页的保存按钮）。
 */
export function Header({ status, children }: { status: UiStatus; children?: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const route = useHashRoute();
  const onLogs = route === "/logs";
  return (
    <header className="app-header">
      <div className="header-left">
        <div className="brand-title">
          <span>codex-cliproxy</span>
          <span className="brand-badge">{t("brandBadge")}</span>
        </div>
        <div className="status-pill">
          <span className="status-dot" />
          <span className="status-endpoint">{status.host}:{status.port}</span>
          <span className="local-badge">{t("localBadge")}</span>
        </div>
      </div>
      <div className="header-right">
        <button
          className="btn btn-secondary"
          onClick={() => navigate(onLogs ? "/" : "/logs")}
        >
          <svg style={{ width: 14, height: 14 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {onLogs
              ? <polyline points="15 18 9 12 15 6" />
              : <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />}
            {!onLogs && <polyline points="14 2 14 8 20 8" />}
            {!onLogs && <line x1="16" y1="13" x2="8" y2="13" />}
            {!onLogs && <line x1="16" y1="17" x2="8" y2="17" />}
          </svg>
          <span>{onLogs ? t("backToConfig") : t("logsBtn")}</span>
        </button>
        <div className="lang-segmented">
          <button
            className={`lang-btn${lang === "zh" ? " active" : ""}`}
            onClick={() => setLang("zh")}
          >中</button>
          <button
            className={`lang-btn${lang === "en" ? " active" : ""}`}
            onClick={() => setLang("en")}
          >EN</button>
        </div>
        {children}
      </div>
    </header>
  );
}
