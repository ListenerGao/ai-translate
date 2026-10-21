// 取词实测（Goal 7 CP0，调试用，启动参数 --probe <记录文件>）：每按一次 ⌥D，分别用辅助功能接口和模拟 ⌘C 取选中的文字，
// 记下当前 App、各自成没成功、字数、耗时、两种方法取到的是否一致；辅助功能取不到时再记系统级、App 级焦点元素的错误码和角色。
// 只记字数和元素角色，不记文字内容。成功响 Glass（清脆的「叮」），失败响 Basso（低沉的「咚」）。
import AITranslateKit
import AppKit

@MainActor
final class SelectionProbe {
  private let path: String

  init(path: String) { self.path = path }

  func start() {
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    write(["event": "launch", "trusted": SelectionCapture.isTrusted, "build": build])
    if !SelectionCapture.isTrusted { SelectionCapture.requestTrust() }
    HotKeyCenter.shared.onPress = { [weak self] _ in self?.probe() }
    let ok = HotKeyCenter.shared.register(id: HotKeyAction.translateSelection.id, combo: HotKeyAction.translateSelection.defaultCombo)
    write(["event": "hotkey", "registered": ok])
  }

  private func probe() {
    Task {
      let app = NSWorkspace.shared.frontmostApplication
      let clock = ContinuousClock()
      let t0 = clock.now
      let ax = SelectionCapture.readSelectedText()
      let axMs = ms(clock.now - t0)
      let detail = ax.text == nil ? axDetail(pid: app?.processIdentifier) : [:]
      await SelectionCapture.waitForModifiersReleased()
      let t1 = clock.now
      let copy = await SelectionCapture.copySelection(waitForKeys: false)
      let copyMs = ms(clock.now - t1)
      write([
        "event": "probe",
        "app": app?.bundleIdentifier ?? "",
        "name": app?.localizedName ?? "",
        "trusted": SelectionCapture.isTrusted,
        "ax": ["ok": ax.text != nil, "chars": ax.text?.count ?? 0, "ms": axMs, "error": ax.error, "detail": detail] as [String: Any],
        "copy": ["ok": copy.text != nil, "chars": copy.text?.count ?? 0, "ms": copyMs, "changed": copy.changed] as [String: Any],
        "same": ax.text != nil && ax.text?.trimmingCharacters(in: .whitespacesAndNewlines) == copy.text?.trimmingCharacters(in: .whitespacesAndNewlines),
      ])
      NSSound(named: ax.text != nil || copy.text != nil ? "Glass" : "Basso")?.play()
    }
  }

  /** 辅助功能取不到时分析原因：系统级、App 级各取一次焦点元素，记错误码、角色、支不支持选中文字属性、按 App 级能取到几个字 */
  private func axDetail(pid: pid_t?) -> [String: Any] {
    func focus(_ root: AXUIElement) -> [String: Any] {
      var focused: CFTypeRef?
      let e = AXUIElementCopyAttributeValue(root, kAXFocusedUIElementAttribute as CFString, &focused)
      guard e == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return ["error": e.rawValue] }
      let element = focused as! AXUIElement
      var role: CFTypeRef?
      AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
      var names: CFArray?
      AXUIElementCopyAttributeNames(element, &names)
      let attrs = names as? [String] ?? []
      var selected: CFTypeRef?
      let e2 = AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &selected)
      return [
        "error": 0, "role": role as? String ?? "", "hasSelectedText": attrs.contains(kAXSelectedTextAttribute),
        "selectedError": e2.rawValue, "chars": (selected as? String)?.count ?? 0,
      ]
    }
    var out: [String: Any] = ["system": focus(AXUIElementCreateSystemWide())]
    if let pid { out["app"] = focus(AXUIElementCreateApplication(pid)) }
    return out
  }

  private func ms(_ d: Duration) -> Int {
    Int(d.components.seconds * 1000 + d.components.attoseconds / 1_000_000_000_000_000)
  }

  private func write(_ record: [String: Any]) {
    var line = record
    line["time"] = ISO8601DateFormatter().string(from: Date())
    guard let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]) else { return }
    let url = URL(fileURLWithPath: path)
    if let handle = try? FileHandle(forWritingTo: url) {
      handle.seekToEndOfFile()
      handle.write(data + Data("\n".utf8))
      try? handle.close()
    } else {
      try? (data + Data("\n".utf8)).write(to: url)
    }
  }
}
