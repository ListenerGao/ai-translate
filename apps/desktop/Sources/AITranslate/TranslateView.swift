// 翻译窗口的内容：左右两张卡片 -- 左边原文（字数、清空、拖入文件和快捷键提示），右边译文（进度、复制）。语言选择在标题栏的工具栏里（LanguageBar）。
// 还没翻好的段落显示成灰色占位条，没翻成的显示原文和原因；有文件任务时盖上文件卡片。
import AITranslateKit
import AppKit
import SwiftUI

/** 标题栏工具栏里居中的语言选择：原文语言 ⇄ 目标语言。两边都选了具体语言时，中间的按钮能互换方向 */
struct LanguageBar: View {
  @Bindable var model: TranslateModel
  @State private var hover = false

  var body: some View {
    HStack(spacing: 8) {
      LanguageMenu(selection: $model.source, includeAuto: true)
      Button {
        model.swapLanguages()
      } label: {
        Image(systemName: "arrow.left.arrow.right")
          .font(.system(size: 11, weight: .semibold))
          .frame(width: 26, height: 26)
          .background(Circle().fill(Color.primary.opacity(hover && model.canSwap ? 0.08 : 0)))
          .contentShape(Circle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(model.canSwap ? Color.secondary : Color.secondary.opacity(0.4))
      .disabled(!model.canSwap)
      .onHover { hover = $0 }
      .help(model.canSwap ? "互换原文和目标语言" : "原文语言选成具体语言后，才能互换")
      LanguageMenu(selection: $model.target)
    }
    .fixedSize()
  }
}

/**
 左边的输入框单独成一个视图，只有它读 highlight.source：选中译文带出的原文高亮变化时只重画输入框，
 不连带重画整个翻译窗口和右边整列可选中的译文（2026-11-03 卡死：高亮变化 → 重画译文 → 选中变化 → 高亮变化，一直循环）
 */
private struct SourceEditor: View {
  @Bindable var model: TranslateModel
  let syncer: ScrollSyncer
  let highlight: ParagraphHighlight
  let openFile: (URL) -> Void

  var body: some View {
    InputTextView(text: $model.input, onDropFile: openFile, syncer: syncer, highlighted: highlight.source) { selection in
      highlight.sourceSelectionChanged(selection, text: model.input)
    }
  }
}

struct TranslateView: View {
  static let resultSpace = "result"

  @Bindable var model: TranslateModel
  let files: FileJobHolder
  /** 原文、译文同步滚动 */
  let syncer: ScrollSyncer
  /** 选中时高亮另一边对应的段落 */
  let highlight: ParagraphHighlight
  let openFile: (URL) -> Void
  let startFile: () -> Void
  let closeFile: () -> Void
  @State private var copied = false

  var body: some View {
    HStack(spacing: 12) {
      sourceCard
      resultCard
    }
    .padding(.horizontal, 14)
    .padding(.top, 4)
    .padding(.bottom, 14)
    .frame(minWidth: 720, minHeight: 440)
    .background(Color(nsColor: .windowBackgroundColor))
    .tint(.brand)
    .overlay {
      if let job = files.job {
        FileJobCard(job: job, targetName: Languages.name(model.target), start: startFile, close: closeFile)
      }
    }
    .onChange(of: model.source) { model.translateNow() }
    // 这里换目标语言只对这个窗口临时生效，不改设置里的默认值（主人 2026-11-09 定）
    .onChange(of: model.target) {
      model.translateNow()
      // 文件还没开始翻：输出文件名跟着目标语言变
      if let job = files.job, job.phase == .ready {
        job.output = FileTranslation.outputURL(for: job.source, target: model.target)
      }
    }
  }

  // MARK: 原文

  private var sourceCard: some View {
    Card {
      VStack(spacing: 0) {
        CardHeader(title: "原文") {
          if !model.input.isEmpty {
            Text("\(model.input.count) 字").font(.system(size: 11)).foregroundStyle(.tertiary).monospacedDigit()
            Button {
              model.input = ""
            } label: {
              Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
            }
            .buttonStyle(.plain)
            .help("清空")
          }
        }
        SourceEditor(model: model, syncer: syncer, highlight: highlight, openFile: openFile)
          .overlay(alignment: .topLeading) {
            if model.input.isEmpty {
              Text("粘贴或输入要翻译的文字，空行分段")
                .font(.system(size: 15))
                .foregroundStyle(.tertiary)
                .padding(.leading, 15)
                .padding(.top, 4)
                .allowsHitTesting(false)
            }
          }
          .onChange(of: model.input) {
            model.inputChanged()
            highlight.clear()
          }
        footer
      }
    }
  }

  private var footer: some View {
    HStack(spacing: 6) {
      Image(systemName: "doc.badge.plus")
      Text("拖入 .md、.srt 文件可整份翻译")
      Spacer()
      Button {
        model.translateNow()
      } label: {
        HStack(spacing: 4) {
          Text("翻译")
          Text("⌘↩").foregroundStyle(.tertiary)
        }
      }
      .buttonStyle(.plain)
      .keyboardShortcut(.return, modifiers: .command)
      .help("立即翻译")
    }
    .font(.system(size: 11))
    .foregroundStyle(.secondary)
    .padding(.horizontal, 15)
    .frame(height: 34)
  }

  // MARK: 译文

  private var resultCard: some View {
    Card(tint: .brand) {
      VStack(spacing: 0) {
        CardHeader(title: "译文") {
          status
          Button(action: copy) {
            Image(systemName: copied ? "checkmark" : "square.on.square")
              .foregroundStyle(copied ? Color.green : Color.secondary)
              .frame(width: 18)
          }
          .buttonStyle(.plain)
          .disabled(model.rows.isEmpty)
          .help("复制全部译文")
        }
        resultBody
      }
      .dropDestination(for: URL.self) { urls, _ in
        guard let url = urls.first else { return false }
        openFile(url)
        return true
      }
    }
  }

  @ViewBuilder
  private var status: some View {
    let (done, total) = model.progress
    if model.isTranslating {
      HStack(spacing: 6) {
        ProgressView().controlSize(.mini)
        Text("\(done)/\(total)").font(.system(size: 11)).foregroundStyle(.secondary).monospacedDigit()
      }
    } else if total > 0 {
      Text("\(total) 段").font(.system(size: 11)).foregroundStyle(.tertiary).monospacedDigit()
    }
  }

  @ViewBuilder
  private var resultBody: some View {
    VStack(spacing: 10) {
      if let problem = model.problem {
        Callout(systemImage: "exclamationmark.triangle.fill", color: .red, title: problem.title, detail: problem.detail)
      }
      if let notice = model.notice {
        Callout(systemImage: "info.circle.fill", color: .orange, title: notice)
      }
    }
    .padding(.horizontal, 12)
    .padding(.bottom, model.problem == nil && model.notice == nil ? 0 : 6)

    if model.rows.isEmpty && model.problem == nil {
      VStack(spacing: 8) {
        Image(systemName: "character.bubble").font(.system(size: 30, weight: .light))
        Text("译文会显示在这里").font(.system(size: 13))
      }
      .foregroundStyle(.quaternary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      // 内容不满一屏时也撑满可见区域：空白处落在下面的 FinderView 上，按下去不会拖动窗口（窗口开了背景可拖），方便从空白处开始拖选
      GeometryReader { viewport in
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          ForEach(model.rows) { row in
            rowView(row)
              // 原文里选中的文字在这段：加底色，和原文那边的底色一样
              .background {
                if highlight.target.contains(row.id) {
                  RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.paragraphHighlight).padding(.horizontal, -6).padding(.vertical, -4)
                }
              }
              // 报出每段顶部的位置，同步滚动按段落对齐、选中高亮找段落用
              .background(GeometryReader { g in
                Color.clear.preference(key: RowTopsKey.self, value: [row.id: g.frame(in: .named(Self.resultSpace)).minY])
              })
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 15)
        .padding(.top, 4)
        .padding(.bottom, 15)
        .textSelection(.enabled)
        .coordinateSpace(.named(Self.resultSpace))
        .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .topLeading)
        .background(ScrollViewFinder { syncer.attachTarget($0) })
      }
      .onPreferenceChange(RowTopsKey.self) { tops in
        let ordered = tops.sorted { $0.key < $1.key }.map(\.value)
        MainActor.assumeIsolated { syncer.targetTops = ordered }
      }
      }
    }
  }

  @ViewBuilder
  private func rowView(_ row: TranslateModel.Row) -> some View {
    switch row.state {
    case .pending:
      // 不用 Pulse 那种无限循环动画：几百段一起 pending 时等于几百个动画每帧都在重画，
      // 配上下面整列「可选中的文字」，翻译一开始就把主线程占满（2026-10-27 卡死）。进度看标题栏的段数。
      Text(row.source).font(.system(size: 15)).lineSpacing(4).redacted(reason: .placeholder).opacity(0.45)
    case let .done(text):
      Text(text).font(.system(size: 15)).lineSpacing(4)
    case let .failed(reason):
      VStack(alignment: .leading, spacing: 5) {
        Text(row.source).font(.system(size: 15)).lineSpacing(4).foregroundStyle(.secondary)
        Label("未翻译，已保留原文。\(reason)", systemImage: "exclamationmark.triangle.fill")
          .font(.system(size: 11))
          .foregroundStyle(.orange)
      }
    }
  }

  private func copy() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(model.output, forType: .string)
    copied = true
    Task {
      try? await Task.sleep(for: .seconds(1.5))
      copied = false
    }
  }
}
