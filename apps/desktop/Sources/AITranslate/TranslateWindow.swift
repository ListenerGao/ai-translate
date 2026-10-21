// 翻译窗口的控制器：建窗口（标题栏透明、内容铺满）、填入文字、文件翻译任务、关窗口时清空。界面在 TranslateView.swift。
import AITranslateKit
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/** 目标语言存在 UserDefaults 里，翻译窗口和设置共用（和插件的设置分开存） */
enum Preferences {
  static let targetKey = "target"

  static var target: String {
    get { UserDefaults.standard.string(forKey: targetKey) ?? "zh" }
    set { UserDefaults.standard.set(newValue, forKey: targetKey) }
  }
}

@MainActor
final class TranslateWindowController: NSObject, NSWindowDelegate, NSToolbarDelegate {
  private static let languageItem = NSToolbarItem.Identifier("language")
  private static let logoItem = NSToolbarItem.Identifier("logo")

  let model: TranslateModel
  let files = FileJobHolder()
  let syncer = ScrollSyncer()
  private(set) lazy var highlight = ParagraphHighlight(syncer: syncer)
  private let client: AitdClient
  private var window: NSWindow?

  init(client: AitdClient) {
    self.client = client
    model = TranslateModel(backend: client, target: Preferences.target)
  }

  /** 文件翻译：打开窗口，盖上文件卡片；不支持的文件弹框提示（主人 2026-10-20 定） */
  func translateFile(_ url: URL) {
    show()
    files.job?.cancel()
    do {
      files.job = try FileJob(source: url, target: model.target, bilingual: UserDefaults.standard.bool(forKey: "bilingual"), backend: client)
    } catch {
      files.job = nil
      let alert = NSAlert()
      alert.alertStyle = .warning
      alert.messageText = "不支持这个文件"
      alert.informativeText = "\(url.lastPathComponent)\n只能翻译 Markdown（.md、.markdown）和 SRT 字幕（.srt）"
      alert.addButton(withTitle: "好")
      if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }
  }

  /** 菜单「翻译文件…」：选一个 Markdown 或 SRT 文件 */
  func chooseFile() {
    show()
    let panel = NSOpenPanel()
    panel.allowedContentTypes = ["md", "markdown", "srt"].compactMap { UTType(filenameExtension: $0) }
    panel.allowsMultipleSelection = false
    panel.message = "选一个 Markdown（.md）或 SRT 字幕文件"
    if panel.runModal() == .OK, let url = panel.url { translateFile(url) }
  }

  func startFile() {
    files.job?.start(sourceLanguage: model.source, target: model.target)
  }

  func closeFile() {
    files.job?.cancel()
    files.job = nil
  }

  /** 打开窗口；给了文字就填进去并立即翻译 */
  func show(text: String? = nil) {
    let window = self.window ?? makeWindow()
    if let text {
      model.input = text
      model.translateNow()
    }
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
    // 打开窗口就能直接输入：焦点放在左边输入框，不落在「清空」这类小按钮上
    if let input = Self.inputView(in: window.contentView) { window.makeFirstResponder(input) }
  }

  private static func inputView(in view: NSView?) -> NSTextView? {
    guard let view else { return nil }
    if let text = view as? DropTextView { return text }
    for sub in view.subviews {
      if let found = inputView(in: sub) { return found }
    }
    return nil
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 920, height: 580),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false,
    )
    window.title = "AI Translate"
    // 标题栏透明、不显示标题；语言选择放进统一样式的工具栏，居中，和左上角的红绿灯同一行，窗口看起来是一整块
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    let toolbar = NSToolbar(identifier: "TranslateWindow")
    toolbar.delegate = self
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    toolbar.centeredItemIdentifiers = [Self.languageItem]
    window.toolbar = toolbar
    window.toolbarStyle = .unified
    window.contentView = NSHostingView(rootView: TranslateView(
      model: model,
      files: files,
      syncer: syncer,
      highlight: highlight,
      openFile: { [weak self] in self?.translateFile($0) },
      startFile: { [weak self] in self?.startFile() },
      closeFile: { [weak self] in self?.closeFile() },
    ))
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("TranslateWindow")
    self.window = window
    return window
  }

  func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    [.flexibleSpace, Self.languageItem, .flexibleSpace, Self.logoItem]
  }

  func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
    toolbarDefaultItemIdentifiers(toolbar)
  }

  func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier id: NSToolbarItem.Identifier, willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? {
    if id == Self.logoItem {
      // 右上角的 logo：用 App 图标（主人 2026-10-20 要求）
      let item = NSToolbarItem(itemIdentifier: id)
      let view = NSHostingView(rootView: Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 28, height: 28).help("AI Translate"))
      view.frame.size = NSSize(width: 28, height: 28)
      item.view = view
      item.label = "AI Translate"
      return item
    }
    guard id == Self.languageItem else { return nil }
    let item = NSToolbarItem(itemIdentifier: id)
    let view = NSHostingView(rootView: LanguageBar(model: model).tint(.brand))
    view.frame.size = view.fittingSize
    item.view = view
    item.label = "语言"
    return item
  }

  /** 关窗口时清空原文和译文，下次打开是干净的窗口；翻过的内容在 aitd 的缓存里，再翻照样立即出 */
  func windowWillClose(_ notification: Notification) {
    model.reset()
    closeFile()
  }

  private var fileBusy: Bool {
    if case .translating = files.job?.phase { true } else { false }
  }

  /** 调试用：等翻译结束后把窗口内容存成 PNG（我这边看不到屏幕，靠它核对界面）；scroll 给了时先把原文或译文滚到那个比例，核对另一边跟着滚 */
  func snapshot(to path: String, scroll: (source: Bool, fraction: Double)? = nil) {
    Task {
      for _ in 0..<150 where model.isTranslating || fileBusy || model.rows.isEmpty && model.problem == nil && model.notice == nil && files.job == nil && window?.attachedSheet == nil {
        try? await Task.sleep(for: .milliseconds(200))
      }
      try? await Task.sleep(for: .milliseconds(300))
      if let scroll {
        syncer.debugScroll(source: scroll.source, fraction: scroll.fraction)
        try? await Task.sleep(for: .milliseconds(300))
      }
      // 连同标题栏和工具栏一起截（contentView 的上一层）
      guard let view = window?.contentView?.superview ?? window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
      // 弹框（sheet）是单独的窗口，另存一张
      if let sheet = window?.attachedSheet?.contentView, let sheetRep = sheet.bitmapImageRepForCachingDisplay(in: sheet.bounds) {
        sheet.cacheDisplay(in: sheet.bounds, to: sheetRep)
        try? sheetRep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path.replacingOccurrences(of: ".png", with: "-sheet.png")))
      }
    }
  }
}
