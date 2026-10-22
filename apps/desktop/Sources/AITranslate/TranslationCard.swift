// 划词翻译卡片（Goal 7 CP3）：按 ⌥D 后出现在鼠标旁边，样式和插件的划词卡片一致 --
// 顶部「翻译」、目标语言、固定、关闭；原文超过 3 行折叠、可展开；译文按段显示，能复制；底部标明本机模型。
// 卡片是不抢前台的浮动面板：不激活 AI Translate，原来的 App 还在前台；点卡片外面或切到别的 App 就关（固定时不关），Esc 关闭。
// 键盘：Esc 或 ⌘W 关闭，⌘C 复制（选中了一部分就复制选中的），⌘P 固定，⌘L 打开目标语言列表（上下键、回车选，Esc 收起）。
// 换目标语言只对这张卡片生效，不改设置里的默认值。取到的文字只发给本机 aitd，不写日志、不存历史。
import AITranslateKit
import AppKit
import Observation
import SwiftUI

/** 卡片的界面状态 */
@MainActor
@Observable
final class CardState {
  var pinned = false
  var sourceExpanded = false
  var copied = false
  /** 正文（原文 + 译文）最高多少，超过就在卡片里滚动 */
  var maxBodyHeight: CGFloat = 420
  /** 目标语言列表开着；languageHighlight 是鼠标或上下键停在第几项 */
  var languagesOpen = false
  var languageHighlight: Int?
  /** 语言胶囊在卡片里的位置（左上角为原点），列表窗口挂在它下面 */
  @ObservationIgnored var pillFrame: CGRect = .zero
  /** 列表打开、收起时通知控制器显示、收起列表窗口 */
  @ObservationIgnored var languagesChanged: ((Bool) -> Void)?

  /** 打开时停在当前语言上，和系统菜单一样 */
  func toggleLanguages(current: String) {
    if languagesOpen {
      closeLanguages()
    } else {
      languagesOpen = true
      languageHighlight = Languages.all.firstIndex { $0.code == current }
      languagesChanged?(true)
    }
  }

  func closeLanguages() {
    guard languagesOpen else { return }
    languagesOpen = false
    languageHighlight = nil
    languagesChanged?(false)
  }
}

struct TranslationCardView: View {
  static let width: CGFloat = 420
  static let cardBackground = Color.dynamic(light: 0xFFFFFF, dark: 0x1F2227)
  static let line = Color.dynamic(light: 0xE5E7EB, dark: 0x33373E)

  @Bindable var model: TranslateModel
  let state: CardState
  let close: () -> Void
  let togglePin: () -> Void
  let copy: () -> Void
  /** 卡片大小变了（译文出来、展开原文、换语言），控制器跟着调整面板 */
  let resized: (CGSize) -> Void
  @State private var sourceFullHeight: CGFloat = 0
  @State private var sourceShownHeight: CGFloat = 0

  var body: some View {
    VStack(spacing: 0) {
      header
      Rectangle().fill(Self.line).frame(height: 1)
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          source
          result
        }
      }
      .scrollBounceBehavior(.basedOnSize)
      .frame(maxHeight: state.maxBodyHeight)
      .fixedSize(horizontal: false, vertical: true)
      Rectangle().fill(Self.line).frame(height: 1)
      footer
    }
    .frame(width: Self.width)
    .coordinateSpace(.named("card"))
    .background(Self.cardBackground)
    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Self.line))
    // 列表开着时点卡片里别的地方（包括语言胶囊）收起列表
    .overlay {
      if state.languagesOpen { Color.clear.contentShape(Rectangle()).onTapGesture { state.closeLanguages() } }
    }
    // 不画键盘焦点框（系统开了键盘导航时，卡片一出来焦点就落在语言胶囊上）；键盘操作由控制器处理
    .focusEffectDisabled()
    // 按内容的理想高度显示；量出大小交给控制器调整面板
    .fixedSize(horizontal: false, vertical: true)
    .background(GeometryReader { g in
      Color.clear.onAppear { resized(g.size) }.onChange(of: g.size) { resized(g.size) }
    })
    .tint(.brand)
    // 卡片里换目标语言：只对这张卡片生效，立即重翻
    .onChange(of: model.target) { model.translateNow() }
  }

  // MARK: 顶部

  private var header: some View {
    HStack(spacing: 4) {
      Image(nsImage: StatusIcon.image(for: .none)).renderingMode(.template).foregroundStyle(.secondary)
      Text("翻译").font(.system(size: 15, weight: .semibold)).padding(.leading, 4)
      Spacer()
      Button { state.toggleLanguages(current: model.target) } label: { LanguagePill(name: Languages.name(model.target)) }
        .buttonStyle(.plain)
        .help("目标语言（⌘L），只对这张卡片生效")
        .background(GeometryReader { g in
          Color.clear
            .onAppear { state.pillFrame = g.frame(in: .named("card")) }
            .onChange(of: g.frame(in: .named("card"))) { _, frame in state.pillFrame = frame }
        })
      CardIconButton(systemImage: state.pinned ? "pin.fill" : "pin", active: state.pinned, help: state.pinned ? "取消固定（⌘P）" : "固定：点别处不关闭（⌘P）", action: togglePin)
      CardIconButton(systemImage: "xmark", help: "关闭（Esc）", action: close)
    }
    .padding(.leading, 14)
    .padding(.trailing, 8)
    .frame(height: 44)
  }

  // MARK: 原文：超过 3 行折叠

  private var source: some View {
    let truncated = sourceFullHeight > sourceShownHeight + 1
    return VStack(spacing: 0) {
      HStack(alignment: .top, spacing: 4) {
        Text(model.input)
          .font(.system(size: 14))
          .lineSpacing(3)
          .foregroundStyle(.secondary)
          .lineLimit(state.sourceExpanded ? nil : 3)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
          // 量一下完整的高度和现在显示的高度，判断是不是折叠了
          .background(GeometryReader { g in Color.clear.onAppear { sourceShownHeight = g.size.height }.onChange(of: g.size.height) { sourceShownHeight = g.size.height } })
          .background(
            Text(model.input).font(.system(size: 14)).lineSpacing(3).fixedSize(horizontal: false, vertical: true).hidden()
              .background(GeometryReader { g in Color.clear.onAppear { sourceFullHeight = g.size.height }.onChange(of: g.size.height) { sourceFullHeight = g.size.height } }),
            alignment: .top
          )
        if truncated || state.sourceExpanded {
          CardIconButton(systemImage: "chevron.down", help: state.sourceExpanded ? "收起原文" : "展开原文") {
            state.sourceExpanded.toggle()
          }
          .rotationEffect(.degrees(state.sourceExpanded ? 180 : 0))
        }
      }
      .padding(.top, 10)
      .padding(.bottom, 10)
      Rectangle().fill(Self.line).frame(height: 1)
    }
    .padding(.leading, 14)
    .padding(.trailing, 8)
  }

  // MARK: 译文

  @ViewBuilder
  private var result: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let problem = model.problem {
        Callout(systemImage: "exclamationmark.triangle.fill", color: .red, title: problem.title, detail: problem.detail)
      } else {
        ForEach(model.rows) { row in rowView(row) }
        HStack {
          CardIconButton(systemImage: state.copied ? "checkmark" : "doc.on.doc", active: state.copied, help: "复制译文（⌘C）", action: copy)
            .disabled(model.isTranslating || model.rows.isEmpty)
            .padding(.leading, -7)
          Spacer()
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 12)
    .padding(.bottom, 6)
  }

  @ViewBuilder
  private func rowView(_ row: TranslateModel.Row) -> some View {
    switch row.state {
    case .pending:
      Text(row.source).font(.system(size: 15)).lineSpacing(4).redacted(reason: .placeholder).modifier(Pulse())
    case let .done(text):
      Text(text).font(.system(size: 15)).lineSpacing(4).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    case let .failed(reason):
      VStack(alignment: .leading, spacing: 5) {
        Text(row.source).font(.system(size: 15)).lineSpacing(4).foregroundStyle(.secondary).textSelection(.enabled)
        Label("未翻译，已保留原文。\(reason)", systemImage: "exclamationmark.triangle.fill").font(.system(size: 11)).foregroundStyle(.orange)
      }
    }
  }

  // MARK: 底部

  private var footer: some View {
    HStack(spacing: 8) {
      HStack(spacing: 7) {
        Circle().fill(model.problem == nil ? Color.green : Color.red).frame(width: 7, height: 7)
        Text("Index-Translate-2B · 本机").font(.system(size: 12))
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 3)
      .fixedSize()
      .background(Capsule().strokeBorder(Self.line))
      Spacer()
      Text("Esc 关闭").font(.system(size: 11)).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, 14)
    .frame(height: 40)
  }
}

/** 卡片上的小图标按钮：30×30，鼠标移上去有浅底；active 时用品牌色 */
struct CardIconButton: View {
  let systemImage: String
  var active = false
  let help: String
  let action: () -> Void
  @State private var hover = false
  @Environment(\.isEnabled) private var isEnabled

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(active ? Color.brand : hover && isEnabled ? Color.primary : Color.secondary)
        .frame(width: 30, height: 30)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(hover && isEnabled ? 0.07 : 0)))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .opacity(isEnabled ? 1 : 0.4)
    .onHover { hover = $0 }
    .help(help)
  }
}

/**
 * 卡片的目标语言列表，样子照系统菜单，放在挂在卡片上的小窗口里（见 TranslationCardController.showLanguages）。
 * 不用系统菜单：别的 App 全屏时，系统菜单的窗口进不了那个全屏空间，点了看不到（2026-10-21 外接屏全屏 Chrome 上实测）；
 * 也不画在卡片里：卡片短时要撑高卡片，打开、收起都会闪
 */
struct CardLanguageList: View {
  static let width: CGFloat = 150
  static let rowHeight: CGFloat = 26
  static var height: CGFloat { CGFloat(Languages.all.count) * rowHeight + 10 }

  let selection: String
  let highlight: Int?
  let choose: (String) -> Void
  let hover: (Int?) -> Void

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(Languages.all.enumerated()), id: \.element.id) { i, language in
        let lit = highlight == i
        HStack(spacing: 6) {
          Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).opacity(language.code == selection ? 1 : 0)
          Text(language.name).font(.system(size: 13))
          Spacer(minLength: 0)
        }
        .foregroundStyle(lit ? Color.white : Color.primary)
        .padding(.horizontal, 8)
        .frame(height: Self.rowHeight)
        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(lit ? Color.brand : .clear))
        .contentShape(Rectangle())
        .onHover { inside in if inside { hover(i) } else if lit { hover(nil) } }
        .onTapGesture { choose(language.code) }
      }
    }
    .padding(5)
    .frame(width: Self.width)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(TranslationCardView.cardBackground))
    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(TranslationCardView.line))
  }
}

/** 列表窗口里的内容：当前语言、高亮变了就重画 */
private struct CardLanguageListHost: View {
  let model: TranslateModel
  let state: CardState
  let choose: (String) -> Void

  var body: some View {
    CardLanguageList(selection: model.target, highlight: state.languageHighlight, choose: choose) { state.languageHighlight = $0 }
  }
}


/** 卡片面板：无边框、不激活 App 也能接收键盘；Esc、⌘W、⌘C、⌘P、⌘L 交给控制器，语言列表开着时上下键、回车、Esc 先给列表 */
final class CardPanel: NSPanel {
  var onKey: ((NSEvent) -> Bool)?
  var onListKey: ((NSEvent) -> Bool)?

  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { false }

  override func sendEvent(_ event: NSEvent) {
    if event.type == .keyDown, onListKey?(event) == true { return }
    super.sendEvent(event)
  }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    if onKey?(event) == true { return true }
    return super.performKeyEquivalent(with: event)
  }

  override func cancelOperation(_ sender: Any?) {
    _ = onKey?(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!)
  }
}

@MainActor
final class TranslationCardController: NSObject {
  let model: TranslateModel
  let state = CardState()
  private var panel: CardPanel?
  /** 目标语言列表的小窗口，开着时是卡片的子窗口 */
  private var languagePanel: NSPanel?
  private var hosting: NSHostingView<TranslationCardView>?
  private var mouse: CGPoint = .zero
  private var screen: CGRect = .zero
  private var side: CardPlacement.Side = .below
  /** 卡片开着时监听：点卡片外面、切换 App */
  private var monitors: [Any] = []
  private var appSwitch: NSObjectProtocol?

  init(client: AitdClient) {
    model = TranslateModel(backend: client, target: Preferences.target)
  }

  var isVisible: Bool { panel?.isVisible ?? false }

  /** 在 mouse（屏幕坐标）旁边打开卡片翻 text；固定着的卡片原地换内容 */
  func show(text: String, at mouse: CGPoint) {
    let panel = self.panel ?? makePanel()
    let stay = state.pinned && panel.isVisible
    if !stay {
      self.mouse = mouse
      let screen = NSScreen.screens.first { NSMouseInRect(mouse, $0.frame, false) } ?? NSScreen.main
      self.screen = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 875)
      state.maxBodyHeight = CardPlacement.maxHeight(screen: self.screen) - 86
      side = CardPlacement.side(mouse: mouse, screen: self.screen, expected: 240)
      model.target = Preferences.target
    }
    state.sourceExpanded = false
    state.closeLanguages()
    state.copied = false
    model.source = "auto"
    model.input = text
    model.translateNow()
    if let hosting {
      hosting.layoutSubtreeIfNeeded()
      place(size: hosting.fittingSize)
    }

    panel.orderFrontRegardless()
    panel.makeKey()
    watchOutside()
  }

  func close() {
    stopWatching()
    guard let panel, panel.isVisible else { return }
    state.closeLanguages()
    panel.orderOut(nil)
    state.pinned = false
    model.reset()
  }

  /** 点卡片外面（别的 App 或本 App 的其他窗口）、切到别的 App 时关闭；固定时不关。点语言列表、弹出的菜单不算 */
  private func watchOutside() {
    guard monitors.isEmpty else { return }
    let clicks: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
    if let global = NSEvent.addGlobalMonitorForEvents(matching: clicks, handler: { [weak self] _ in
      MainActor.assumeIsolated { self?.outside() }
    }) {
      monitors.append(global)
    }
    if let local = NSEvent.addLocalMonitorForEvents(matching: clicks, handler: { [weak self] event in
      MainActor.assumeIsolated {
        guard let self, let window = event.window else { return }
        if window !== self.panel && window !== self.languagePanel && window.level < .popUpMenu { self.outside() }
      }
      return event
    }) {
      monitors.append(local)
    }
    appSwitch = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { [weak self] note in
      // 切到的是 AI Translate 自己（点了 Dock 图标等）不算：那种情况点窗口时会关
      let pid = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier
      MainActor.assumeIsolated {
        if pid != ProcessInfo.processInfo.processIdentifier { self?.outside() }
      }
    }
  }

  private func stopWatching() {
    for monitor in monitors { NSEvent.removeMonitor(monitor) }
    monitors = []
    if let appSwitch { NSWorkspace.shared.notificationCenter.removeObserver(appSwitch) }
    appSwitch = nil
  }

  private func outside() {
    state.closeLanguages()
    if !state.pinned { close() }
  }

  private func makePanel() -> CardPanel {
    let panel = CardPanel(
      contentRect: NSRect(x: 0, y: 0, width: TranslationCardView.width, height: 200),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isFloatingPanel = true
    panel.level = .floating
    panel.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.hidesOnDeactivate = false
    panel.isMovableByWindowBackground = true
    panel.isReleasedWhenClosed = false
    panel.onKey = { [weak self] event in self?.handleKey(event) ?? false }
    panel.onListKey = { [weak self] event in self?.handleListKey(event) ?? false }
    state.languagesChanged = { [weak self] open in open ? self?.showLanguages() : self?.hideLanguages() }
    let hosting = NSHostingView(rootView: TranslationCardView(
      model: model,
      state: state,
      close: { [weak self] in self?.close() },
      togglePin: { [weak self] in self?.state.pinned.toggle() },
      copy: { [weak self] in self?.copyAll() },
      // 在排版过程中被调到：下一拍再改面板大小
      resized: { [weak self] size in DispatchQueue.main.async { self?.place(size: size) } }
    ))
    hosting.sizingOptions = [.intrinsicContentSize]
    panel.contentView = hosting
    self.panel = panel
    self.hosting = hosting
    return panel
  }

  /** 按卡片大小摆位置：没固定时按鼠标位置算（不换边）；固定后保持顶边和左边不动（主人可能拖过） */
  private func place(size: CGSize) {
    guard let panel, size.width > 0, size.height > 0 else { return }
    var frame: CGRect
    if state.pinned && panel.isVisible {
      frame = CGRect(x: panel.frame.minX, y: panel.frame.maxY - size.height, width: size.width, height: size.height)
    } else {
      frame = CardPlacement.frame(size: size, mouse: mouse, screen: screen, side: side)
    }
    frame = frame.integral
    guard frame != panel.frame else { return }
    panel.setFrame(frame, display: true)
    panel.invalidateShadow()
    if state.languagesOpen { positionLanguages() }
  }

  /**
   * 打开语言列表：挂在卡片上的子窗口，在语言胶囊下面，可以超出卡片，卡片大小不变。
   * 和卡片一样设成能进别的 App 的全屏空间；不能成为键盘窗口，键盘还在卡片上（上下键、回车由 handleListKey 处理）
   */
  private func showLanguages() {
    guard let panel, panel.isVisible else { return }
    let list = languagePanel ?? makeLanguagePanel()
    positionLanguages()
    if list.parent == nil { panel.addChildWindow(list, ordered: .above) }
    list.orderFront(nil)
  }

  private func hideLanguages() {
    guard let list = languagePanel else { return }
    panel?.removeChildWindow(list)
    list.orderOut(nil)
  }

  /** 列表左边和语言胶囊对齐，顶边在胶囊下面 4pt；不出屏幕 */
  private func positionLanguages() {
    guard let panel, let list = languagePanel else { return }
    let pill = state.pillFrame
    var frame = CGRect(
      x: panel.frame.minX + pill.minX,
      y: panel.frame.maxY - pill.maxY - 4 - CardLanguageList.height,
      width: CardLanguageList.width,
      height: CardLanguageList.height
    )
    if let visible = panel.screen?.visibleFrame {
      frame.origin.x = CardPlacement.clamp(frame.minX, visible.minX + CardPlacement.margin, visible.maxX - CardPlacement.margin - frame.width)
      frame.origin.y = max(frame.minY, visible.minY + CardPlacement.margin)
    }
    list.setFrame(frame.integral, display: true)
  }

  private func makeLanguagePanel() -> NSPanel {
    let list = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: CardLanguageList.width, height: CardLanguageList.height),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    list.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
    list.isOpaque = false
    list.backgroundColor = .clear
    list.hasShadow = true
    list.hidesOnDeactivate = false
    list.isReleasedWhenClosed = false
    list.contentView = NSHostingView(rootView: CardLanguageListHost(model: model, state: state) { [weak self] code in self?.chooseLanguage(code) })
    languagePanel = list
    return list
  }

  private func handleKey(_ event: NSEvent) -> Bool {
    let flags = event.modifierFlags.intersection([.command, .option, .control, .shift])
    let key = event.charactersIgnoringModifiers?.lowercased()
    switch (flags, key) {
    case ([], _) where event.keyCode == 53, ([.command], "w"):
      close()
    case ([.command], "c"):
      copySelectionOrAll()
    case ([.command], "p"):
      state.pinned.toggle()
    case ([.command], "l"):
      state.toggleLanguages(current: model.target)
    default:
      return false
    }
    return true
  }

  /** ⌘C：选中了一部分文字就复制选中的，否则复制全部译文 */
  private func copySelectionOrAll() {
    if let text = panel?.firstResponder as? NSTextView, text.selectedRange().length > 0 {
      text.copy(nil)
    } else {
      copyAll()
    }
  }

  private func copyAll() {
    guard !model.rows.isEmpty, !model.isTranslating else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(model.output, forType: .string)
    state.copied = true
    Task {
      try? await Task.sleep(for: .seconds(1.5))
      state.copied = false
    }
  }

  /** 语言列表开着时：上下键移动、回车或空格选中、Esc 只收起列表；其他键照常 */
  private func handleListKey(_ event: NSEvent) -> Bool {
    guard state.languagesOpen else { return false }
    let last = Languages.all.count - 1
    switch event.keyCode {
    case 126:  // ↑
      state.languageHighlight = max(0, (state.languageHighlight ?? last + 1) - 1)
    case 125:  // ↓
      state.languageHighlight = min(last, (state.languageHighlight ?? -1) + 1)
    case 36, 76, 49:  // 回车、小键盘回车、空格
      if let i = state.languageHighlight { chooseLanguage(Languages.all[i].code) }
    case 53:  // Esc
      state.closeLanguages()
    default:
      return false
    }
    return true
  }

  /** 换目标语言：只改这张卡片（视图里 onChange 会立即重翻），不改设置里的默认值 */
  private func chooseLanguage(_ code: String) {
    model.target = code
    state.closeLanguages()
  }

  /** 调试用：等翻译结束后把卡片存成 PNG */
  func snapshot(to path: String) {
    Task {
      for _ in 0..<150 where model.isTranslating {
        try? await Task.sleep(for: .milliseconds(200))
      }
      try? await Task.sleep(for: .milliseconds(500))
      guard let view = panel?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
      // 语言列表开着时另存一张：<名字>-languages.png
      if let list = languagePanel?.contentView, languagePanel?.isVisible == true, let listRep = list.bitmapImageRepForCachingDisplay(in: list.bounds) {
        list.cacheDisplay(in: list.bounds, to: listRep)
        let listPath = (path as NSString).deletingPathExtension + "-languages.png"
        try? listRep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: listPath))
      }
    }
  }
}
