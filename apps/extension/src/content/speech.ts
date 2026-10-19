// 划词朗读：用浏览器自带的 speechSynthesis 读选中的原文。
// 只用本机语音（localService 为 true，macOS 系统语音），不用 Chrome 的联网语音，文字不出本机（AGENTS 红线）。

export interface VoiceInfo {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

// 各语言发音自然的系统语音，越靠前越优先。系统语言是中文时，中文语音的名字也是中文
const PREFERRED: Record<string, readonly string[]> = {
  en: ["Ava", "Samantha", "Allison", "Susan", "Zoe", "Tom", "Alex", "Daniel", "Karen", "Moira", "Serena", "Tessa"],
  zh: ["Tingting", "婷婷", "Yu-shu", "语舒", "Lilian", "Lili", "Meijia", "美嘉", "Sinji", "善怡"],
  ja: ["Kyoko", "Otoya"],
  ko: ["Yuna"],
  fr: ["Amélie", "Thomas", "Audrey"],
  de: ["Anna", "Petra", "Markus"],
  es: ["Mónica", "Paulina", "Jorge"],
};

// macOS 的搞怪音效语音，读出来不像正常说话，不用
const NOVELTY = new Set([
  "Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ",
  "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Deranged", "Hysterical", "Pipe Organ",
]);
// 带性格的语音（Eddy、Grandma 等）能用，但排在普通语音后面
const CHARACTER = new Set(["Eddy", "Flo", "Grandma", "Grandpa", "Reed", "Rocko", "Sandy", "Shelley", "Fred", "Junior", "Kathy", "Ralph"]);

/** 从语音列表里挑一个：只要本机语音、语言对得上；优先高品质、常用的自然语音；没有合适的返回 null */
export function pickVoice<T extends VoiceInfo>(voices: readonly T[], lang: string): T | null {
  const want = lang.toLowerCase().split("-")[0] ?? "";
  const preferred = PREFERRED[want] ?? [];
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const v of voices) {
    if (!v.localService || v.lang.toLowerCase().replace("_", "-").split("-")[0] !== want) continue;
    const base = v.name.split(" (")[0] ?? v.name;
    if (NOVELTY.has(base)) continue;
    let score = 0;
    if (/premium/i.test(v.name)) score += 30;
    else if (/enhanced/i.test(v.name)) score += 20;
    const rank = preferred.indexOf(base);
    if (rank >= 0) score += 10 - rank * 0.1;
    if (CHARACTER.has(base)) score -= 5;
    if (v.default) score += 1;
    if (score > bestScore) [best, bestScore] = [v, score];
  }
  return best;
}

/** 语音列表可能是异步加载的，第一次取不到就等 voiceschanged，最多 1 秒 */
function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    window.setTimeout(done, 1000);
  });
}

export class Speaker {
  #current: SpeechSynthesisUtterance | null = null;

  get speaking(): boolean {
    return this.#current !== null;
  }

  /** 朗读文字。返回用的语音名；没有合适的本机语音时不读，返回 null */
  async speak(text: string, lang: string, onEnd: () => void): Promise<string | null> {
    this.stop();
    const voice = pickVoice(await loadVoices(), lang);
    if (voice === null) return null;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    const finish = () => {
      if (this.#current !== utterance) return;
      this.#current = null;
      onEnd();
    };
    utterance.addEventListener("end", finish);
    utterance.addEventListener("error", finish);
    this.#current = utterance;
    speechSynthesis.speak(utterance);
    return voice.name;
  }

  stop(): void {
    if (this.#current === null) return;
    this.#current = null;
    speechSynthesis.cancel();
  }
}
