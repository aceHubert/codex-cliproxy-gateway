import { useCallback } from "react";
import { createInstance, type TFunction } from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import zhCommon from "./locales/zh/common.ts";
import zhConfig from "./locales/zh/config.ts";
import zhLogs from "./locales/zh/logs.ts";
import zhModels from "./locales/zh/models.ts";
import enCommon from "./locales/en/common.ts";
import enConfig from "./locales/en/config.ts";
import enLogs from "./locales/en/logs.ts";
import enModels from "./locales/en/models.ts";

export type Lang = "zh" | "en";

/** 命名空间 = 页面归属：common=Header/App/TextView、config=ConfigPage、logs=LogsPage、models=ModelPicker。 */
export const UI_NAMESPACES = ["common", "config", "logs", "models"] as const;

export type UiTFunction = TFunction<typeof UI_NAMESPACES>;

const LANG_STORAGE_KEY = "ccp-ui-lang";

function normalizeLang(value: string | null | undefined): Lang {
  return value === "en" ? "en" : "zh";
}

function initialLang(): Lang {
  try {
    return normalizeLang(window.localStorage.getItem(LANG_STORAGE_KEY));
  } catch {
    // localStorage 被禁用时回退默认语言，不影响会话内切换。
    return "zh";
  }
}

/**
 * i18next 实例：资源全量内联打包（无后端加载、无 Suspense），插值由 React
 * 转义（escapeValue: false），语言持久化沿用 localStorage 键 ccp-ui-lang。
 */
export const i18n = createInstance();

void i18n.use(initReactI18next).init({
  resources: {
    zh: { common: zhCommon, config: zhConfig, logs: zhLogs, models: zhModels },
    en: { common: enCommon, config: enConfig, logs: enLogs, models: enModels },
  },
  lng: initialLang(),
  fallbackLng: "zh",
  ns: UI_NAMESPACES,
  defaultNS: "common",
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

// 初始语言同步写 <html lang>（init 回调是异步的，不等 languageChanged 事件）。
// node:test（如 test/model-picker.test.ts 经 ModelPicker 传递引入本模块）无 DOM，跳过。
function syncHtmlLang(lang: Lang): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
}

syncHtmlLang(normalizeLang(i18n.language));

// 后续切换（用户操作或 changeLanguage）同步 <html lang> 与持久化。
i18n.on("languageChanged", (lng) => {
  const lang = normalizeLang(lng);
  syncHtmlLang(lang);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // 持久化失败只影响下次启动的默认语言。
  }
});

/**
 * useI18n 薄适配层：t 直接转发 react-i18next 的类型化 TFunction（键名与插值
 * 变量名由 i18next.d.ts 的资源类型推导检查），lang/setLang 同步实例语言。
 */
export function useI18n(): { lang: Lang; setLang: (lang: Lang) => void; t: UiTFunction } {
  const { t } = useTranslation(UI_NAMESPACES);
  const lang = normalizeLang(i18n.language);
  const setLang = useCallback((next: Lang) => {
    void i18n.changeLanguage(next);
  }, []);
  return { t, lang, setLang };
}
