// 菜单栏：图标、状态、打开翻译窗口、翻译文件、设置、重启翻译服务、退出。打开菜单时立即刷新状态，平时每 10 秒刷新一次（只请求本机 /health 和 /api/status）。
// 全局快捷键：⌥D 划词翻译（鼠标旁边弹出翻译卡片）、⌥A 打开翻译窗口（设置里可改）。翻译剪贴板、右键「服务」菜单主人 2026-10-21 定不做。
// 调试用的启动参数（核对界面用，不碰剪贴板）：--translate-text <文本文件> 启动后打开翻译窗口翻这段文字；
// --translate-file <文件> [--bilingual] [--auto-start] 打开文件翻译卡片（可直接开始）；--settings [general|shortcuts|glossary|service|models|about] 打开设置（可指定哪一页，加 --full 截整页）；--about 打开关于窗口；--snapshot <PNG> 把窗口存成图片（翻译窗口可加 --scroll source|result <0~1> 先滚动）；--dark 用深色外观；
// --card <文本文件> 在屏幕中间弹出划词卡片翻这段文字（加 --languages 打开目标语言列表）；--probe <记录文件> 取词实测（Goal 7 CP0）；
// --download-model <版本> <目录> [--stop-after-mb N] 用 App 的下载器把这个版本下到指定目录（不动 models/），下到 N MB 时取消，打印进度后退出（Goal 8 实测）。
import AITranslateKit
import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
  /** 和命令行一样，环境变量 AIT_URL 可以改连别的 aitd 地址（只能是本机），调试用 */
  private let client = AitdClient(endpoint: ProcessInfo.processInfo.environment["AIT_URL"].flatMap { URL(string: $0) } ?? AitdClient.defaultEndpoint)
  private var statusItem: NSStatusItem!
  private let stateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private let detailItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
  private var state: ServiceState = .checking
  private var timer: Timer?
  private var refreshing = false
  private lazy var translateWindow = TranslateWindowController(client: client) { [weak self] in self?.openSettings() }
  private lazy var card = TranslationCardController(client: client)
  private let aboutWindow = AboutWindowController()
  private var probe: SelectionProbe?
  private let hotKeys = HotKeyModel(registrar: HotKeyCenter.shared, takenBySystem: HotKeyCenter.takenBySystem)
  /** 正在取词：连按快捷键时不重复取 */
  private var capturing = false
  /** 菜单栏菜单在当前空间看不到，收起后改开翻译窗口 */
  private var openWindowAfterMenu = false
  private var openItem: NSMenuItem!
  /** 「模型」页的状态放在这里：关掉设置窗口也接着下载 */
  private lazy var models = ModelsModel(backend: client)
  private lazy var settingsWindow = SettingsWindowController(
    client: client, hotKeys: hotKeys, models: models,
    restart: { [weak self] in
      guard let self else { return (.notResponding, nil) }
      let result = await self.supervisor.restartAndLoad()
      return (result, await self.supervisor.problem)
    }
  ) { [weak self] target in
    self?.translateWindow.model.target = target
  }
  /** 发布包里的 App 自己带起 aitd（Goal 9）；开发装的 App 里没带，照旧连开机自启的 */
  private lazy var supervisor = AitdSupervisor(client: client, remembers: ProcessInfo.processInfo.environment["AIT_URL"] == nil)
  private lazy var onboarding = OnboardingWindowController(models: models) { [weak self] in
    self?.settingsWindow.show(page: .models)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // 取词实测：不建菜单栏图标、不在 Dock 显示，只注册 ⌥D 记录结果
    if let i = CommandLine.arguments.firstIndex(of: "--probe"), i + 1 < CommandLine.arguments.count {
      NSApp.setActivationPolicy(.accessory)
      probe = SelectionProbe(path: CommandLine.arguments[i + 1])
      probe?.start()
      return
    }
    if let i = CommandLine.arguments.firstIndex(of: "--download-model"), i + 2 < CommandLine.arguments.count {
      NSApp.setActivationPolicy(.accessory)
      downloadForTest(quant: CommandLine.arguments[i + 1], into: URL(fileURLWithPath: CommandLine.arguments[i + 2]))
      return
    }
    // 从「下载」里直接打开的：系统把 App 搬到了临时位置运行，登录项会记错，先请主人拖进「应用程序」
    if AppLocation.isTranslocated(Bundle.main.bundlePath) {
      alert("先把 AI Translate 拖进「应用程序」文件夹", "从「下载」等位置直接打开时，系统会把 App 放到一个临时位置运行，下次就找不到了。请在访达里把 AI Translate 拖进「应用程序」，再从那里打开。")
      NSApp.terminate(nil)
      return
    }
    NSApp.mainMenu = buildMainMenu()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.menu = buildMenu()
    HotKeyCenter.shared.onPress = { [weak self] id in self?.hotKeyPressed(id) }
    hotKeys.registerAll()
    show(.checking)
    refresh()
    // 没有 aitd 在跑就启动 App 里带的；能用了再看要不要弹新手引导（本机一个模型都没有）
    Task {
      await supervisor.ensureRunning()
      refresh()
      settingsWindow.refreshIfOpen()
      if let problem = supervisor.problem { alert("翻译服务没能启动", problem) }
      if !CommandLine.arguments.contains(where: { $0.hasPrefix("--") }), ModelSource.needsModel(try? await client.models()) { onboarding.show() }
    }
    timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.refresh() }
    }
    LoginItem.applyDefault()
    let args = CommandLine.arguments
    if args.contains("--dark") { NSApp.appearance = NSAppearance(named: .darkAqua) }
    if args.contains("--about") {
      showAbout()
      if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { snapshotAbout(to: args[i + 1]) }
      return
    }
    if let i = args.firstIndex(of: "--onboarding") {
      // --onboarding [done]：打开新手引导（截图核对用）
      onboarding.show(phase: args.indices.contains(i + 1) && args[i + 1] == "done" ? .done : .intro)
      if let j = args.firstIndex(of: "--snapshot"), j + 1 < args.count { onboarding.snapshot(to: args[j + 1]) }
      return
    }
    if let i = args.firstIndex(of: "--settings") {
      settingsWindow.show(page: args.indices.contains(i + 1) ? SettingsPage(rawValue: args[i + 1]) : nil)
      if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { settingsWindow.snapshot(to: args[i + 1], fullPage: args.contains("--full")) }
      return
    }
    if let i = args.firstIndex(of: "--card"), i + 1 < args.count, let text = try? String(contentsOfFile: args[i + 1], encoding: .utf8) {
      let screen = NSScreen.main?.visibleFrame ?? .zero
      card.show(text: text.trimmingCharacters(in: .whitespacesAndNewlines), at: CGPoint(x: screen.midX - 200, y: screen.midY + 200))
      // --languages：打开目标语言列表（截图核对用）
      if args.contains("--languages") {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in card.state.toggleLanguages(current: card.model.target) }
      }
      if let j = args.firstIndex(of: "--snapshot"), j + 1 < args.count { card.snapshot(to: args[j + 1]) }
      return
    }
    if let i = args.firstIndex(of: "--translate-text"), i + 1 < args.count, let text = try? String(contentsOfFile: args[i + 1], encoding: .utf8) {
      translateWindow.show(text: text)
    }
    if let i = args.firstIndex(of: "--translate-file"), i + 1 < args.count {
      translateWindow.translateFile(URL(fileURLWithPath: args[i + 1]))
      if args.contains("--bilingual") { translateWindow.files.job?.bilingual = true }
      if args.contains("--auto-start") { translateWindow.startFile() }
    }
    if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
      // --scroll source|result <0~1>：截图前把原文或译文滚到那个比例
      let scroll = args.firstIndex(of: "--scroll").flatMap { j in
        j + 2 < args.count ? Double(args[j + 2]).map { (source: args[j + 1] == "source", fraction: $0) } : nil
      }
      translateWindow.snapshot(to: args[i + 1], scroll: scroll)
    }
  }

  /** App 在前台时屏幕顶部的菜单；输入框的 ⌘C、⌘V、⌘A、⌘Z 和 ⌘W 也靠这里的快捷键生效 */
  private func buildMainMenu() -> NSMenu {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu(title: "AI Translate")
    let about = NSMenuItem(title: "关于 AI Translate", action: #selector(showAbout), keyEquivalent: "")
    about.target = self
    appMenu.addItem(about)
    appMenu.addItem(.separator())
    let settings = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
    settings.target = self
    appMenu.addItem(settings)
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "隐藏 AI Translate", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
    hideOthers.keyEquivalentModifierMask = [.command, .option]
    appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "退出 AI Translate", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)
    let fileItem = NSMenuItem()
    let file = NSMenu(title: "文件")
    let newWindow = NSMenuItem(title: "新建翻译窗口", action: #selector(openTranslateWindow), keyEquivalent: "n")
    newWindow.target = self
    file.addItem(newWindow)
    let openFile = NSMenuItem(title: "翻译文件…", action: #selector(chooseFile), keyEquivalent: "o")
    openFile.target = self
    file.addItem(openFile)
    fileItem.submenu = file
    main.addItem(fileItem)
    let editItem = NSMenuItem()
    let edit = NSMenu(title: "编辑")
    edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
    let redo = edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
    redo.keyEquivalentModifierMask = [.command, .shift]
    edit.addItem(.separator())
    edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit
    main.addItem(editItem)
    let windowItem = NSMenuItem()
    let windowMenu = NSMenu(title: "窗口")
    windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
    windowMenu.addItem(withTitle: "关闭", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    windowItem.submenu = windowMenu
    main.addItem(windowItem)
    NSApp.windowsMenu = windowMenu
    return main
  }

  /** 调试用（--download-model）：读 Hugging Face 的列表，用 App 的下载器下一个版本到指定目录，打印进度和结果后退出 */
  private func downloadForTest(quant: String, into dir: URL) {
    let args = CommandLine.arguments
    let stopAfter = args.firstIndex(of: "--stop-after-mb").flatMap { args.indices.contains($0 + 1) ? Int64(args[$0 + 1]) : nil }.map { $0 * 1_000_000 }
    let say: @Sendable (String) -> Void = { line in FileHandle.standardError.write(Data("\(line)\n".utf8)) }
    Task {
      do {
        let downloader = ModelDownloader(directory: dir)
        guard let model = try await ModelSource.fetchRemote(endpoint: ModelSource.defaultEndpoint).first(where: { $0.quant == quant }) else {
          say("error 列表里没有 \(quant)")
          return NSApp.terminate(nil)
        }
        say("start \(downloader.downloadedBytes(quant)) of \(model.size)")
        let started = Date()
        let task = Task {
          try await downloader.download(model, from: ModelSource.defaultEndpoint, progress: { bytes in
            say("progress \(bytes)")
          }, verifying: { say("verifying") })
        }
        if let stopAfter {
          while downloader.downloadedBytes(quant) < stopAfter { try await Task.sleep(for: .milliseconds(200)) }
          task.cancel()
        }
        let file = try await task.value
        say("done \(file.path) \(Int(Date().timeIntervalSince(started)))s")
      } catch is CancellationError {
        say("cancelled at \(ModelDownloader(directory: dir).downloadedBytes(quant))")
      } catch {
        say("error \(ModelsModel.message(error))")
      }
      NSApp.terminate(nil)
    }
  }

  /** 调试用：把关于窗口存成 PNG */
  private func snapshotAbout(to path: String) {
    Task {
      try? await Task.sleep(for: .milliseconds(800))
      guard let panel = aboutWindow.window,
        let view = panel.contentView?.superview ?? panel.contentView,
        let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds)
      else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
  }

  /** 关于窗口（AboutWindow.swift）：版本和 Build 号、Made by ListenerGao */
  @objc private func showAbout() {
    aboutWindow.show()
  }

  /** 点 Dock 图标：没有打开的窗口时打开翻译窗口 */
  /** 退出 App 时停掉自己带起来的 aitd（它会先停模型）；开机自启的不管 */
  func applicationWillTerminate(_ notification: Notification) {
    supervisor.stop()
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { translateWindow.show() }
    return true
  }

  /** 关掉最后一个窗口不退出：菜单栏图标还在，⌘Q 才退出 */
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  /** 右键 Dock 图标的菜单 */
  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    for (title, action) in [("打开翻译窗口", #selector(openTranslateWindow)), ("翻译文件…", #selector(chooseFile)), ("设置…", #selector(openSettings))] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    return menu
  }

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()
    menu.delegate = self
    menu.autoenablesItems = false
    stateItem.isEnabled = false
    detailItem.isEnabled = false
    menu.addItem(stateItem)
    menu.addItem(detailItem)
    menu.addItem(.separator())
    openItem = NSMenuItem(title: "打开翻译窗口", action: #selector(openTranslateWindow), keyEquivalent: "")
    openItem.target = self
    menu.addItem(openItem)
    let file = NSMenuItem(title: "翻译文件…", action: #selector(chooseFile), keyEquivalent: "")
    file.target = self
    menu.addItem(file)
    menu.addItem(.separator())
    let settings = NSMenuItem(title: "设置…", action: #selector(openSettings), keyEquivalent: ",")
    settings.target = self
    menu.addItem(settings)
    let restart = NSMenuItem(title: "重启翻译服务", action: #selector(restartService), keyEquivalent: "")
    restart.target = self
    menu.addItem(restart)
    menu.addItem(.separator())
    let quit = NSMenuItem(title: "退出 AI Translate", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    menu.addItem(quit)
    return menu
  }

  func menuWillOpen(_ menu: NSMenu) {
    refresh()
    showShortcut(.openWindow, on: openItem)
    checkMenuVisible()
  }

  /**
   * 菜单栏菜单弹出后看一眼它在不在当前空间：App 在 Dock 常驻、又不在前台时，别的 App 全屏的那块屏幕上，系统不让它的菜单进那个全屏空间，
   * 弹出来也看不到（主人 2026-10-21 总验收发现，和划词卡片的语言列表是同一个原因）。这时收起菜单，改为在桌面打开翻译窗口（主人定）
   */
  private func checkMenuVisible() {
    // 菜单窗口要过一会儿才建好：每 0.08 秒找一次，最多等约 0.6 秒，找到就判断一次
    let deadline = Date().addingTimeInterval(0.6)
    let timer = Timer(timeInterval: 0.08, repeats: true) { [weak self] timer in
      let done = MainActor.assumeIsolated { () -> Bool in
        guard let self, let window = NSApp.windows.first(where: { $0.isVisible && $0.level == .popUpMenu }) else { return Date() > deadline }
        if !window.isOnActiveSpace {
          self.openWindowAfterMenu = true
          self.statusItem.menu?.cancelTracking()
        }
        return true
      }
      if done { timer.invalidate() }
    }
    // 菜单打开期间 run loop 在事件跟踪模式，要加到 common 模式里才会触发
    RunLoop.main.add(timer, forMode: .common)
  }

  func menuDidClose(_ menu: NSMenu) {
    guard openWindowAfterMenu else { return }
    openWindowAfterMenu = false
    // 等菜单完全收起再打开窗口：系统会切回桌面，窗口出现在那里，光标停在输入框
    DispatchQueue.main.async { [weak self] in self?.openTranslateWindow() }
  }

  /** 菜单项右边显示当前的全局快捷键（设置里改了跟着变） */
  private func showShortcut(_ action: HotKeyAction, on item: NSMenuItem) {
    let combo = hotKeys.combos[action]
    item.keyEquivalent = combo.flatMap(HotKeyRecorder.menuKey) ?? ""
    item.keyEquivalentModifierMask = combo?.eventModifiers ?? []
  }

  private func hotKeyPressed(_ id: UInt32) {
    switch HotKeyAction.allCases.first(where: { $0.id == id }) {
    case .translateSelection: translateSelection()
    case .openWindow: openTranslateWindow()
    case nil: break
    }
  }

  /** 当前的快捷键文字，提示里用；清空了时为 nil */
  private func shortcut(_ action: HotKeyAction) -> String? {
    hotKeys.combos[action]?.display
  }

  /** 划词翻译：取当前 App 里选中的文字（先辅助功能接口，再模拟 ⌘C），在按快捷键时鼠标所在的位置旁边弹出翻译卡片 */
  private func translateSelection() {
    guard !capturing else { return }
    capturing = true
    let mouse = NSEvent.mouseLocation
    Task {
      let result = await SelectionCapture.capture()
      capturing = false
      switch result {
      case .text(let text):
        card.show(text: text, at: mouse)
      case .tooLong(let text):
        translateWindow.show(text: text)
        translateWindow.model.show(notice: "选中了 \(text.count) 字，超过划词翻译的 \(SelectionCapture.maxCharacters) 字，已放进翻译窗口")
      case .empty:
        break  // 没选中文字：什么都不做，不打开窗口（主人 2026-10-21 定）
      case .notTrusted:
        AccessibilityPrompt.show(selection: shortcut(.translateSelection) ?? "快捷键", window: shortcut(.openWindow))
      }
    }
  }

  private func refresh() {
    guard !refreshing else { return }
    refreshing = true
    Task {
      let next = await client.serviceState()
      refreshing = false
      show(next)
    }
  }

  private func show(_ next: ServiceState) {
    state = next
    statusItem.button?.image = StatusIcon.image(for: next.badge)
    statusItem.button?.toolTip = "AI Translate：翻译服务\(next.title)"
    stateItem.title = "翻译服务：\(next.title)"
    detailItem.title = next.detail ?? ""
    detailItem.isHidden = next.detail == nil
  }

  @objc private func openTranslateWindow() {
    translateWindow.show()
  }

  @objc private func chooseFile() {
    translateWindow.chooseFile()
  }

  @objc private func openSettings() {
    settingsWindow.show()
  }

  /** 重启翻译服务并马上加载模型；加载要几秒，期间多刷新几次，直到回到「运行中」 */
  @objc private func restartService() {
    show(.checking)
    Task {
      let result = await supervisor.restartAndLoad()
      refresh()
      switch result {
      case .loading:
        for _ in 0..<10 {
          try? await Task.sleep(for: .seconds(1))
          refresh()
          if case .running = state { break }
        }
      case .notInstalled:
        alert("没有安装开机自启", ServiceState.startHint)
      case .notResponding:
        alert("翻译服务重启后没有响应", supervisor.problem ?? AitdService.logHint)
      }
    }
  }

  private func alert(_ title: String, _ message: String) {
    NSApp.activate()
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = message
    alert.runModal()
  }
}
