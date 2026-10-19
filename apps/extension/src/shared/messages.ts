import type { TranslateErrorCode } from "@ai-translate/core";

/** content script 连接后台用的长连接名 */
export const PAGE_PORT = "ait-page";

export interface QueueItem {
  /** 段落 id，在一个标签页内唯一 */
  id: string;
  text: string;
  /** 段内有链接、加粗等格式时的带标记原文 */
  markup?: string;
  /** 离视口的距离，越小越先翻 */
  priority: number;
}

export type PageToBackground =
  | { type: "enqueue"; items: QueueItem[] }
  | { type: "cancel"; ids: string[] }
  | { type: "priority"; updates: { id: string; priority: number }[] };

export type BackgroundToPage =
  | { type: "result"; id: string; text: string; cached: boolean }
  | { type: "error"; id: string; code: TranslateErrorCode; message: string };

/**
 * 网页端、弹窗发给后台的一次性消息：打开设置页（content script 不能直接打开）、翻译选中的文字（划词）、
 * 报告页面翻译状态（自动开启后更新图标角标）、切换标签页翻译（弹窗）
 */
export type RuntimeMessage =
  | { type: "open-options" }
  /** target：划词气泡里临时选的目标语言，不传就用设置里的 */
  | { type: "translate-selection"; text: string; target?: string }
  | { type: "page-state"; active: boolean }
  /** 工具栏弹窗：切换指定标签页的翻译，回复 TabStatus（页面不能翻译时为 null） */
  | { type: "toggle-tab"; tabId: number };

export type SelectionResult = { ok: true; text: string } | { ok: false; message: string };

/** 后台、弹窗发给标签页的一次性命令。detect：检测当前页面是不是英文文章，弹窗显示和自动开启都用它 */
export type TabCommand = { type: "toggle" } | { type: "status" } | { type: "detect" };

export interface TabStatus {
  active: boolean;
}
