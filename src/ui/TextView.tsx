import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n.tsx";

/**
 * 共享文本视图（text-view-wrap）：滚动容器 + 浮动查找框 + 组件级快捷键。
 * 网关日志终端与请求日志预览共用——查找行为、位置、快捷键完全一致，查找范围仅本组件的行。
 *
 * - 查找不筛选：所有行保持可见，命中以 <mark> 高亮（当前项实色），Enter/Shift+Enter
 *   与 ↑/↓ 按钮在命中间导航（回绕），并 scrollIntoView 到当前项。
 * - 焦点在文本内时 Cmd/Ctrl+F 由本组件处理（呼出查找框并全选输入）。
 * - Esc 关闭查找框、清除高亮并把焦点还给文本区（阻止冒泡，交由上层决定剩余行为）。
 * - open 受控（由 LogsPage 持有），关闭时自动清空查询。
 */
export interface TextViewProps {
  lines: string[];
  /** 滚动容器类名（terminal-view / preview-body）。 */
  className: string;
  /** 每行的附加类名（gateway 的 err/audit、preview 的 section 标题）。 */
  lineClass?: (line: string) => string | undefined;
  /** 空内容占位文案。 */
  emptyLabel?: string;
  /** lines 变化且无查询时保持贴底滚动（gateway 自动刷新用）。 */
  autoScrollBottom?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Segment {
  text: string;
  hit: boolean;
}

/** 按查询词（大小写不敏感）把一行拆成普通/命中片段；空查询整行原样返回。 */
function splitLine(line: string, lowerQuery: string): Segment[] {
  if (!lowerQuery) return [{ text: line, hit: false }];
  const lowerLine = line.toLowerCase();
  const segments: Segment[] = [];
  let pos = 0;
  let found = lowerLine.indexOf(lowerQuery);
  while (found >= 0) {
    if (found > pos) segments.push({ text: line.slice(pos, found), hit: false });
    segments.push({ text: line.slice(found, found + lowerQuery.length), hit: true });
    pos = found + lowerQuery.length;
    found = lowerLine.indexOf(lowerQuery, pos);
  }
  if (pos < line.length) segments.push({ text: line.slice(pos), hit: false });
  return segments;
}

const FIND_DEBOUNCE_MS = 200;

export function TextView({
  lines, className, lineClass, emptyLabel, autoScrollBottom, open, onOpenChange,
}: TextViewProps) {
  const { t } = useI18n();
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hitRefs = useRef<Array<HTMLElement | null>>([]);
  const wasOpenRef = useRef(false);

  const lowerQuery = query.trim().toLowerCase();

  // 输入防抖：停止键入 200ms 后才执行查找。
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(rawQuery), FIND_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [rawQuery]);

  const totalHits = useMemo(() => {
    if (!lowerQuery) return 0;
    return lines.reduce(
      (sum, line) => sum + splitLine(line, lowerQuery).filter((segment) => segment.hit).length,
      0,
    );
  }, [lines, lowerQuery]);

  // 查询或命中总数变化后回到第一个命中（内容刷新重扫同样如此），并裁剪 refs。
  useEffect(() => {
    hitRefs.current.length = totalHits;
    setActiveIndex(lowerQuery && totalHits > 0 ? 0 : -1);
  }, [lowerQuery, totalHits]);

  // 打开时聚焦全选；关闭时清空查询（高亮随行重渲染消失），焦点还给文本区。
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasOpenRef.current) {
      setRawQuery("");
      setQuery("");
      setActiveIndex(-1);
      scrollerRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  // 当前命中滚动进视野；无查询时按需保持贴底（gateway 自动刷新）。
  useEffect(() => {
    if (activeIndex >= 0) {
      hitRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    } else if (autoScrollBottom && scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, [activeIndex, lines, autoScrollBottom]);

  const step = (direction: 1 | -1): void => {
    if (totalHits === 0) return;
    setActiveIndex((index) => {
      if (index < 0) return direction === 1 ? 0 : totalHits - 1;
      return ((index + direction) % totalHits + totalHits) % totalHits;
    });
  };

  const close = (): void => {
    onOpenChange(false);
    scrollerRef.current?.focus();
  };

  // 行渲染：命中片段带全局编号，供当前项标记与滚动定位。
  let hitCounter = 0;
  const empty = lines.length === 0 || (lines.length === 1 && lines[0] === "");
  const renderedLines = empty && emptyLabel
    ? [<div key={0} className={lineClass?.("")}>{emptyLabel}</div>]
    : lines.map((line, lineIndex) => (
      <div key={lineIndex} className={lineClass?.(line)}>
        {splitLine(line, lowerQuery).map((segment, segmentIndex) => {
          if (!segment.hit) return <span key={segmentIndex}>{segment.text}</span>;
          // ref 回调在 commit 阶段执行，全局编号必须在渲染时固化为块级常量。
          const globalIndex = hitCounter++;
          return (
            <mark
              key={segmentIndex}
              ref={(element) => { hitRefs.current[globalIndex] = element; }}
              className={`log-hit${globalIndex === activeIndex ? " current" : ""}`}
            >{segment.text}</mark>
          );
        })}
      </div>
    ));

  return (
    <div
      className="text-view-wrap"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && (event.key === "f" || event.key === "F")) {
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(true);
        } else if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div ref={scrollerRef} className={className} tabIndex={-1}>
        {renderedLines}
      </div>
      {open && (
        <div className="find-bar find-bar-floating">
          <svg className="find-glass" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            className="find-input"
            placeholder={t("findPlaceholder")}
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
          />
          <span className="find-count">
            {!lowerQuery ? "" : totalHits > 0 ? `${activeIndex + 1}/${totalHits}` : "0"}
          </span>
          <button
            type="button"
            className="find-nav-btn"
            title={t("prevMatch")}
            onClick={() => step(-1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            type="button"
            className="find-nav-btn"
            title={t("nextMatch")}
            onClick={() => step(1)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button type="button" className="find-nav-btn" title={t("closeFind")} onClick={close}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
