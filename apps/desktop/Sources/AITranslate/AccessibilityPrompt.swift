// 划词翻译要「辅助功能」权限：没授权时按划词快捷键弹出说明，按钮直接打开系统设置的对应页面，并提示不授权也能用翻译窗口。
import AITranslateKit
import AppKit

@MainActor
enum AccessibilityPrompt {
  /** 打开「系统设置 → 隐私与安全性 → 辅助功能」；同时请系统把 AI Translate 列进去（没列进去时要手动点「+」加） */
  static func openSettings() {
    SelectionCapture.requestTrust()
    NSWorkspace.shared.open(SelectionCapture.accessibilitySettingsURL)
  }

  /** selection、window 是当前的快捷键文字（如「⌥D」）；打开翻译窗口的快捷键清空了时传 nil */
  static func show(selection: String, window: String?) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = "划词翻译要先打开「辅助功能」权限"
    let open = window.map { "按 \($0)" } ?? "点菜单栏图标里的「打开翻译窗口」"
    alert.informativeText = """
      AI Translate 要读取别的 App 里选中的文字：只在按 \(selection) 时读一次，只发给本机的翻译服务，不记录。

      在「系统设置 → 隐私与安全性 → 辅助功能」里打开 AI Translate，打开后不用重启。

      不想授权也可以\(open)，把文字粘贴进去翻。
      """
    alert.addButton(withTitle: "打开系统设置")
    alert.addButton(withTitle: "取消")
    if alert.runModal() == .alertFirstButtonReturn { openSettings() }
  }
}
