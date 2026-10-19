// 常驻所有网页的 content script。没开启翻译时只挂消息监听、划词监听和英文文章检测，不发请求。
import type { TabCommand, TabStatus } from "../shared/messages.ts";
import { loadSettings } from "../shared/settings.ts";
import { extensionAlive } from "./alive.ts";
import { AutoOpener } from "./auto.ts";
import { detectPage } from "./detect.ts";
import { SelectionTranslator } from "./selection.ts";
import { PageSession } from "./session.ts";

declare global {
  interface Window {
    __aitRetire?: () => void;
  }
}

const RETIRE_EVENT = "ait-retire";

// 新脚本接管前先让旧脚本停掉，免得旧脚本稍后清理时把新脚本的样式、提示条一起删了：
// - 同一个 JS 环境里重复注入：直接调用旧实例留下的 __aitRetire
// - 插件重新加载后补注入：新旧脚本不在同一个 JS 环境，只能用 DOM 事件通知；只有已失效的旧脚本才响应，网页自己发这个事件没用
window.__aitRetire?.();
document.dispatchEvent(new Event(RETIRE_EVENT));

const session = new PageSession();
const selection = new SelectionTranslator();
const auto = new AutoOpener(session);
let retired = false;

// 插件重新加载、更新或停用后，这份脚本还留在网页里，但 chrome.* 已失效（见 alive.ts）。
// 每秒查一次，失效就全部停掉：还原页面、撤掉监听和定时器，不再报错
const watchdog = window.setInterval(() => {
  if (!extensionAlive()) retire();
}, 1000);

const onRetireEvent = (): void => {
  if (!extensionAlive()) retire();
};

function retire(): void {
  if (retired) return;
  retired = true;
  clearInterval(watchdog);
  document.removeEventListener(RETIRE_EVENT, onRetireEvent);
  auto.dispose();
  selection.dispose();
  session.dispose();
}

document.addEventListener(RETIRE_EVENT, onRetireEvent);
window.__aitRetire = retire;
void selection.init();
auto.start();

chrome.runtime.onMessage.addListener((msg: TabCommand, _sender, sendResponse: (status: TabStatus) => void) => {
  if (retired) return false;
  if (msg.type === "status") {
    sendResponse({ active: session.active });
    return false;
  }
  if (msg.type === "detect") {
    void loadSettings()
      .then((s) => detectPage(s.target))
      .then(sendResponse as (d: unknown) => void);
    return true;
  }
  if (msg.type === "toggle") {
    const done = session.active ? Promise.resolve(session.stop()) : session.start();
    void done.then(() => sendResponse({ active: session.active }));
    return true;
  }
  return false;
});
