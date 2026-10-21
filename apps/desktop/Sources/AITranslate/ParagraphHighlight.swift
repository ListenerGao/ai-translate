// 翻译窗口选中时高亮对应段落（主人 2026-10-21 要求，只在选中时，不跟鼠标悬停）：
// 在原文里选中文字，译文里对应的段落（跨段时多段）加浅品牌色底；在译文某段里选中文字，原文对应的那段加底色。只是底色，不改文字。
// 原文的选中从输入框的代理拿；译文每段是 SwiftUI 的可选文字（底层是 NSTextField），选中时系统的字段编辑器会发出选中变化通知，
// 只认属于译文区的那个文字框，按它的位置找到第几段。
import AITranslateKit
import AppKit
import Observation

@MainActor
@Observable
final class ParagraphHighlight {
  /** 原文里要高亮的段（由译文的选中带出） */
  private(set) var source: Set<Int> = []
  /** 译文里要高亮的段（由原文的选中带出） */
  private(set) var target: Set<Int> = []

  @ObservationIgnored private let syncer: ScrollSyncer
  @ObservationIgnored private var token: NSObjectProtocol?

  init(syncer: ScrollSyncer) {
    self.syncer = syncer
    token = NotificationCenter.default.addObserver(forName: NSTextView.didChangeSelectionNotification, object: nil, queue: nil) { [weak self] note in
      // 选中变化总是在主线程上发出
      nonisolated(unsafe) let editor = note.object as? NSTextView
      MainActor.assumeIsolated {
        if let editor, editor.isFieldEditor { self?.targetSelectionChanged(editor) }
      }
    }
  }

  /** 原文的选中变了 */
  func sourceSelectionChanged(_ selection: NSRange, text: String) {
    update(source: [], target: TranslateModel.paragraphs(touching: selection, in: TranslateModel.paragraphRanges(text)))
  }

  /** 内容变了（重新输入、关窗口清空）：去掉高亮 */
  func clear() {
    update(source: [], target: [])
  }

  private func targetSelectionChanged(_ editor: NSTextView) {
    guard let field = editor.delegate as? NSTextField, let row = syncer.targetRow(containing: field) else { return }
    update(source: editor.selectedRange().length > 0 ? [row] : [], target: [])
  }

  private func update(source: Set<Int>, target: Set<Int>) {
    if self.source != source { self.source = source }
    if self.target != target { self.target = target }
  }
}
