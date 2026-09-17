import { useCallback, useEffect, useState } from "react";
import { captureTokenFromUrl, getUiStatus, setUiToken, ApiError, type UiStatus } from "./api.ts";
import { useHashRoute } from "./hash-router.ts";
import { LangProvider, useI18n } from "./i18n.tsx";
import { ConfigPage } from "./ConfigPage.tsx";
import { LogsPage } from "./LogsPage.tsx";

function TokenPrompt({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = (): void => {
    const token = value.trim();
    if (!token) return;
    setUiToken(token);
    onDone();
  };
  return (
    <div className="token-screen">
      <div className="card token-card">
        <h2 className="card-title">{t("tokenTitle")}</h2>
        <p className="field-desc">{t("tokenDesc")}</p>
        <input
          className="input-text"
          style={{ maxWidth: "100%" }}
          value={value}
          placeholder={t("tokenPlaceholder")}
          onChange={(event) => { setValue(event.target.value); setInvalid(false); }}
          onKeyDown={(event) => { if (event.key === "Enter") submit(); }}
        />
        {invalid && <p className="field-desc error-text">{t("tokenInvalid")}</p>}
        <button className="btn btn-save dirty" onClick={submit}>{t("tokenSubmit")}</button>
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="token-screen">
      <div className="card token-card">
        <h2 className="card-title">{t("loadFailed")}</h2>
        <p className="field-desc">{message}</p>
        <button className="btn btn-secondary" onClick={onRetry}>{t("retry")}</button>
      </div>
    </div>
  );
}

function BootSplash() {
  return (
    <div className="token-screen">
      <span className="status-dot" />
    </div>
  );
}

export function App() {
  useEffect(captureTokenFromUrl, []);
  const route = useHashRoute();
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [authFailed, setAuthFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback((): void => {
    setError(null);
    getUiStatus()
      .then((next) => {
        setStatus(next);
        setAuthFailed(false);
      })
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 401) setAuthFailed(true);
        else setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);
  useEffect(reload, [reload]);

  /** 会话中 ui-token 被轮换后，页面级 API 也会 401：统一回到 TokenPrompt 重新输入。 */
  const handleAuthExpired = useCallback((): void => {
    setAuthFailed(true);
  }, []);

  return (
    <LangProvider>
      {authFailed
        ? <TokenPrompt onDone={reload} />
        : error
          ? <ErrorScreen message={error} onRetry={reload} />
          : status
            ? (route === "/logs"
              ? <LogsPage status={status} onAuthExpired={handleAuthExpired} />
              : <ConfigPage status={status} onStatusChange={setStatus} onAuthExpired={handleAuthExpired} />)
            : <BootSplash />}
    </LangProvider>
  );
}
