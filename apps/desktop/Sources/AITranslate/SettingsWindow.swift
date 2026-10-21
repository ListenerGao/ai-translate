// 设置窗口：左边菜单、右边内容（主人 2026-10-20 要求，参考微信的设置窗口）。
// 通用（默认翻译成、登录时打开）、快捷键（改键、辅助功能权限）、术语表（读写 aitd，和插件、命令行同一份）、翻译服务（状态、模型、缓存、重启）、
// 模型（量化版本的下载、切换、删除，Goal 8，见 ModelsPage.swift）、关于（和关于窗口同一份内容，主人 2026-10-20 要求加）。
import AITranslateKit
import AppKit
import Observation
import SwiftUI

enum SettingsPage: String, CaseIterable, Identifiable {
  case general, shortcuts, glossary, service, models, about

  var id: Self { self }

  var title: String {
    switch self {
    case .general: "通用"
    case .shortcuts: "快捷键"
    case .glossary: "术语表"
    case .service: "翻译服务"
    case .models: "模型"
    case .about: "关于"
    }
  }

  var icon: String {
    switch self {
    case .general: "gearshape"
    case .shortcuts: "command"
    case .glossary: "character.book.closed"
    case .service: "server.rack"
    case .models: "cube"
    case .about: "info.circle"
    }
  }
}

/** 当前在哪一页：打开窗口时可以指定 */
@MainActor
@Observable
final class SettingsNavigation {
  var page: SettingsPage = .general
}

struct SettingsView: View {
  static let size = NSSize(width: 760, height: 560)

  @Bindable var model: SettingsModel
  let models: ModelsModel
  let login: LoginItem
  let recorder: HotKeyRecorder
  let navigation: SettingsNavigation
  let targetChanged: (String) -> Void
  let restartService: () -> Void
  @State private var target = Preferences.target
  @State private var trusted = SelectionCapture.isTrusted

  var body: some View {
    HStack(spacing: 0) {
      sidebar
      Group {
        if navigation.page == .about {
          // 关于：图标、名字、版本、说明、Made by，居中显示
          AboutView().frame(maxWidth: .infinity, maxHeight: .infinity).padding(.bottom, 24)
        } else {
          ScrollView {
            VStack(alignment: .leading, spacing: 36) {
              switch navigation.page {
              case .general: general
              case .shortcuts: shortcuts
              case .glossary: glossary
              case .models: ModelsPage(model: models)
              case .service, .about: service
              }
            }
            .padding(.horizontal, 40)
            // 第一个分组标题和左边第一个菜单项对齐
            .padding(.top, 54)
            .padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .leading)
          }
          .scrollIndicators(.automatic)
        }
      }
      .background(Color.settingsContent)
    }
    .frame(minWidth: Self.size.width, maxWidth: .infinity, minHeight: Self.size.height, maxHeight: .infinity)
    // 左边菜单一直铺到标题栏（只留左上角的关闭按钮）
    .ignoresSafeArea()
    .tint(.brand)
    .toggleStyle(.switch)
  }

  // MARK: 左边菜单

  private var sidebar: some View {
    VStack(spacing: 0) {
      ForEach(SettingsPage.allCases) { page in
        let selected = navigation.page == page
        Button {
          recorder.stop()
          navigation.page = page
        } label: {
          HStack(spacing: 12) {
            Image(systemName: page.icon).font(.system(size: 16)).frame(width: 22)
            Text(page.title).font(.system(size: 14, weight: selected ? .medium : .regular))
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 20)
          .frame(height: 40)
          .foregroundStyle(selected ? Color.white : Color.primary)
          .background(selected ? Color.brand : Color.clear)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // 不画键盘焦点框：选中的那项已经是品牌色底
        .focusEffectDisabled()
      }
      Spacer()
    }
    .padding(.top, 44)
    .frame(width: 168)
    .frame(maxHeight: .infinity)
    .background(Color.settingsSidebar)
  }

  // MARK: 通用

  @ViewBuilder private var general: some View {
    SettingsSection("翻译") {
      SettingsRow("默认翻译成", caption: "翻译窗口和划词翻译默认翻成这种语言") {
        Picker("默认翻译成", selection: $target) {
          ForEach(Languages.all) { Text($0.name).tag($0.code) }
        }
        .labelsHidden()
        .fixedSize()
        .onChange(of: target) {
          Preferences.target = target
          targetChanged(target)
        }
      }
    }
    SettingsSection("启动") {
      SettingsRow("登录时自动打开 AI Translate", caption: loginCaption?.text, captionColor: loginCaption?.color ?? .secondary) {
        Toggle("登录时自动打开 AI Translate", isOn: Binding(get: { login.enabled }, set: { login.set($0) }))
          .labelsHidden()
          .disabled(!LoginItem.isInstalled)
      }
    }
  }

  private var loginCaption: (text: String, color: Color)? {
    if let error = login.error { return (error, .red) }
    if !LoginItem.isInstalled { return ("装到「应用程序」文件夹后才能设置：在项目目录运行 scripts/install-desktop.sh install", .secondary) }
    if login.needsApproval { return ("还要在「系统设置 → 通用 → 登录项」里允许", .orange) }
    return nil
  }

  // MARK: 快捷键

  @ViewBuilder private var shortcuts: some View {
    SettingsSection("全局快捷键", footer: "点组合键后按新的组合键，Esc 取消；鼠标移到组合键上点 × 清空，清空后不再生效。要带 ⌃ 或 ⌥。") {
      ForEach(HotKeyAction.allCases, id: \.self) { action in
        SettingsRow(action.title, caption: recorder.message(for: action) ?? recorder.hotKeys.problems[action], captionColor: .red) {
          HStack(spacing: 10) {
            ShortcutField(action: action, recorder: recorder)
            Button("恢复默认") { recorder.reset(action) }
              .buttonStyle(SoftButtonStyle())
              .disabled(recorder.hotKeys.combos[action] == action.defaultCombo && recorder.hotKeys.problems[action] == nil)
          }
        }
      }
    }
    SettingsSection("权限") {
      SettingsRow("辅助功能", caption: "划词翻译要读取别的 App 里选中的文字：只在按快捷键时读一次，只发给本机的翻译服务，不记录。打开翻译窗口不需要这个权限。") {
        if trusted {
          Label("已打开", systemImage: "checkmark.circle.fill").font(.system(size: 13)).foregroundStyle(.green)
        } else {
          Button("打开系统设置") { AccessibilityPrompt.openSettings() }.buttonStyle(SoftButtonStyle(prominent: true))
        }
      }
    }
    .task {
      // 主人在系统设置里打开后这里跟着变
      while !Task.isCancelled {
        trusted = SelectionCapture.isTrusted
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  // MARK: 术语表

  @ViewBuilder private var glossary: some View {
    SettingsSection("我的术语", footer: "一行一条「原文=译文」，# 开头的行是注释，写错的行不让保存。存在本机翻译服务 aitd 里，插件、命令行、桌面应用共用；只有段落里出现的术语才会发给模型。") {
      VStack(alignment: .trailing, spacing: 10) {
        TextEditor(text: $model.glossaryText)
          .font(.system(size: 13))
          .frame(height: 190)
          .scrollContentBackground(.hidden)
          .padding(6)
          .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(nsColor: .textBackgroundColor)))
          .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
          .overlay(alignment: .topLeading) {
            if model.glossaryLoaded && model.glossaryText.isEmpty {
              Text("一行一条，例如：\nprompt=提示词\nmockup=原型图")
                .font(.system(size: 13))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
                .allowsHitTesting(false)
            }
          }
          .disabled(!model.glossaryLoaded)
        if !model.glossaryErrors.isEmpty {
          VStack(alignment: .leading, spacing: 3) {
            ForEach(model.glossaryErrors, id: \.line) { e in
              Label("第 \(e.line) 行：\(e.message)", systemImage: "exclamationmark.circle.fill").font(.caption).foregroundStyle(.red)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        HStack(spacing: 10) {
          if let message = model.glossaryMessage {
            Text(message).font(.system(size: 12)).foregroundStyle(model.glossaryErrors.isEmpty && model.glossaryLoaded ? Color.secondary : Color.red)
          }
          Spacer()
          Button("还原") { model.revert() }.buttonStyle(SoftButtonStyle()).disabled(!model.isDirty)
          Button("保存") { Task { await model.save() } }
            .buttonStyle(SoftButtonStyle(prominent: true))
            .disabled(!model.isDirty || model.saving)
            .keyboardShortcut("s", modifiers: .command)
        }
      }
      .padding(.top, 14)
      .overlay(alignment: .top) { Divider() }
    }
    SettingsSection("内置术语", footer: "一直生效；自己写了同一个原文时以自己的为准。") {
      Text(SettingsModel.builtinGlossary.replacingOccurrences(of: "、", with: "\n"))
        .font(.system(size: 13))
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .lineSpacing(4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 12)
        .overlay(alignment: .top) { Divider() }
    }
  }

  // MARK: 翻译服务

  @ViewBuilder private var service: some View {
    SettingsSection("本机翻译服务 aitd") {
      SettingsRow("状态", caption: model.status == nil ? model.service.detail : nil) {
        HStack(spacing: 6) {
          Circle().fill(statusColor).frame(width: 8, height: 8)
          Text(model.service.title).font(.system(size: 13))
        }
      }
      if let status = model.status {
        SettingsRow("模型") { value("Index-Translate-2B · \(status.model.quant ?? "")") }
        SettingsRow("版本") { value("aitd \(status.version)") }
        SettingsRow("缓存和队列") { value("缓存 \(status.cache.entries) 条 · 排队 \(status.queue.pending)，进行中 \(status.queue.active)") }
      }
      HStack(spacing: 10) {
        Spacer()
        Button("刷新") { Task { await model.refreshService() } }.buttonStyle(SoftButtonStyle())
        Button("重启翻译服务", action: restartService).buttonStyle(SoftButtonStyle())
      }
      .padding(.vertical, 14)
      .overlay(alignment: .top) { Divider() }
    }
  }

  private func value(_ text: String) -> some View {
    Text(text).font(.system(size: 13)).foregroundStyle(.secondary).textSelection(.enabled)
  }

  private var statusColor: Color {
    switch model.service.badge {
    case .none: .green
    case .busy: .orange
    case .problem: .red
    }
  }
}

/** 快捷键按钮：点一下录新的组合键；鼠标移上去时右边出现 ×，点 × 清空（主人 2026-10-21 要求） */
struct ShortcutField: View {
  let action: HotKeyAction
  let recorder: HotKeyRecorder
  @State private var hover = false

  var body: some View {
    let combo = recorder.hotKeys.combos[action]
    let recording = recorder.recording == action
    Button(recording ? "按下组合键…" : combo?.display ?? "未设置") {
      if recording { recorder.stop() } else { recorder.start(action) }
    }
    .buttonStyle(SoftButtonStyle(prominent: recording, width: 112))
    .overlay(alignment: .trailing) {
      if hover, combo != nil, !recording {
        Button {
          recorder.clear(action)
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 13))
            .foregroundStyle(.secondary)
            .frame(width: 24, height: 24)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("清空")
        .padding(.trailing, 3)
      }
    }
    .onHover { hover = $0 }
  }
}

// MARK: 设置页的排版：分组标题、一行一项（左边名字和说明，右边控件）、每行上方一条细线（第一行的就是标题下面那条）

struct SettingsSection<Content: View>: View {
  let title: String
  var footer: String?
  @ViewBuilder var content: Content

  init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.footer = footer
    self.content = content()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).font(.system(size: 15, weight: .semibold)).padding(.bottom, 12)
      content
      if let footer {
        Text(footer)
          .font(.system(size: 12))
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.top, 8)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct SettingsRow<Control: View>: View {
  let title: String
  var caption: String?
  var captionColor: Color = .secondary
  @ViewBuilder var control: Control

  init(_ title: String, caption: String? = nil, captionColor: Color = .secondary, @ViewBuilder control: () -> Control) {
    self.title = title
    self.caption = caption
    self.captionColor = captionColor
    self.control = control()
  }

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      VStack(alignment: .leading, spacing: 4) {
        Text(title).font(.system(size: 14))
        if let caption {
          Text(caption).font(.system(size: 12)).foregroundStyle(captionColor).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        }
      }
      Spacer(minLength: 12)
      // 右边的按钮、开关不压缩（不出现省略号），左边的说明文字换行
      control.fixedSize()
    }
    .padding(.vertical, 12)
    .frame(minHeight: 52)
    .overlay(alignment: .top) { Divider() }
  }
}

/** 浅灰底、无边框的圆角按钮（参考微信设置）；prominent 是品牌色底白字 */
struct SoftButtonStyle: ButtonStyle {
  var prominent = false
  var width: CGFloat?
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .medium))
      .lineLimit(1)
      .frame(width: width)
      .padding(.horizontal, width == nil ? 14 : 0)
      .frame(height: 28)
      .foregroundStyle(prominent ? Color.white : Color.primary)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(prominent ? Color.brand : Color.primary.opacity(configuration.isPressed ? 0.14 : 0.07))
          .opacity(prominent && configuration.isPressed ? 0.85 : 1)
      )
      .opacity(isEnabled ? 1 : 0.4)
      .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
  }
}

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
  let model: SettingsModel
  let models: ModelsModel
  let login = LoginItem()
  let recorder: HotKeyRecorder
  let navigation = SettingsNavigation()
  private let client: AitdClient
  private var window: NSWindow?
  private let targetChanged: (String) -> Void

  init(client: AitdClient, hotKeys: HotKeyModel, models: ModelsModel, targetChanged: @escaping (String) -> Void) {
    self.client = client
    self.models = models
    model = SettingsModel(backend: client)
    recorder = HotKeyRecorder(hotKeys: hotKeys)
    self.targetChanged = targetChanged
  }

  /** 打开设置；page 指定打开哪一页，不给就停在上次那页 */
  func show(page: SettingsPage? = nil) {
    if let page { navigation.page = page }
    let window = self.window ?? makeWindow()
    login.refresh()
    Task { await model.load() }
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(origin: .zero, size: SettingsView.size),
      styleMask: [.titled, .closable, .fullSizeContentView],
      backing: .buffered,
      defer: false,
    )
    window.title = "AI Translate 设置"
    // 不显示标题和标题栏，左上角只留关闭按钮（参考微信的设置窗口）
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.isMovableByWindowBackground = true
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true
    window.contentView = NSHostingView(rootView: SettingsView(
      model: model,
      models: models,
      login: login,
      recorder: recorder,
      navigation: navigation,
      targetChanged: targetChanged,
      restartService: { [weak self] in self?.restartService() },
    ))
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("Settings")
    self.window = window
    return window
  }

  /** 点到别的窗口或关掉设置时结束录快捷键，免得全局快捷键一直停用 */
  func windowDidResignKey(_ notification: Notification) {
    recorder.stop()
  }

  /** 术语表改了没保存：关窗口前问一下 */
  func windowShouldClose(_ sender: NSWindow) -> Bool {
    guard model.isDirty else { return true }
    let alert = NSAlert()
    alert.messageText = "术语表改了还没保存"
    alert.informativeText = "关掉设置窗口会丢掉这些改动。"
    alert.addButton(withTitle: "保存")
    alert.addButton(withTitle: "不保存")
    alert.addButton(withTitle: "取消")
    switch alert.runModal() {
    case .alertFirstButtonReturn:
      Task {
        await model.save()
        if !model.isDirty { sender.close() }
      }
      return false
    case .alertSecondButtonReturn:
      model.revert()
      return true
    default:
      return false
    }
  }

  /** 重启翻译服务并马上加载模型；加载要几秒，期间每秒刷新一次状态，直到回到「运行中」 */
  private func restartService() {
    Task {
      let result = await AitdService.restartAndLoad(client)
      await model.refreshService()
      switch result {
      case .loading:
        for _ in 0..<10 {
          if case .running = model.service { break }
          try? await Task.sleep(for: .seconds(1))
          await model.refreshService()
        }
      case .notInstalled, .notResponding:
        let alert = NSAlert()
        alert.messageText = result == .notInstalled ? "没有安装开机自启" : "翻译服务重启后没有响应"
        alert.informativeText = result == .notInstalled ? ServiceState.startHint : "看 ~/Library/Application Support/ai-translate/logs/launchd.log"
        alert.runModal()
      }
    }
  }

  /** 调试用：读完术语表和服务状态后把设置窗口存成 PNG */
  /** 调试用：把设置窗口存成 PNG；fullPage 时只存右边内容、整页（包括要滚动才看得到的部分） */
  func snapshot(to path: String, fullPage: Bool = false) {
    Task {
      for _ in 0..<50 where model.service == .checking || !model.glossaryLoaded && model.glossaryMessage == nil {
        try? await Task.sleep(for: .milliseconds(200))
      }
      try? await Task.sleep(for: .milliseconds(fullPage ? 1500 : 400))
      let page = fullPage ? Self.scrollView(in: window?.contentView)?.documentView : nil
      guard let view = page ?? window?.contentView?.superview ?? window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
  }

  private static func scrollView(in view: NSView?) -> NSScrollView? {
    guard let view else { return nil }
    if let scroll = view as? NSScrollView { return scroll }
    return view.subviews.lazy.compactMap { scrollView(in: $0) }.first
  }
}
