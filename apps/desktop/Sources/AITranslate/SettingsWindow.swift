// 设置窗口：通用（默认翻译成、登录时打开）、术语表（读写 aitd，和插件、命令行同一份）、翻译服务（状态、版本、模型、缓存、重启）。
import AITranslateKit
import AppKit
import SwiftUI

struct SettingsView: View {
  @Bindable var model: SettingsModel
  let login: LoginItem
  let targetChanged: (String) -> Void
  let restartService: () -> Void
  @State private var target = Preferences.target

  var body: some View {
    Form {
      general
      glossary
      service
    }
    .formStyle(.grouped)
    .frame(width: 580)
    .frame(minHeight: 640)
    .tint(.brand)
  }

  private var general: some View {
    Section("通用") {
      Picker("默认翻译成", selection: $target) {
        ForEach(Languages.all) { Text($0.name).tag($0.code) }
      }
      .onChange(of: target) {
        Preferences.target = target
        targetChanged(target)
      }
      VStack(alignment: .leading, spacing: 4) {
        Toggle("登录时自动打开 AI Translate", isOn: Binding(get: { login.enabled }, set: { login.set($0) }))
          .disabled(!LoginItem.isInstalled)
        if !LoginItem.isInstalled {
          Text("装到「应用程序」文件夹后才能设置：在项目目录运行 scripts/install-desktop.sh install").font(.caption).foregroundStyle(.secondary)
        } else if login.needsApproval {
          Text("还要在「系统设置 → 通用 → 登录项」里允许").font(.caption).foregroundStyle(.orange)
        }
        if let error = login.error { Text(error).font(.caption).foregroundStyle(.red) }
      }
    }
  }

  private var glossary: some View {
    Section {
      TextEditor(text: $model.glossaryText)
        .font(.system(size: 13))
        .frame(height: 150)
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
      }
      HStack(spacing: 10) {
        if let message = model.glossaryMessage {
          Text(message).font(.caption).foregroundStyle(model.glossaryErrors.isEmpty && model.glossaryLoaded ? Color.secondary : Color.red)
        }
        Spacer()
        Button("还原") { model.revert() }.disabled(!model.isDirty)
        Button("保存") { Task { await model.save() } }
          .buttonStyle(.borderedProminent)
          .disabled(!model.isDirty || model.saving)
          .keyboardShortcut("s", modifiers: .command)
      }
    } header: {
      Text("术语表")
    } footer: {
      Text("一行一条「原文=译文」，# 开头的行是注释，写错的行不让保存。术语表存在本机翻译服务 aitd 里，插件、命令行、桌面应用共用；只有段落里出现的术语才会发给模型。另有 4 条内置术语一直生效：\(SettingsModel.builtinGlossary)；自己写了同一个原文时以自己的为准。")
        .font(.caption)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var service: some View {
    Section("翻译服务") {
      LabeledContent("状态") {
        HStack(spacing: 6) {
          Circle().fill(statusColor).frame(width: 8, height: 8)
          Text(model.service.title)
        }
      }
      if model.status == nil, let detail = model.service.detail {
        Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
      }
      if let status = model.status {
        LabeledContent("模型", value: "Index-Translate-2B · \(status.model.quant ?? "")（aitd \(status.version)）")
        LabeledContent("缓存和队列", value: "缓存 \(status.cache.entries) 条 · 排队 \(status.queue.pending)，进行中 \(status.queue.active)")
      }
      HStack {
        Spacer()
        Button("刷新") { Task { await model.refreshService() } }
        Button("重启翻译服务", action: restartService)
      }
    }
  }

  private var statusColor: Color {
    switch model.service.badge {
    case .none: .green
    case .busy: .orange
    case .problem: .red
    }
  }
}

@MainActor
final class SettingsWindowController: NSObject, NSWindowDelegate {
  let model: SettingsModel
  let login = LoginItem()
  private let client: AitdClient
  private var window: NSWindow?
  private let targetChanged: (String) -> Void

  init(client: AitdClient, targetChanged: @escaping (String) -> Void) {
    self.client = client
    model = SettingsModel(backend: client)
    self.targetChanged = targetChanged
  }

  func show() {
    let window = self.window ?? makeWindow()
    login.refresh()
    Task { await model.load() }
    NSApp.activate()
    window.makeKeyAndOrderFront(nil)
  }

  private func makeWindow() -> NSWindow {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 580, height: 780),
      styleMask: [.titled, .closable, .resizable],
      backing: .buffered,
      defer: false,
    )
    window.title = "AI Translate 设置"
    window.contentView = NSHostingView(rootView: SettingsView(
      model: model,
      login: login,
      targetChanged: targetChanged,
      restartService: { [weak self] in self?.restartService() },
    ))
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("SettingsWindow")
    self.window = window
    return window
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
  func snapshot(to path: String) {
    Task {
      for _ in 0..<50 where model.service == .checking || !model.glossaryLoaded && model.glossaryMessage == nil {
        try? await Task.sleep(for: .milliseconds(200))
      }
      try? await Task.sleep(for: .milliseconds(400))
      guard let view = window?.contentView?.superview ?? window?.contentView, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
      view.cacheDisplay(in: view.bounds, to: rep)
      try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: path))
    }
  }
}
