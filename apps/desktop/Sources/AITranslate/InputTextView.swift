// 翻译窗口左边的输入框。SwiftUI 的 TextEditor 会把拖进来的文件当成路径文字插进去，这里自己包一个 NSTextView：
// 拖进文件就交给文件翻译，拖进文字照常插入。纯文本，不自动改引号、破折号，保证原文原样发给 aitd。
import AppKit
import SwiftUI

struct InputTextView: NSViewRepresentable {
  @Binding var text: String
  var onDropFile: (URL) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let textView = DropTextView(frame: .zero)
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
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    guard let textView = scroll.documentView as? DropTextView else { return }
    context.coordinator.parent = self
    textView.onDropFile = onDropFile
    if textView.string != text { textView.string = text }
  }

  final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: InputTextView

    init(_ parent: InputTextView) { self.parent = parent }

    func textDidChange(_ notification: Notification) {
      guard let textView = notification.object as? NSTextView else { return }
      parent.text = textView.string
    }
  }
}

final class DropTextView: NSTextView {
  var onDropFile: ((URL) -> Void)?

  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
    if let url = urls?.first {
      onDropFile?(url)
      return true
    }
    return super.performDragOperation(sender)
  }
}
