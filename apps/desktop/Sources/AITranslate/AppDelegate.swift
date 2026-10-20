// 菜单栏：图标、状态、打开翻译窗口、翻译剪贴板、翻译文件、设置、重启翻译服务、退出。打开菜单时立即刷新状态，平时每 10 秒刷新一次（只请求本机 /health 和 /api/status）。
// 调试用的启动参数（核对界面用，不碰剪贴板）：--translate-text <文本文件> 启动后打开翻译窗口翻这段文字；
// --translate-file <文件> [--bilingual] [--auto-start] 打开文件翻译卡片（可直接开始）；--settings 打开设置；--about 打开关于窗口；--snapshot <PNG> 把窗口存成图片；--dark 用深色外观。
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
  private lazy var translateWindow = TranslateWindowController(client: client)
  private let aboutWindow = AboutWindowController()
  private lazy var settingsWindow = SettingsWindowController(client: client) { [weak self] target in
    self?.translateWindow.model.target = target
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = buildMainMenu()
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusItem.menu = buildMenu()
    show(.checking)
    refresh()
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
    if args.contains("--settings") {
      settingsWindow.show()
      if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { settingsWindow.snapshot(to: args[i + 1]) }
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
    if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count { translateWindow.snapshot(to: args[i + 1]) }
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
    let clipboard = NSMenuItem(title: "翻译剪贴板", action: #selector(translateClipboard), keyEquivalent: "")
    clipboard.target = self
    file.addItem(clipboard)
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

  /** 关于窗口（AboutWindow.swift）：V0.1.0 · Build 1、Made by ListenerGao */
  @objc private func showAbout() {
    aboutWindow.show()
  }

  /** 点 Dock 图标：没有打开的窗口时打开翻译窗口 */
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { translateWindow.show() }
    return true
  }

  /** 关掉最后一个窗口不退出：菜单栏图标还在，⌘Q 才退出 */
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  /** 右键 Dock 图标的菜单 */
  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    for (title, action) in [("打开翻译窗口", #selector(openTranslateWindow)), ("翻译剪贴板", #selector(translateClipboard)), ("翻译文件…", #selector(chooseFile)), ("设置…", #selector(openSettings))] {
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
    let open = NSMenuItem(title: "打开翻译窗口", action: #selector(openTranslateWindow), keyEquivalent: "")
    open.target = self
    menu.addItem(open)
    let clipboard = NSMenuItem(title: "翻译剪贴板", action: #selector(translateClipboard), keyEquivalent: "")
    clipboard.target = self
    menu.addItem(clipboard)
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

  @objc private func translateClipboard() {
    translateWindow.translateClipboard()
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
      let result = await AitdService.restartAndLoad(client)
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
        alert("翻译服务重启后没有响应", "看 ~/Library/Application Support/ai-translate/logs/launchd.log")
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
