import type zhCommon from "./locales/zh/common.ts";
import type zhConfig from "./locales/zh/config.ts";
import type zhLogs from "./locales/zh/logs.ts";
import type zhModels from "./locales/zh/models.ts";

/**
 * i18next 资源类型扩充：键名（含 ns: 前缀）与插值变量由 zh 词典推导，
 * 组件里 t("…") 的键名受 tsc 检查（en 侧缺键由 test/ui-i18n.test.ts 兜底）。
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: {
      common: typeof zhCommon;
      config: typeof zhConfig;
      logs: typeof zhLogs;
      models: typeof zhModels;
    };
  }
}
