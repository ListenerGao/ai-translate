// 朗读原文时认语言、挑系统语音：只用 macOS 本机语音（AVSpeechSynthesizer，不联网），规则和插件的划词朗读一致（apps/extension/src/content/speech.ts）。
// 语言对得上才用；高品质（premium、enhanced）优先，再按各语言常用的自然语音排；搞怪音效语音不用，带性格的语音排后面。
import NaturalLanguage

public enum SpeechVoice {
  /** 认出文字是哪种语言（系统 NaturalLanguage，本机识别），只在翻译支持的几种语言里选；认不出返回 nil */
  public static func language(of text: String) -> String? {
    let recognizer = NLLanguageRecognizer()
    recognizer.languageConstraints = [.simplifiedChinese, .traditionalChinese, .english, .japanese, .korean, .french, .german, .spanish]
    recognizer.processString(text)
    guard let code = recognizer.dominantLanguage?.rawValue else { return nil }
    return code.hasPrefix("zh") ? "zh" : code
  }

  /** 一个可选的系统语音；quality：0 默认、1 增强、2 高品质 */
  public struct Candidate: Equatable, Sendable {
    public let id: String
    public let name: String
    /** 如 zh-CN、en-US */
    public let language: String
    public let quality: Int
    /** 系统标成搞怪音效的语音 */
    public let novelty: Bool

    public init(id: String, name: String, language: String, quality: Int = 0, novelty: Bool = false) {
      self.id = id
      self.name = name
      self.language = language
      self.quality = quality
      self.novelty = novelty
    }
  }

  // 各语言发音自然的系统语音，越靠前越优先。系统语言是中文时，中文语音的名字也是中文
  static let preferred: [String: [String]] = [
    "en": ["Ava", "Samantha", "Allison", "Susan", "Zoe", "Tom", "Alex", "Daniel", "Karen", "Moira", "Serena", "Tessa"],
    "zh": ["Tingting", "婷婷", "Yu-shu", "语舒", "Lilian", "Lili", "Meijia", "美嘉", "Sinji", "善怡"],
    "ja": ["Kyoko", "Otoya"],
    "ko": ["Yuna"],
    "fr": ["Amélie", "Thomas", "Audrey"],
    "de": ["Anna", "Petra", "Markus"],
    "es": ["Mónica", "Paulina", "Jorge"],
  ]
  /** 各语言优先的地区：简体中文要普通话（zh-CN），不要粤语、台湾腔 */
  static let region: [String: String] = ["zh": "CN", "en": "US", "es": "ES", "fr": "FR", "de": "DE", "ja": "JP", "ko": "KR"]
  static let noveltyNames: Set<String> = [
    "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ",
    "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Deranged", "Hysterical", "Pipe Organ",
  ]
  static let character: Set<String> = ["Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley", "Fred", "Junior", "Kathy", "Ralph"]

  /** 给 language（aitd 的语言代码，如 zh、en）挑语音；没有合适的返回 nil */
  public static func pick(_ voices: [Candidate], language: String) -> Candidate? {
    let want = language.lowercased().split(separator: "-").first.map(String.init) ?? ""
    let names = preferred[want] ?? []
    var best: Candidate?
    var bestScore = -Double.infinity
    for voice in voices {
      let parts = voice.language.replacingOccurrences(of: "_", with: "-").split(separator: "-").map(String.init)
      guard parts.first?.lowercased() == want else { continue }
      let base = voice.name.components(separatedBy: " (").first ?? voice.name
      if voice.novelty || noveltyNames.contains(base) { continue }
      var score = Double(voice.quality) * 10
      if let wanted = region[want], parts.count > 1, parts[1].uppercased() == wanted { score += 40 }
      if let rank = names.firstIndex(of: base) { score += 10 - Double(rank) * 0.1 }
      if character.contains(base) { score -= 5 }
      if score > bestScore {
        best = voice
        bestScore = score
      }
    }
    return best
  }
}
