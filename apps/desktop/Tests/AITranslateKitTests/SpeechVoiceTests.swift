import AITranslateKit
import Testing

@Suite
struct SpeechVoiceTests {
  typealias V = SpeechVoice.Candidate

  @Test("简体中文：要普通话（zh-CN），不要粤语、台湾腔；高品质优先")
  func chinese() {
    let voices = [
      V(id: "hk", name: "Sinji", language: "zh-HK", quality: 2),
      V(id: "tw", name: "Meijia", language: "zh-TW", quality: 2),
      V(id: "cn", name: "Tingting", language: "zh-CN"),
      V(id: "cn-hq", name: "Lilian", language: "zh-CN", quality: 2),
      V(id: "en", name: "Samantha", language: "en-US", quality: 2),
    ]
    #expect(SpeechVoice.pick(voices, language: "zh")?.id == "cn-hq")
    #expect(SpeechVoice.pick(Array(voices.prefix(3)), language: "zh")?.id == "cn")
  }

  @Test("搞怪音效语音不用，带性格的语音排在普通语音后面；语言对不上返回 nil")
  func skipsNovelty() {
    let voices = [
      V(id: "zarvox", name: "Zarvox", language: "en-US"),
      V(id: "bells", name: "Bells", language: "en-US", novelty: true),
      V(id: "eddy", name: "Eddy (英语（美国）)", language: "en-US"),
      V(id: "nicky", name: "Nicky", language: "en-US"),
    ]
    #expect(SpeechVoice.pick(voices, language: "en")?.id == "nicky")
    #expect(SpeechVoice.pick(Array(voices.prefix(3)), language: "en")?.id == "eddy")
    #expect(SpeechVoice.pick(Array(voices.prefix(2)), language: "en") == nil)
    #expect(SpeechVoice.pick(voices, language: "ja") == nil)
  }

  @Test("认出原文语言：英文、中文、日文；空文字认不出")
  func detect() {
    #expect(SpeechVoice.language(of: "status code") == "en")
    #expect(SpeechVoice.language(of: "状态码") == "zh")
    #expect(SpeechVoice.language(of: "ステータスコードを確認してください") == "ja")
    #expect(SpeechVoice.language(of: "") == nil)
  }

  @Test("同语言同地区时按常用语音排：Ava 比 Alex 优先")
  func preferredNames() {
    let voices = [V(id: "alex", name: "Alex", language: "en-US"), V(id: "ava", name: "Ava", language: "en-US")]
    #expect(SpeechVoice.pick(voices, language: "en")?.id == "ava")
  }
}
