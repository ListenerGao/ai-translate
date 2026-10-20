// 菜单栏图标：和插件划词工具条同款的「中→A」翻译图标（主人 2026-10-20 选），模板图，跟随菜单栏深浅色。
// 启动中在图标右边加一个圆圈，有问题时加一个实心点（这时图标加宽 5pt，标记不压字）。
import AITranslateKit
import AppKit

enum StatusIcon {
  // 取自 Remix Icon 4.9.1 的 translate（https://remixicon.com，许可允许在软件里当界面图标用），24×24，只用到 M L H V C Z
  static let translatePath =
    "M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z"

  static func image(for badge: ServiceState.Badge) -> NSImage {
    // 有标记时图标往右加宽 5pt，标记画在「A」右边，不压字；「中→A」本身的位置和大小不变
    let size = NSSize(width: badge == .none ? 20 : 25, height: 18)
    let image = NSImage(size: size, flipped: false) { rect in
      let glyph = 17.0
      let path = bezierPath(translatePath)
      // SVG 的 y 轴朝下：翻过来，24 缩到 17，放在左边 20pt 宽的格子里居中
      var transform = AffineTransform(translationByX: (20 - glyph) / 2, byY: (rect.height + glyph) / 2)
      transform.scale(x: glyph / 24, y: -glyph / 24)
      path.transform(using: transform)
      NSColor.black.setFill()
      path.fill()

      guard badge != .none else { return true }
      let dot = NSRect(x: rect.maxX - 6, y: 1.5, width: 5.5, height: 5.5)
      if badge == .problem {
        NSBezierPath(ovalIn: dot).fill()
      } else {
        let ring = NSBezierPath(ovalIn: dot.insetBy(dx: 0.7, dy: 0.7))
        ring.lineWidth = 1.4
        NSColor.black.setStroke()
        ring.stroke()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "AI Translate"
    return image
  }

  /** 解析只含绝对坐标 M L H V C Z 的 SVG 路径 */
  static func bezierPath(_ d: String) -> NSBezierPath {
    let path = NSBezierPath()
    let scanner = Scanner(string: d)
    let commands = CharacterSet(charactersIn: "MLHVCZ")
    var command: Character = "M"
    var current = NSPoint.zero
    func number() -> CGFloat { CGFloat(scanner.scanDouble() ?? 0) }
    while !scanner.isAtEnd {
      if let c = scanner.scanCharacters(from: commands), let last = c.last {
        command = last
        if command == "Z" {
          path.close()
          continue
        }
      }
      switch command {
      case "M":
        current = NSPoint(x: number(), y: number())
        path.move(to: current)
        command = "L"  // M 后面接着的坐标按 L 处理
      case "L":
        current = NSPoint(x: number(), y: number())
        path.line(to: current)
      case "H":
        current.x = number()
        path.line(to: current)
      case "V":
        current.y = number()
        path.line(to: current)
      case "C":
        let c1 = NSPoint(x: number(), y: number())
        let c2 = NSPoint(x: number(), y: number())
        current = NSPoint(x: number(), y: number())
        path.curve(to: current, controlPoint1: c1, controlPoint2: c2)
      default:
        _ = scanner.scanCharacter()
      }
    }
    return path
  }
}
