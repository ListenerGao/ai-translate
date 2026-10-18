// 常驻所有网页的 content script。没开启翻译时只挂消息监听、划词监听和英文文章检测，不发请求。
import type { TabCommand, TabStatus } from "../shared/messages.ts";
import { loadSettings } from "../shared/settings.ts";
import { AutoOpener } from "./auto.ts";
import { detectPage } from "./detect.ts";
import { SelectionTranslator } from "./selection.ts";
import { PageSession } from "./session.ts";

declare global {
  interface Window {
    __aitSession?: PageSession;
    __aitSelection?: SelectionTranslator;
    __aitAuto?: AutoOpener;
  }
}

// 重复注入（插件更新后补注入）时，新实例接管，旧实例停掉
window.__aitSession?.dispose();
const session = new PageSession();
window.__aitSession = session;

window.__aitSelection?.dispose();
const selection = new SelectionTranslator();
window.__aitSelection = selection;
void selection.init();

window.__aitAuto?.dispose();
const auto = new AutoOpener(session);
window.__aitAuto = auto;
auto.start();

chrome.runtime.onMessage.addListener((msg: TabCommand, _sender, sendResponse: (status: TabStatus) => void) => {
  if (window.__aitSession !== session) return false;
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
