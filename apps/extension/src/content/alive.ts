/**
 * 插件是否还在。插件重新加载、更新或停用后，留在网页里的旧 content script 还会跑，
 * 但 chrome.runtime.id 变成 undefined，读设置、检测语言、连后台都会报「Extension context invalidated」。
 * 各模块在定时器、事件入口先查一下，失效了就把自己停掉。
 */
export function extensionAlive(): boolean {
  return chrome.runtime?.id !== undefined;
}
