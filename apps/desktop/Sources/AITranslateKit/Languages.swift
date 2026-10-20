// 翻译窗口和设置里可选的语言：和插件的设置页一致（apps/extension/src/shared/languages.ts）。code 是 aitd 认的语言代码。
public struct Language: Identifiable, Hashable, Sendable {
  public let code: String
  public let name: String
  public var id: String { code }
}

public enum Languages {
  public static let all: [Language] = [
    Language(code: "zh", name: "简体中文"),
    Language(code: "en", name: "英语"),
    Language(code: "ja", name: "日语"),
    Language(code: "ko", name: "韩语"),
    Language(code: "fr", name: "法语"),
    Language(code: "de", name: "德语"),
    Language(code: "es", name: "西班牙语"),
  ]

  /** 原文语言多一个「自动检测」 */
  public static let auto = Language(code: "auto", name: "自动检测")

  public static func name(_ code: String) -> String {
    code == auto.code ? auto.name : all.first { $0.code == code }?.name ?? code
  }
}
