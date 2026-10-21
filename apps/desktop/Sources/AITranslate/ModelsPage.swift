// 设置里的「模型」页（Goal 8）：列出 Index-Translate-2B 的量化版本（Hugging Face 上的和本机已有的），
// 下载（进度、取消、接着下、校验）、设为当前（交给 aitd，等正在翻的段落翻完再换）、删除（先确认，正在用的删不了）。
// 下载由 App 自己做（aitd 不访问外网），关掉设置窗口也接着下。
import AITranslateKit
import AppKit
import SwiftUI

struct ModelsPage: View {
  let model: ModelsModel
  @State private var endpointDraft = ""

  var body: some View {
    SettingsSection("本机的版本", footer: "切换时等正在翻的段落翻完再换，一般几秒；插件、命令行和桌面应用一起换，重启后保留。") {
      if let problem = model.serviceProblem {
        Callout(systemImage: "exclamationmark.triangle.fill", color: .red, title: "连不上翻译服务，切换、删除暂时用不了", detail: problem)
          .padding(.bottom, 12)
      }
      if let local = model.local, local.pinned {
        Callout(systemImage: "lock.fill", color: .orange, title: "量化版本由环境变量 AIT_QUANT 固定为 \(local.current)", detail: "去掉 AIT_QUANT 后重启翻译服务，才能在这里切换")
          .padding(.bottom, 12)
      }
      if installed.isEmpty { placeholder(model.refreshing ? "正在读取…" : "本机还没有模型文件") }
      ForEach(installed) { row in ModelRowView(row: row, model: model) }
    }
    SettingsSection("可以下载", footer: "只有 Q8_0、Q4_K_M 评测过译文质量（盲评打平）；文件越小越快、越省内存，质量可能下降。一次下一个，关掉设置窗口也接着下；取消后再点「继续下载」从断开的地方接着下。") {
      if downloadable.isEmpty { placeholder(model.refreshing ? "正在读取版本列表…" : model.remoteProblem == nil ? "都下载过了" : "读不到版本列表，见下面的下载地址") }
      ForEach(downloadable) { row in ModelRowView(row: row, model: model) }
    }
    SettingsSection("下载设置", footer: "从 Hugging Face 的 \(ModelSource.repo) 下载，走系统网络设置（系统代理自动生效），下完按 sha256 校验；只下模型文件，不发送任何翻译内容。访问不了时可以换成镜像地址，如 https://hf-mirror.com。") {
      SettingsRow("下载地址", caption: endpointCaption, captionColor: endpointCaptionColor) {
        HStack(spacing: 8) {
          TextField("https://huggingface.co", text: $endpointDraft)
            .textFieldStyle(.roundedBorder)
            .frame(width: 240)
            .onSubmit(applyEndpoint)
          Button("应用", action: applyEndpoint)
            .buttonStyle(SoftButtonStyle())
            .disabled(endpointDraft == model.endpointText || ModelSource.endpoint(endpointDraft) == nil)
        }
      }
      SettingsRow("剩余空间", caption: lowSpace ? "空间不多了：下载时至少要多留 500 MB" : nil, captionColor: .orange) {
        Text(model.freeSpace.map(formatBytes) ?? "—").font(.system(size: 13)).foregroundStyle(.secondary)
      }
    }
    .task {
      endpointDraft = model.endpointText
      await model.refresh()
    }
  }

  /** 本机已有的：在用的排最前，其余按大小 */
  private var installed: [ModelRow] {
    model.rows.filter { $0.state == .inUse || $0.state == .downloaded }.sorted { ($0.state == .inUse ? 0 : 1, $0.size) < ($1.state == .inUse ? 0 : 1, $1.size) }
  }

  /** 还没下的、正在下的、下到一半的 */
  private var downloadable: [ModelRow] {
    model.rows.filter { $0.state != .inUse && $0.state != .downloaded }
  }

  private func placeholder(_ text: String) -> some View {
    HStack(spacing: 8) {
      if model.refreshing { ProgressView().controlSize(.small) }
      Text(text).font(.system(size: 13)).foregroundStyle(.secondary)
    }
    .padding(.vertical, 14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .top) { Divider() }
  }

  private var endpointCaption: String? {
    if ModelSource.endpoint(endpointDraft) == nil { return "要 https 开头，如 https://huggingface.co" }
    return model.remoteProblem
  }

  private var endpointCaptionColor: Color {
    ModelSource.endpoint(endpointDraft) == nil || model.remoteProblem != nil ? .red : .secondary
  }

  private var lowSpace: Bool { (model.freeSpace ?? .max) < 3_000_000_000 }

  private func applyEndpoint() {
    guard ModelSource.endpoint(endpointDraft) != nil else { return }
    model.endpointText = endpointDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    Task { await model.refresh() }
  }
}

/** 一个版本一行：名字、说明（出错时是原因）、大小，右边是按状态变的操作 */
struct ModelRowView: View {
  let row: ModelRow
  let model: ModelsModel

  var body: some View {
    HStack(alignment: .center, spacing: 14) {
      VStack(alignment: .leading, spacing: 4) {
        Text(row.quant).font(.system(size: 14, weight: .medium))
        if let error = model.errors[row.quant] {
          Text(error).font(.system(size: 12)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        } else if let note = row.note {
          Text(note).font(.system(size: 12)).foregroundStyle(.secondary)
        }
      }
      Spacer(minLength: 8)
      Text(formatBytes(row.size)).font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit()
      actions.frame(width: 210, alignment: .trailing)
    }
    .padding(.vertical, 10)
    .frame(minHeight: 52)
    .overlay(alignment: .top) { Divider() }
  }

  @ViewBuilder private var actions: some View {
    let busy = model.switching != nil
    let serviceDown = model.serviceProblem != nil
    if model.switching == row.quant {
      HStack(spacing: 6) {
        ProgressView().controlSize(.small)
        Text("切换中…").font(.system(size: 12)).foregroundStyle(.secondary)
      }
    } else {
      switch row.state {
      case .inUse:
        Label("正在用", systemImage: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(.green)
      case .downloaded:
        HStack(spacing: 4) {
          Button("设为当前") { Task { await model.use(row.quant) } }
            .buttonStyle(SoftButtonStyle(prominent: true))
            .disabled(busy || serviceDown || model.local?.pinned == true)
          CardIconButton(systemImage: "trash", help: "删除这个版本的文件") { confirmDelete() }
            .disabled(busy || serviceDown)
        }
      case let .downloading(done):
        HStack(spacing: 8) {
          ProgressView(value: row.progress ?? 0).frame(width: 90)
          Text(percent(done)).font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit().frame(width: 34, alignment: .trailing)
          Button("取消") { model.cancel(row.quant) }.buttonStyle(SoftButtonStyle())
        }
      case .verifying:
        HStack(spacing: 6) {
          ProgressView().controlSize(.small)
          Text("校验中…").font(.system(size: 12)).foregroundStyle(.secondary)
        }
      case let .paused(done):
        HStack(spacing: 4) {
          Text("已下 \(percent(done))").font(.system(size: 12)).foregroundStyle(.secondary).monospacedDigit()
          Button("继续下载") { model.download(row.quant) }
            .buttonStyle(SoftButtonStyle())
            .disabled(model.downloading != nil || model.endpoint == nil)
          CardIconButton(systemImage: "trash", help: "删掉下到一半的文件") { confirmDelete() }
        }
      case .available:
        Button("下载") { model.download(row.quant) }
          .buttonStyle(SoftButtonStyle())
          .disabled(model.downloading != nil || model.endpoint == nil)
          .help(model.downloading != nil ? "一次下一个，等 \(model.downloading ?? "") 下完" : "下载 \(formatBytes(row.size))")
      }
    }
  }

  private func percent(_ done: Int64) -> String {
    row.size > 0 ? "\(Int(Double(done) / Double(row.size) * 100))%" : "0%"
  }

  /** 删除前确认：说清删的是什么、多大 */
  private func confirmDelete() {
    let alert = NSAlert()
    if case .paused = row.state {
      alert.messageText = "删掉 \(row.quant) 下到一半的文件？"
      alert.informativeText = "删掉后要从头下载。"
    } else {
      alert.messageText = "删除 \(row.quant)？"
      alert.informativeText = "会删掉 \(formatBytes(row.size)) 的模型文件，以后要用得重新下载。"
    }
    alert.alertStyle = .warning
    alert.addButton(withTitle: "删除").hasDestructiveAction = true
    alert.addButton(withTitle: "取消")
    if alert.runModal() == .alertFirstButtonReturn {
      Task { await model.delete(row.quant) }
    }
  }
}
