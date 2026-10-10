import { test } from "node:test";
import assert from "node:assert/strict";
import { createInstance, type i18n as I18nInstance } from "i18next";
import zhCommon from "../src/ui/i18n/locales/zh/common.ts";
import zhConfig from "../src/ui/i18n/locales/zh/config.ts";
import zhLogs from "../src/ui/i18n/locales/zh/logs.ts";
import zhModels from "../src/ui/i18n/locales/zh/models.ts";
import enCommon from "../src/ui/i18n/locales/en/common.ts";
import enConfig from "../src/ui/i18n/locales/en/config.ts";
import enLogs from "../src/ui/i18n/locales/en/logs.ts";
import enModels from "../src/ui/i18n/locales/en/models.ts";

type Lang = "zh" | "en";
type LooseT = (key: string, options?: Record<string, string | number>) => string;

const LOCALES: Record<Lang, Record<string, Record<string, string>>> = {
  zh: { common: zhCommon, config: zhConfig, logs: zhLogs, models: zhModels },
  en: { common: enCommon, config: enConfig, logs: enLogs, models: enModels },
};

const NAMESPACES = ["common", "config", "logs", "models"] as const;

/** i18next 复数后缀（_one/_other/…）归一为同一逻辑键再比较。 */
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const logicalKey = (key: string): string => key.replace(PLURAL_SUFFIX, "");

/** 构造与 src/ui/i18n/index.ts 同构的纯数据实例（不引 react、不触 DOM）。 */
async function createUiI18n(lang: Lang): Promise<I18nInstance> {
  const instance = createInstance();
  await instance.init({
    resources: LOCALES,
    lng: lang,
    fallbackLng: "zh",
    ns: NAMESPACES,
    defaultNS: "common",
    interpolation: { escapeValue: false },
  });
  // 词条枚举用计算键调用：绕开 CustomTypeOptions 对字面量键的编译期约束。
  return instance;
}

test("zh and en key sets match per namespace", () => {
  // 复数键归一去重后再比较（en 的 pagerStatus_one/_other ⇔ zh 的 pagerStatus）。
  const logicalKeySet = (dict: Record<string, string>): string[] =>
    [...new Set(Object.keys(dict).map(logicalKey))].sort();
  for (const ns of NAMESPACES) {
    const zhKeys = logicalKeySet(LOCALES.zh[ns]);
    const enKeys = logicalKeySet(LOCALES.en[ns]);
    assert.deepEqual(
      enKeys,
      zhKeys,
      `namespace "${ns}" 键集合不一致（i18next 缺键会静默回退，须双侧同步）：zh=${zhKeys.join(",")} en=${enKeys.join(",")}`,
    );
  }
});

test("every key resolves in both languages without fallback masking", async () => {
  for (const lang of ["zh", "en"] as const) {
    const instance = await createUiI18n(lang);
    const t = instance.t as unknown as LooseT;
    for (const ns of NAMESPACES) {
      for (const dictKey of Object.keys(LOCALES[lang][ns])) {
        const key = `${ns}:${logicalKey(dictKey)}`;
        const options = PLURAL_SUFFIX.test(dictKey) ? { count: 1 } : undefined;
        const resolved = t(key, options);
        assert.notEqual(
          resolved,
          key,
          `${lang} 词典键 ${dictKey} 解析失败（返回键名说明词条缺失或语言资源未注册）`,
        );
        assert.ok(resolved.trim() !== "", `${lang}/${ns}/${dictKey} 解析为空串`);
      }
    }
  }
});

test("interpolated entries render correctly in both languages", async () => {
  const zh = await createUiI18n("zh");
  const en = await createUiI18n("en");

  assert.equal(
    zh.t("config:excludedGroupPlaceholder", { example: "gpt-*" }),
    "每行一个模型名，如 gpt-*",
  );
  assert.equal(
    en.t("config:excludedGroupPlaceholder", { example: "gpt-*" }),
    "One model name per line, e.g. gpt-*",
  );

  assert.equal(
    zh.t("logs:pagerStatus", { page: 2, pages: 5, count: 3 }),
    "第 2/5 页 · 共 3 条",
  );
  assert.equal(
    en.t("logs:pagerStatus", { page: 2, pages: 5, count: 3 }),
    "Page 2/5 · 3 files",
  );
  // 复数瑕疵回归：英文单数不得复用复数文案（原 "1 files"）。
  assert.equal(
    en.t("logs:pagerStatus", { page: 1, pages: 1, count: 1 }),
    "Page 1/1 · 1 file",
  );
  assert.equal(
    zh.t("logs:pagerStatus", { page: 1, pages: 1, count: 1 }),
    "第 1/1 页 · 共 1 条",
  );
});

test("dictionary has no bilingual mixed entries", () => {
  // 混写形态：中文与英文短语以 " / " 并排（如「保存 / Save」）。
  // 「监听地址 / 端口」这类同语言内的分隔符不受影响。
  const MIXED_PATTERN = /[\u4e00-\u9fff]\s+\/\s+[A-Za-z]|[A-Za-z]\s+\/\s+[\u4e00-\u9fff]/;
  for (const lang of ["zh", "en"] as const) {
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(LOCALES[lang][ns])) {
        assert.ok(
          !MIXED_PATTERN.test(value),
          `${lang}/${ns}/${key} 疑似双语混写词条：${value}`,
        );
      }
    }
  }
});
