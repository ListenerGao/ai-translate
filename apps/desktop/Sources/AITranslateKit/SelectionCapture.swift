// 取当前 App 里选中的文字：先用辅助功能接口直接读（不碰剪贴板）；读不到再模拟一次 ⌘C，从剪贴板取，取完把剪贴板原样写回。
// 两种方法都需要「辅助功能」授权。取到的文字只交给本机 aitd 翻译，不写日志、不存历史。
import AppKit
import ApplicationServices

/** 剪贴板快照：所有项目、所有格式的原始数据，写回时原样恢复（文字、图片、文件都行） */
public struct PasteboardSnapshot: Sendable, Equatable {
  struct Entry: Sendable, Equatable {
    let type: String
    let data: Data
  }

  let items: [[Entry]]

  public var isEmpty: Bool { items.isEmpty }

  public static func take(_ pasteboard: NSPasteboard) -> PasteboardSnapshot {
    let items = (pasteboard.pasteboardItems ?? []).map { item in
      item.types.compactMap { type in item.data(forType: type).map { Entry(type: type.rawValue, data: $0) } }
    }
    return PasteboardSnapshot(items: items.filter { !$0.isEmpty })
  }

  public func restore(to pasteboard: NSPasteboard) {
    pasteboard.clearContents()
    guard !items.isEmpty else { return }
    let restored = items.map { entries in
      let item = NSPasteboardItem()
      for e in entries { item.setData(e.data, forType: NSPasteboard.PasteboardType(e.type)) }
      return item
    }
    pasteboard.writeObjects(restored)
  }
}

public enum SelectionCapture {
  /** 选中的文字最多 5000 字，更长的提示改用翻译窗口 */
  public static let maxCharacters = 5000

  public enum Result: Equatable, Sendable {
    /** 取到了，去掉首尾空白 */
    case text(String)
    /** 超过 5000 字：带上文字，交给翻译窗口 */
    case tooLong(String)
    /** 两种方法都没取到（没选中、App 不支持） */
    case empty
    /** 没有辅助功能授权，两种方法都用不了 */
    case notTrusted
  }

  /**
   * 划词翻译取词：先用辅助功能接口读（不碰剪贴板），读不到再模拟 ⌘C（取完恢复剪贴板）。
   * 顺序按 Goal 7 CP0 实测定：原生 App 用辅助功能接口能取到；Chrome、Electron、微信等只能靠 ⌘C。参数只在单测里替换。
   */
  @MainActor
  public static func capture(
    trusted: Bool = isTrusted,
    readAX: () -> String? = { readSelectedText().text },
    copy: () async -> String? = { await copySelection().text }
  ) async -> Result {
    guard trusted else { return .notTrusted }
    var raw = readAX()
    if raw == nil { raw = await copy() }
    let text = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if text.isEmpty { return .empty }
    return text.count > maxCharacters ? .tooLong(text) : .text(text)
  }

  // MARK: 辅助功能授权

  public static var isTrusted: Bool { AXIsProcessTrusted() }

  /** 弹出系统提示，引导主人到「系统设置 → 隐私与安全性 → 辅助功能」里打开 */
  @discardableResult
  public static func requestTrust() -> Bool {
    AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
  }

  /** 直接打开系统设置的「辅助功能」页面 */
  public static let accessibilitySettingsURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

  // MARK: 方法一：辅助功能接口

  public struct AXRead: Sendable {
    public let text: String?
    /** AXError 的值，0 表示成功；读不到时用来分析原因 */
    public let error: Int32
  }

  /** 读当前焦点元素选中的文字；没有焦点元素、不支持、没选中都返回 nil */
  public static func readSelectedText() -> AXRead {
    let system = AXUIElementCreateSystemWide()
    var focused: CFTypeRef?
    let e1 = AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused)
    guard e1 == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return AXRead(text: nil, error: e1.rawValue) }
    var selected: CFTypeRef?
    let e2 = AXUIElementCopyAttributeValue(focused as! AXUIElement, kAXSelectedTextAttribute as CFString, &selected)
    guard e2 == .success, let text = selected as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return AXRead(text: nil, error: e2 == .success ? -1 : e2.rawValue)
    }
    return AXRead(text: text, error: 0)
  }

  // MARK: 方法二：模拟 ⌘C

  public struct CopyRead: Sendable {
    public let text: String?
    /** 剪贴板有没有变化（目标 App 响应了 ⌘C） */
    public let changed: Bool
  }

  /**
   * 模拟一次 ⌘C 取选中的文字，取完把剪贴板原样写回。
   * 快捷键是在 ⌥ 还按着的时候触发的：先等修饰键松开（最多 0.5 秒），免得变成 ⌥⌘C。
   * postCopy、waitForKeys 只在单测里替换。
   */
  @MainActor
  public static func copySelection(
    from pasteboard: NSPasteboard = .general,
    timeout: Duration = .milliseconds(300),
    waitForKeys: Bool = true,
    postCopy: () -> Void = postCommandC
  ) async -> CopyRead {
    if waitForKeys { await waitForModifiersReleased() }
    let snapshot = PasteboardSnapshot.take(pasteboard)
    let before = pasteboard.changeCount
    postCopy()
    let clock = ContinuousClock()
    let deadline = clock.now + timeout
    while pasteboard.changeCount == before && clock.now < deadline {
      try? await Task.sleep(for: .milliseconds(10))
    }
    guard pasteboard.changeCount != before else { return CopyRead(text: nil, changed: false) }
    // 目标 App 写剪贴板可能分几步：稍等一下再读
    try? await Task.sleep(for: .milliseconds(20))
    let text = pasteboard.string(forType: .string)
    snapshot.restore(to: pasteboard)
    let usable = text.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
    return CopyRead(text: usable ? text : nil, changed: true)
  }

  /** 往当前前台 App 发一次 ⌘C */
  public static func postCommandC() {
    let source = CGEventSource(stateID: .combinedSessionState)
    let c: CGKeyCode = 8  // kVK_ANSI_C
    let down = CGEvent(keyboardEventSource: source, virtualKey: c, keyDown: true)
    let up = CGEvent(keyboardEventSource: source, virtualKey: c, keyDown: false)
    down?.flags = .maskCommand
    up?.flags = .maskCommand
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }

  /** 等 ⌘⌥⌃⇧ 都松开（最多 0.5 秒） */
  @MainActor
  public static func waitForModifiersReleased() async {
    for _ in 0..<50 {
      if NSEvent.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty { return }
      try? await Task.sleep(for: .milliseconds(10))
    }
  }
}
