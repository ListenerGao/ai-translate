// 翻译窗口左边的输入框。SwiftUI 的 TextEditor 会把拖进来的文件当成路径文字插进去，这里自己包一个 NSTextView：
// 拖进文件就交给文件翻译，拖进文字照常插入。纯文本，不自动改引号、破折号，保证原文原样发给 aitd。
// 用 TextKit 1 排版：同步滚动要按字符位置读出每段所在的行（ScrollSyncer）；译文里选中文字时，原文对应的段落画上底色（highlighted）。
import AITranslateKit
import AppKit
import SwiftUI

struct InputTextView: NSViewRepresentable {
  @Binding var text: String
  var onDropFile: (URL) -> Void
  var syncer: ScrollSyncer?
  /** 要画底色的段落（第几段） */
  var highlighted: Set<Int> = []
  /** 选中范围变了（只是光标时长度为 0） */
  var onSelect: (NSRange) -> Void = { _ in }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let textView = DropTextView(usingTextLayoutManager: false)
    textView.isRichText = false
    textView.allowsUndo = true
    textView.font = .systemFont(ofSize: 15)
    // 行距和右边译文一致
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = 4
    textView.defaultParagraphStyle = paragraph
    textView.typingAttributes = [.font: NSFont.systemFont(ofSize: 15), .paragraphStyle: paragraph, .foregroundColor: NSColor.textColor]
    textView.textContainerInset = NSSize(width: 10, height: 4)
    textView.isAutomaticQuoteSubstitutionEnabled = false
    textView.isAutomaticDashSubstitutionEnabled = false
    textView.isAutomaticTextReplacementEnabled = false
    textView.isAutomaticSpellingCorrectionEnabled = false
    textView.drawsBackground = false
    textView.isVerticallyResizable = true
    textView.isHorizontallyResizable = false
    textView.autoresizingMask = [.width]
    textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    textView.textContainer?.widthTracksTextView = true
    textView.delegate = context.coordinator
    textView.onDropFile = onDropFile
    textView.string = text

    let scroll = NSScrollView()
    scroll.hasVerticalScroller = true
    scroll.drawsBackground = false
    scroll.documentView = textView
    syncer?.attachSource(scroll)
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let textView = scroll.documentView as? DropTextView else { return }
    context.coordinator.parent = self
    textView.onDropFile = onDropFile
    if textView.string != text { textView.string = text }
    let ranges = highlighted.isEmpty ? [] : TranslateModel.paragraphRanges(text)
    textView.highlightRanges = highlighted.sorted().compactMap { ranges.indices.contains($0) ? ranges[$0] : nil }
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: InputTextView

    init(_ parent: InputTextView) { self.parent = parent }

    func textDidChange(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView else { return }
      parent.text = textView.string
    }

    func textViewDidChangeSelection(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView else { return }
      let selection = textView.selectedRange()
      let onSelect = parent.onSelect
      // 可能发生在 SwiftUI 更新界面的过程中（填入文字时），晚一拍再改状态
      DispatchQueue.main.async { onSelect(selection) }
    }
  }
}

final class DropTextView: NSTextView {
  var onDropFile: ((URL) -> Void)?
  var highlightRanges: [NSRange] = [] {
    didSet { if highlightRanges != oldValue { needsDisplay = true } }
  }

  /** 对应段落的底色：整段一块圆角底，左右和译文那边的底色对齐 */
  override func drawBackground(in rect: NSRect) {
    super.drawBackground(in: rect)
    guard !highlightRanges.isEmpty, let layout = layoutManager, let container = textContainer else { return }
    NSColor.paragraphHighlight.setFill()
    let padding = container.lineFragmentPadding
    for range in highlightRanges {
      let glyphs = layout.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
      let lines = layout.boundingRect(forGlyphRange: glyphs, in: container)
      let box = NSRect(x: textContainerOrigin.x + padding - 6, y: textContainerOrigin.y + lines.minY - 4, width: container.size.width - padding * 2 + 12, height: lines.height + 8)
      guard box.intersects(rect) else { continue }
      NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
    }
  }

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
    if let url = urls?.first {
      onDropFile?(url)
      return true
    }
    return super.performDragOperation(sender)
  }
}
