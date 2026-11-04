// 朗读划词卡片的原文：只用 macOS 本机语音（AVSpeechSynthesizer，文字不出本机），语音按 SpeechVoice.pick 挑。
import AITranslateKit
import AVFoundation

@MainActor
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  /** 开始、读完或停下时通知（true 表示正在读） */
  var changed: ((Bool) -> Void)?

  override init() {
    super.init()
    synthesizer.delegate = self
  }

  var isSpeaking: Bool { synthesizer.isSpeaking }

  /** 这个语言有没有能用的本机语音（界面每次重画都会问，记下结果） */
  static func canSpeak(_ language: String) -> Bool {
    if let known = available[language] { return known }
    let result = voice(for: language) != nil
    available[language] = result
    return result
  }

  private static var available: [String: Bool] = [:]

  /** 原文是哪种语言（界面每次重画都会问，记下上一次的结果） */
  static func language(of text: String) -> String? {
    if text == lastText { return lastLanguage }
    lastText = text
    lastLanguage = SpeechVoice.language(of: text)
    return lastLanguage
  }

  private static var lastText: String?
  private static var lastLanguage: String?

  /** 读 text；没有合适的语音返回 false */
  @discardableResult
  func speak(_ text: String, language: String) -> Bool {
    stop()
    guard let voice = Self.voice(for: language) else { return false }
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    synthesizer.speak(utterance)
    changed?(true)
    return true
  }

  func stop() {
    guard synthesizer.isSpeaking else { return }
    synthesizer.stopSpeaking(at: .immediate)
  }

  private static func voice(for language: String) -> AVSpeechSynthesisVoice? {
    let voices = AVSpeechSynthesisVoice.speechVoices()
    let candidates = voices.map { voice in
      SpeechVoice.Candidate(
        id: voice.identifier,
        name: voice.name,
        language: voice.language,
        quality: voice.quality == .premium ? 2 : voice.quality == .enhanced ? 1 : 0,
        novelty: voice.voiceTraits.contains(.isNoveltyVoice)
      )
    }
    guard let picked = SpeechVoice.pick(candidates, language: language) else { return nil }
    return voices.first { $0.identifier == picked.id }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finished() }
  }

  nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    Task { @MainActor in self.finished() }
  }

  private func finished() {
    // 停下后马上又开始读下一段时不报「停了」
    if !synthesizer.isSpeaking { changed?(false) }
  }
}
