// 界面共用的样式：品牌色、圆角卡片、卡片标题行、语言胶囊菜单、提示条、占位闪动。浅色、深色模式都用系统语义色。
import AITranslateKit
import SwiftUI

extension NSColor {
  static let paragraphHighlight = NSColor.brand.withAlphaComponent(0.14)
  static let brand = NSColor(srgbRed: 0x28 / 255, green: 0x52 / 255, blue: 0xC8 / 255, alpha: 1)
}

extension Color {
  /** 品牌色 #2852C8：和 App 图标、插件图标一致（主人 2026-10-20 定） */
  static let brand = Color(nsColor: .brand)
  /** 选中时对应段落的底色，原文、译文两边一样 */
  static let paragraphHighlight = Color(nsColor: .paragraphHighlight)
  /** 设置窗口：左边菜单的底色、右边内容的底色（浅色、深色各一套） */
  static let settingsSidebar = dynamic(light: 0xEDEDED, dark: 0x2B2B2B)
  static let settingsContent = dynamic(light: 0xF9F9F9, dark: 0x1F1F1F)

  static func dynamic(light: Int, dark: Int) -> Color {
    func rgb(_ v: Int) -> NSColor {
      NSColor(srgbRed: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
    return Color(nsColor: NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light) })
  }
}

/** 圆角卡片：文字区的白底（深色模式下是深灰），细边框、很淡的阴影 */
struct Card<Content: View>: View {
  var tint: Color? = nil
  @ViewBuilder var content: Content

  var body: some View {
    content
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(Color(nsColor: .textBackgroundColor))
          .overlay {
            if let tint { RoundedRectangle(cornerRadius: 12, style: .continuous).fill(tint.opacity(0.035)) }
          }
      }
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
      .shadow(color: .black.opacity(0.05), radius: 2, y: 1)
  }
}

/** 卡片顶部一行：左边小标题，右边放计数、按钮 */
struct CardHeader<Trailing: View>: View {
  let title: String
  @ViewBuilder var trailing: Trailing

  var body: some View {
    HStack(spacing: 10) {
      Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary)
      Spacer()
      trailing
    }
    .padding(.horizontal, 15)
    .frame(height: 38)
  }
}

/** 语言选择：胶囊形按钮，固定宽度（选什么语言长度都不变，主人 2026-10-20 要求），「语言名 + 箭头」整体居中、左右边距相等；点开是菜单，当前选中的打勾 */
struct LanguageMenu: View {
  /** 最长的名字（4 个汉字）加箭头，左右各留约 15pt */
  static let width: CGFloat = 100

  @Binding var selection: String
  var includeAuto = false

  var body: some View {
    Menu {
      if includeAuto {
        item(Languages.auto)
        Divider()
      }
      ForEach(Languages.all) { item($0) }
    } label: {
      LanguagePill(name: Languages.name(selection))
    }
    .menuStyle(.button)
    .buttonStyle(.plain)
    .fixedSize()
  }

  private func item(_ language: Language) -> some View {
    Button {
      selection = language.code
    } label: {
      if selection == language.code { Label(language.name, systemImage: "checkmark") } else { Text(language.name) }
    }
  }
}

/** 语言胶囊的样子：名字加向下箭头（翻译窗口的语言菜单和划词卡片共用） */
struct LanguagePill: View {
  let name: String

  var body: some View {
    HStack(spacing: 6) {
      Text(name).font(.system(size: 13, weight: .medium))
      Image(systemName: "chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
    }
    .padding(.vertical, 5)
    .frame(width: LanguageMenu.width)
    .background(Capsule().fill(Color.primary.opacity(0.06)))
    .contentShape(Capsule())
  }
}

/** 提示条：图标、标题、说明 */
struct Callout: View {
  let systemImage: String
  let color: Color
  let title: String
  var detail: String? = nil

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: systemImage).foregroundStyle(color).font(.system(size: 14, weight: .semibold))
      VStack(alignment: .leading, spacing: 3) {
        Text(title).font(.system(size: 13, weight: .semibold))
        if let detail {
          Text(detail).font(.system(size: 12)).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(color.opacity(0.09)))
  }
}

/** 分组框的底色：卡片里再分一块 */
struct GroupFill: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.primary.opacity(0.045)))
  }
}

/** 还没翻好的段落：灰色占位条，轻轻闪动 */
struct Pulse: ViewModifier {
  @State private var dim = false

  func body(content: Content) -> some View {
    content
      .opacity(dim ? 0.35 : 0.8)
      .onAppear {
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
      }
  }
}
