// 新手引导（Goal 9）：发布包里的 App 第一次打开、本机一个模型都没有时弹出来，引导下载推荐的 Q4_K_M（主人 2026-10-21 定），
// 下完设为当前；然后告诉同事翻译窗口、划词、Chrome 插件怎么用。下载用「模型」页同一套（ModelsModel），关掉窗口也接着下。
import AITranslateKit
import AppKit
import SwiftUI

struct OnboardingView: View {
  enum Phase {
    case intro, working, done
  }

  let models: ModelsModel
  let finish: () -> Void
  let openModelsSettings: () -> Void
  @State var phase: Phase = .intro

  private let quant = ModelSource.recommendedQuant
  private var row: ModelRow? { models.rows.first { $0.quant == quant } }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 14) {
        Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
        VStack(alignment: .leading, spacing: 4) {
          Text(phase == .done ? "可以开始翻译了" : "下载翻译模型").font(.system(size: 18, weight: .semibold))
          Text("本地模型离线翻译，内容不出本机").font(.system(size: 12)).foregroundStyle(.secondary)
        }
      }
      .padding(.bottom, 18)
      if phase == .done { done } else { download }
      Spacer(minLength: 16)
      buttons
    }
    .padding(24)
    .frame(width: 480, height: 360, alignment: .topLeading)
    .tint(.brand)
    .onChange(of: row?.state) { _, state in
      guard phase == .working else { return }
      // 下完、校验通过：设为当前（aitd 加载它）；变成「正在用」就完成
      if state == .downloaded { Task { await models.use(quant) } }
      if state == .inUse { phase = .done }
    }
  }

  // MARK: 下载

  @ViewBuilder private var download: some View {
    Text("第一次用要先下载一个模型：Index-Translate-2B 的 \(quant) 版本，约 \(formatBytes(row?.size ?? 1_312_164_352))。盲评和更大的 Q8_0 打平，翻得更快；以后可以在「设置 → 模型」里换。")
      .font(.system(size: 13))
      .lineSpacing(3)
      .fixedSize(horizontal: false, vertical: true)
    Text("下载走系统的网络设置（系统代理自动生效），下完校验文件；访问不了 Hugging Face 时，到「设置 → 模型」换镜像地址。")
      .font(.system(size: 12))
      .foregroundStyle(.secondary)
      .lineSpacing(2)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.top, 8)
    if phase == .working {
      progress.padding(.top, 18)
    }
    if let problem {
      Label(problem, systemImage: "exclamationmark.triangle.fill")
        .font(.system(size: 12))
        .foregroundStyle(.red)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .padding(.top, 14)
    }
  }

  @ViewBuilder private var progress: some View {
    switch row?.state {
    case let .downloading(done)?:
      VStack(alignment: .leading, spacing: 6) {
        ProgressView(value: row?.progress ?? 0)
        Text("已下 \(Int((row?.progress ?? 0) * 100))% · \(formatBytes(done)) / \(formatBytes(row?.size ?? 0))")
          .font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit()
      }
    case .verifying?:
      busy("下载完成，正在校验文件…")
    case .downloaded?, .inUse?:
      busy("正在加载模型…")
    default:
      busy(models.refreshing ? "正在读取版本列表…" : "准备下载…")
    }
  }

  private func busy(_ text: String) -> some View {
    HStack(spacing: 8) {
      ProgressView().controlSize(.small)
      Text(text).font(.system(size: 12)).foregroundStyle(.secondary)
    }
  }

  /** 出错的原因：下载、校验、切换失败，或者读不到 Hugging Face 的列表 */
  private var problem: String? {
    guard phase == .working else { return nil }
    if let error = models.errors[quant] { return error }
    if row == nil && !models.refreshing { return models.remoteProblem ?? models.serviceProblem }
    return nil
  }

  // MARK: 完成

  @ViewBuilder private var done: some View {
    VStack(alignment: .leading, spacing: 12) {
      tip("macwindow", "翻译窗口", "按 ⌥A，或点菜单栏的「中→A」图标")
      tip("text.cursor", "划词翻译", "在任何 App 里选中文字按 ⌥D；第一次按时按提示打开「辅助功能」权限")
      tip("puzzlepiece.extension", "Chrome 插件", "在 chrome://extensions 打开「开发者模式」，「加载已解压的扩展程序」选压缩包里的「Chrome 插件」文件夹（先放到不会删的位置）；再到「设置 → 翻译服务」的「Chrome 插件连接」核对服务地址，点「复制密钥」粘贴到插件设置的「密钥」")
    }
  }

  private func tip(_ icon: String, _ title: String, _ detail: String) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon).font(.system(size: 15)).foregroundStyle(Color.brand).frame(width: 20)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold))
        Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      }
    }
  }

  // MARK: 按钮

  @ViewBuilder private var buttons: some View {
    HStack(spacing: 10) {
      if phase != .done {
        Button("在「设置 → 模型」里选别的版本", action: openModelsSettings).buttonStyle(.link).font(.system(size: 12))
      }
      Spacer()
      switch phase {
      case .intro:
        Button("稍后", action: finish).buttonStyle(SoftButtonStyle())
        Button("下载", action: start).buttonStyle(SoftButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
      case .working:
        Button("关闭（接着在后台下载）", action: finish).buttonStyle(SoftButtonStyle())
        if problem != nil { Button("重试", action: start).buttonStyle(SoftButtonStyle(prominent: true)) }
      case .done:
        Button("完成", action: finish).buttonStyle(SoftButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
      }
    }
  }

  /** 读一次 Hugging Face 的列表再下载；已经下好了（上次下完没设为当前）就直接设为当前 */
  private func start() {
    phase = .working
    Task {
      await models.refresh()
      switch row?.state {
      case .inUse?: phase = .done
      case .downloaded?: await models.use(quant)
      case .available?, .paused?: models.download(quant)
      default: break
      }
    }
  }
}

@MainActor
final class OnboardingWindowController {
  private(set) var window: NSWindow?
  private let models: ModelsModel
  private let openModelsSettings: () -> Void

  init(models: ModelsModel, openModelsSettings: @escaping () -> Void) {
    self.models = models
    self.openModelsSettings = openModelsSettings
  }

  func show(phase: OnboardingView.Phase = .intro) {
    let window = self.window ?? makeWindow(phase: phase)
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  private func makeWindow(phase: OnboardingView.Phase) -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 480, height: 360),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    window.title = "欢迎使用 AI Translate"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    // 只留关闭按钮（和设置窗口一样）
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true
    window.contentView = NSHostingView(rootView: OnboardingView(
      models: models,
      finish: { [weak window] in window?.close() },
      openModelsSettings: { [weak self, weak window] in
        window?.close()
        self?.openModelsSettings()
      },
      phase: phase
    ))
    window.isReleasedWhenClosed = false
    window.center()
    self.window = window
    return window
  }

  /** 调试用：把引导窗口存成 PNG */
  func snapshot(to path: String) {
    Task {
      try? await Task.sleep(for: .milliseconds(800))
      guard let view = window?.contentView?.superview ?? window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
  }
}
