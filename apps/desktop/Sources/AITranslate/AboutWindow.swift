// 关于窗口：系统自带的关于面板版本行固定是「版本 0.1.0 (1)」、底部字号改不了，这里自己画（主人 2026-10-20 要求）：
// App 图标、名字、「V0.1.0 · Build 1」（从 Info.plist 读）、一句说明、最底部「Made by ListenerGao」；文字都能选中复制。
import AppKit
import SwiftUI

struct AboutView: View {
  private var version: String {
    let info = Bundle.main.infoDictionary ?? [:]
    let short = info["CFBundleShortVersionString"] as? String ?? "0.0.0"
    let build = info["CFBundleVersion"] as? String ?? "0"
    return "V\(short) · Build \(build)"
  }

  var body: some View {
    VStack(spacing: 0) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .frame(width: 96, height: 96)
        .padding(.bottom, 10)
      Text("AI Translate").font(.system(size: 20, weight: .semibold))
      Text(version).font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit().padding(.top, 4)
      Text("本地模型离线翻译，内容不出本机").font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 14)
      Spacer(minLength: 18)
      Text("Made by ListenerGao").font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
    }
    // 文字能选中复制（如版本号，主人 2026-10-20 要求）
    .textSelection(.enabled)
    .padding(.top, 34)
    .padding(.bottom, 22)
    .frame(width: 300, height: 292)
  }
}

@MainActor
final class AboutWindowController {
  private(set) var window: NSWindow?

  func show() {
    let window = self.window ?? makeWindow()
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 300, height: 292),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "关于 AI Translate"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.contentView = NSHostingView(rootView: AboutView())
    window.isReleasedWhenClosed = false
    window.center()
    self.window = window
    return window
  }
}
