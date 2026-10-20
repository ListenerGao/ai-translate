// 文件翻译卡片：盖在翻译窗口上。准备（双语开关、输出位置，已存在时问覆盖或另存）→ 翻译中（进度，可取消）→ 写好了（在访达中显示）/ 出错了。
import AITranslateKit
import AppKit
import SwiftUI

/** 窗口当前的文件翻译任务；没有任务时为 nil */
@MainActor
@Observable
final class FileJobHolder {
  var job: FileJob?
}

struct FileJobCard: View {
  @Bindable var job: FileJob
  let targetName: String
  let start: () -> Void
  let close: () -> Void

  var body: some View {
    ZStack {
      Color.black.opacity(0.22).ignoresSafeArea()
      VStack(alignment: .leading, spacing: 18) {
        header
        switch job.phase {
        case .ready: ready
        case let .translating(done, total): translating(done, total)
        case let .finished(failed, empty): finished(failed, empty)
        case let .failed(error): failure(error)
        }
      }
      .padding(22)
      .frame(width: 470, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(nsColor: .windowBackgroundColor)))
      .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
      .shadow(color: .black.opacity(0.25), radius: 24, y: 10)
      .controlSize(.large)
    }
  }

  private var header: some View {
    HStack(spacing: 12) {
      RoundedRectangle(cornerRadius: 10, style: .continuous)
        .fill(Color.brand.gradient)
        .frame(width: 42, height: 42)
        .overlay {
          Image(systemName: job.format == .srt ? "captions.bubble" : "doc.text")
            .font(.system(size: 19, weight: .medium))
            .foregroundStyle(.white)
        }
      VStack(alignment: .leading, spacing: 3) {
        Text(job.source.lastPathComponent).font(.system(size: 15, weight: .semibold)).lineLimit(1).truncationMode(.middle)
        Text("\(job.format.label) · 翻译成\(targetName)").font(.system(size: 12)).foregroundStyle(.secondary)
      }
      Spacer(minLength: 0)
    }
  }

  @ViewBuilder
  private var ready: some View {
    VStack(spacing: 10) {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          Text("双语").font(.system(size: 13, weight: .medium))
          Text(job.format == .srt ? "原文在上、译文在下" : "每段原文后面接译文").font(.system(size: 11)).foregroundStyle(.secondary)
        }
        Spacer()
        Toggle("双语", isOn: $job.bilingual).toggleStyle(.switch).labelsHidden().controlSize(.small)
          .onChange(of: job.bilingual) { UserDefaults.standard.set(job.bilingual, forKey: "bilingual") }
      }
      .modifier(GroupFill())
      HStack(alignment: .top, spacing: 10) {
        Image(systemName: "arrow.down.doc").foregroundStyle(.secondary).font(.system(size: 15))
        VStack(alignment: .leading, spacing: 3) {
          Text("译文写到 \(job.output.lastPathComponent)").font(.system(size: 13, weight: .medium))
          Text(job.output.deletingLastPathComponent().path).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
          if job.outputExists {
            Label("这个文件已经存在，开始后会覆盖", systemImage: "exclamationmark.circle.fill").font(.system(size: 11)).foregroundStyle(.orange)
          }
        }
      }
      .modifier(GroupFill())
    }
    HStack(spacing: 10) {
      Spacer()
      Button("取消", action: close).keyboardShortcut(.cancelAction)
      Button("另存为…", action: saveAs)
      Button(job.outputExists ? "覆盖并翻译" : "开始翻译", action: start)
        .buttonStyle(.borderedProminent)
        .keyboardShortcut(.defaultAction)
    }
  }

  @ViewBuilder
  private func translating(_ done: Int, _ total: Int) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      ProgressView(value: Double(done), total: Double(max(total, 1)))
      HStack {
        Text(total == 0 ? "准备中…" : "已完成 \(done) / \(total) 段")
        Spacer()
        if total > 0 { Text("\(done * 100 / total)%") }
      }
      .font(.system(size: 12))
      .foregroundStyle(.secondary)
      .monospacedDigit()
      Text("插件的翻译优先，文件排在后面").font(.system(size: 11)).foregroundStyle(.tertiary)
    }
    HStack {
      Spacer()
      Button("取消") { job.cancel() }.keyboardShortcut(.cancelAction)
    }
  }

  @ViewBuilder
  private func finished(_ failed: [FailedLine], _ empty: Bool) -> some View {
    HStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill").font(.system(size: 30)).foregroundStyle(.green)
      VStack(alignment: .leading, spacing: 3) {
        Text(empty ? "没有要翻译的文字" : "翻译完成").font(.system(size: 15, weight: .semibold))
        Text(empty ? "只有代码块、空字幕等，原样写出" : failed.isEmpty ? "译文已写好" : "\(failed.count) 段没翻成，保留了原文")
          .font(.system(size: 12))
          .foregroundStyle(failed.isEmpty ? Color.secondary : Color.orange)
      }
    }
    VStack(alignment: .leading, spacing: 4) {
      Text(job.output.lastPathComponent).font(.system(size: 13, weight: .medium))
      Text(job.output.deletingLastPathComponent().path).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
      if !failed.isEmpty {
        Divider().padding(.vertical, 4)
        ForEach(Array(failed.prefix(6).enumerated()), id: \.offset) { _, f in
          Text("第 \(f.line) 行：\(f.error)").font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
        }
        if failed.count > 6 { Text("……等 \(failed.count) 处").font(.system(size: 11)).foregroundStyle(.tertiary) }
      }
    }
    .textSelection(.enabled)
    .modifier(GroupFill())
    HStack(spacing: 10) {
      Spacer()
      Button("在访达中显示") { NSWorkspace.shared.activateFileViewerSelecting([job.output]) }
      Button("完成", action: close).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
    }
  }

  @ViewBuilder
  private func failure(_ error: FileTranslationError) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 26)).foregroundStyle(.red)
      VStack(alignment: .leading, spacing: 4) {
        Text("没翻成").font(.system(size: 15, weight: .semibold))
        Text(error.message).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
      }
    }
    HStack {
      Spacer()
      Button("完成", action: close).buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
    }
  }

  private func saveAs() {
    let panel = NSSavePanel()
    panel.directoryURL = job.output.deletingLastPathComponent()
    panel.nameFieldStringValue = job.output.lastPathComponent
    panel.canCreateDirectories = true
    guard panel.runModal() == .OK, let url = panel.url else { return }
    if url.standardizedFileURL == job.source.standardizedFileURL { return }  // 不能写到原文件本身
    job.output = url
    start()
  }
}
