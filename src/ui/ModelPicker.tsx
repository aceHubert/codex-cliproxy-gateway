import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, fetchUpstreamModels, type UpstreamModel } from "./api.ts";
import { useI18n } from "./i18n.tsx";

interface ModelPickerProps {
  selectedModels: string[];
  onChange: (models: string[]) => void;
  onAuthExpired: () => void;
  disabled?: boolean;
}

type FetchPhase = "idle" | "loading" | "failed";

function uniqueModelIds(models: string[]): string[] {
  return [...new Set(models)];
}

function normalizeModels(models: UpstreamModel[]): UpstreamModel[] {
  const seen = new Set<string>();
  const normalized: UpstreamModel[] = [];
  for (const model of models) {
    const slug = model.slug.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    normalized.push({ ...model, slug });
  }
  return normalized;
}

export function ModelPicker({
  selectedModels,
  onChange,
  onAuthExpired,
  disabled = false,
}: ModelPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [availableModels, setAvailableModels] = useState<UpstreamModel[] | null>(null);
  const [pendingModels, setPendingModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [fetchPhase, setFetchPhase] = useState<FetchPhase>("idle");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const selected = useMemo(() => uniqueModelIds(selectedModels), [selectedModels]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const pendingSet = useMemo(() => new Set(pendingModels), [pendingModels]);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const filteredModels = useMemo(() => {
    if (!availableModels) return [];
    if (!normalizedFilter) return availableModels;
    return availableModels.filter((model) =>
      model.slug.toLocaleLowerCase().includes(normalizedFilter)
      || model.displayName.toLocaleLowerCase().includes(normalizedFilter));
  }, [availableModels, normalizedFilter]);
  const selectableFiltered = useMemo(
    () => filteredModels.filter((model) => !selectedSet.has(model.slug)),
    [filteredModels, selectedSet],
  );
  const selectedFilteredCount = selectableFiltered.reduce(
    (count, model) => count + (pendingSet.has(model.slug) ? 1 : 0),
    0,
  );
  const allFilteredSelected = selectableFiltered.length > 0
    && selectedFilteredCount === selectableFiltered.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedFilteredCount > 0 && !allFilteredSelected;
    }
  }, [allFilteredSelected, selectedFilteredCount]);

  useEffect(() => () => {
    requestSequence.current += 1;
  }, []);

  useEffect(() => {
    setPendingModels((current) => current.filter((slug) => !selectedSet.has(slug)));
  }, [selectedSet]);

  const loadModels = useCallback(() => {
    const requestId = requestSequence.current + 1;
    requestSequence.current = requestId;
    setFetchPhase("loading");
    setFetchError(null);
    void fetchUpstreamModels().then((result) => {
      if (requestSequence.current !== requestId) return;
      const nextModels = normalizeModels(result.models);
      const nextSlugs = new Set(nextModels.map((model) => model.slug));
      setAvailableModels(nextModels);
      setPendingModels((current) => current.filter((slug) =>
        nextSlugs.has(slug) && !selectedSet.has(slug)));
      setFetchPhase("idle");
    }).catch((cause: unknown) => {
      if (requestSequence.current !== requestId) return;
      if (cause instanceof ApiError && cause.status === 401) {
        setFetchPhase("idle");
        onAuthExpired();
        return;
      }
      setFetchError(cause instanceof Error ? cause.message : String(cause));
      setFetchPhase("failed");
    });
  }, [onAuthExpired, selectedSet]);

  const openPanel = () => {
    if (disabled) return;
    setOpen(true);
    setFilter("");
    setPendingModels([]);
    setAvailableModels(null);
    loadModels();
  };

  const closePanel = () => {
    requestSequence.current += 1;
    setOpen(false);
    setPendingModels([]);
    setFilter("");
    setFetchPhase("idle");
    setFetchError(null);
  };

  const togglePending = (slug: string) => {
    if (disabled || fetchPhase === "loading" || selectedSet.has(slug)) return;
    setPendingModels((current) => current.includes(slug)
      ? current.filter((model) => model !== slug)
      : [...current, slug]);
  };

  const toggleAllFiltered = () => {
    if (disabled || fetchPhase === "loading" || selectableFiltered.length === 0) return;
    const filteredSlugs = new Set(selectableFiltered.map((model) => model.slug));
    setPendingModels((current) => {
      if (allFilteredSelected) return current.filter((slug) => !filteredSlugs.has(slug));
      return uniqueModelIds([...current, ...filteredSlugs]);
    });
  };

  const applyPending = () => {
    if (disabled || fetchPhase === "loading" || pendingModels.length === 0) return;
    onChange(uniqueModelIds([...selected, ...pendingModels]));
    closePanel();
  };

  const removeSelected = (slug: string) => {
    if (disabled || fetchPhase === "loading") return;
    onChange(selected.filter((model) => model !== slug));
  };

  const emptyText = availableModels?.length === 0
    ? t("modelsNoUpstream")
    : t("modelsNoResults");
  const loading = fetchPhase === "loading";

  return (
    <div className={`model-picker${disabled ? " disabled" : ""}`}>
      <div className="model-picker-heading">
        <div>
          <div className="model-picker-title-row">
            <span className="model-picker-title">{t("modelsSelectedTitle")}</span>
            <span className="model-picker-count">{selected.length} {t("modelsCount")}</span>
          </div>
          <p className="field-desc">{t("descModelSelect")}</p>
        </div>
        <button
          type="button"
          className="btn model-fetch-btn"
          disabled={disabled || open}
          onClick={openPanel}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 21h14" />
          </svg>
          {loading && open ? t("fetchingModels") : t("fetchModels")}
        </button>
      </div>

      {open && (
        <div className="model-fetch-panel">
          <div className="model-fetch-panel-head">
            <div>
              <div className="model-picker-title">{t("fetchModels")}</div>
              <p className="field-desc">{t("modelsFetchHint")}</p>
            </div>
            <button
              type="button"
              className="model-panel-close"
              disabled={disabled}
              onClick={closePanel}
              aria-label={t("modelsClose")}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m6 6 12 12" />
                <path d="m18 6-12 12" />
              </svg>
            </button>
          </div>

          <div className="model-fetch-toolbar">
            <label className="model-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>
              <input
                type="search"
                value={filter}
                disabled={disabled || loading}
                placeholder={t("modelsFilterPlaceholder")}
                onChange={(event) => setFilter(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-secondary model-reload-btn"
              disabled={disabled || loading}
              onClick={loadModels}
            >
              <svg className={loading ? "spinning" : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M20 11a8 8 0 1 0-2.3 5.7" />
                <path d="M20 4v7h-7" />
              </svg>
              {loading ? t("fetchingModels") : t("modelsReload")}
            </button>
          </div>

          <div className="model-select-summary">
            <label className={`model-select-all${selectableFiltered.length === 0 ? " disabled" : ""}`}>
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allFilteredSelected}
                disabled={disabled || loading || selectableFiltered.length === 0}
                onChange={toggleAllFiltered}
              />
              <span>{t("modelsSelectAll")}</span>
            </label>
            <span>{selectedFilteredCount} / {selectableFiltered.length}</span>
          </div>

          {fetchError && (
            <div className="model-fetch-error" role="alert">
              <span>{t("modelsFetchFailed")}: {fetchError}</span>
              <button type="button" className="btn btn-secondary" disabled={disabled || loading} onClick={loadModels}>
                {t("modelsReload")}
              </button>
            </div>
          )}

          <div className={`upstream-model-list${loading && !availableModels ? " loading" : ""}`}>
            {loading && !availableModels && <div className="models-empty">{t("fetchingModels")}</div>}
            {!loading && availableModels && filteredModels.length === 0 && (
              <div className="models-empty">{emptyText}</div>
            )}
            {filteredModels.map((model) => {
              const added = selectedSet.has(model.slug);
              return (
                <label className={`upstream-model-row${added ? " added" : ""}`} key={model.slug}>
                  <input
                    type="checkbox"
                    checked={added || pendingSet.has(model.slug)}
                    disabled={disabled || loading || added}
                    onChange={() => togglePending(model.slug)}
                  />
                  <span className="upstream-model-copy">
                    <code>{model.slug}</code>
                    {model.displayName && model.displayName !== model.slug && <span>{model.displayName}</span>}
                  </span>
                  {added && <span className="model-added-badge">{t("modelsAdded")}</span>}
                </label>
              );
            })}
          </div>

          <div className="model-fetch-actions">
            <span className="model-pending-count">{pendingModels.length} {t("modelsPending")}</span>
            <button type="button" className="btn btn-secondary" disabled={disabled} onClick={closePanel}>
              {t("modelsClose")}
            </button>
            <button
              type="button"
              className={`btn model-apply-btn${pendingModels.length > 0 ? " active" : ""}`}
              disabled={disabled || loading || pendingModels.length === 0}
              onClick={applyPending}
            >
              {t("modelsApply")} ({pendingModels.length})
            </button>
          </div>
        </div>
      )}
      <div className="selected-models-list">
        {selected.map((slug) => (
          <div className="selected-model-row" key={slug}>
            <code>{slug}</code>
            <button
              type="button"
              className="model-remove-btn"
              disabled={disabled || loading}
              aria-label={`${t("modelsRemove")}: ${slug}`}
              title={t("modelsRemove")}
              onClick={() => removeSelected(slug)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m6 6 12 12" />
                <path d="m18 6-12 12" />
              </svg>
            </button>
          </div>
        ))}
        {selected.length === 0 && <div className="models-empty">{t("modelsNone")}</div>}
      </div>
    </div>
  );
}
